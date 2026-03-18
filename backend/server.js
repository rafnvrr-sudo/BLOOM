import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const MIN_SAFETY = parseInt(process.env.MIN_SAFETY_ALERT || "60");
const MIN_POTENTIAL = parseInt(process.env.MIN_POTENTIAL_ALERT || "50");
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || "30000");

// ─── IN-MEMORY STORE ───
let tokenStore = [];
let alertLog = [];
let graduationLog = [];
let lastScan = null;
let scanCount = 0;

// ─── SERVICE HEALTH TRACKING ───
const serviceHealth = {
  dexscreener: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, pairsReturned: 0 },
  rugcheck: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  jupiter: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  discord: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, alertsSent: 0 },
};

function updateServiceHealth(service, success, latencyMs, extra = {}) {
  const s = serviceHealth[service];
  if (!s) return;
  s.latency = latencyMs;
  if (success) {
    s.status = "ok";
    s.lastSuccess = Date.now();
    s.errorCount = 0;
    Object.assign(s, extra);
  } else {
    s.errorCount++;
    s.lastError = Date.now();
    s.status = s.errorCount >= 3 ? "down" : "degraded";
    Object.assign(s, extra);
  }
}

// ─── DISCORD DEDUP ───
const discordAlerted = new Map();
const DISCORD_COOLDOWN_MS = parseInt(process.env.DISCORD_COOLDOWN_MIN || "15") * 60 * 1000;

function shouldAlertDiscord(address) {
  const last = discordAlerted.get(address);
  if (last && Date.now() - last < DISCORD_COOLDOWN_MS) return false;
  discordAlerted.set(address, Date.now());
  // Clean old entries every 100 tokens
  if (discordAlerted.size > 500) {
    const cutoff = Date.now() - DISCORD_COOLDOWN_MS;
    for (const [k, v] of discordAlerted) { if (v < cutoff) discordAlerted.delete(k); }
  }
  return true;
}
function calcSafety(token) {
  let score = 0;
  let penalties = 0;
  const checks = {};

  // Liquidity (0-20 pts)
  checks.liquidity = { pass: token.liquidity >= 5000, value: "$" + formatNum(token.liquidity) };
  if (token.liquidity >= 100000) score += 20;
  else if (token.liquidity >= 50000) score += 16;
  else if (token.liquidity >= 20000) score += 12;
  else if (token.liquidity >= 5000) score += 8;
  else if (token.liquidity >= 1000) score += 3;

  // Volume health - vol/liq ratio (0-12 pts, PENALTY if > 50x)
  const volLiqRatio = token.volume_24h / Math.max(token.liquidity, 1);
  const volLiqOk = volLiqRatio > 0.5 && volLiqRatio < 50;
  checks.vol_liq_ratio = { pass: volLiqOk, value: volLiqRatio.toFixed(1) + "x" };
  if (volLiqOk) score += 12;
  else if (volLiqRatio > 0.2 && volLiqRatio <= 50) score += 6;
  // PENALTY: extreme vol/liq = wash trading or dump
  if (volLiqRatio > 100) { penalties += 20; checks.vol_liq_ratio.value += " EXTREME"; }
  else if (volLiqRatio > 50) { penalties += 12; }

  // Age (0-12 pts)
  const ageH = token.age_hours;
  checks.age = { pass: ageH > 2, value: ageH.toFixed(1) + "h" };
  if (ageH > 48) score += 12;
  else if (ageH > 12) score += 10;
  else if (ageH > 6) score += 8;
  else if (ageH > 2) score += 5;
  else if (ageH > 0.5) score += 2;

  // Buy/sell ratio 24h (0-12 pts)
  if (token.buys + token.sells > 10) {
    const ratio24 = token.buys / (token.buys + token.sells);
    checks.buy_ratio_24h = { pass: ratio24 > 0.45, value: (ratio24 * 100).toFixed(0) + "%" };
    if (ratio24 > 0.65) score += 12;
    else if (ratio24 > 0.55) score += 9;
    else if (ratio24 > 0.45) score += 6;
    else score += 2;
  } else {
    checks.buy_ratio_24h = { pass: false, value: "low txns" };
  }

  // Buy/sell ratio 1h (0-8 pts)
  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    checks.buy_ratio_1h = { pass: ratio1h > 0.45, value: (ratio1h * 100).toFixed(0) + "%" };
    if (ratio1h > 0.6) score += 8;
    else if (ratio1h > 0.45) score += 5;
    // PENALTY: heavy recent selling
    if (ratio1h < 0.3 && token.buys_1h + token.sells_1h > 20) penalties += 8;
  } else {
    checks.buy_ratio_1h = { pass: false, value: "low txns" };
  }

  // Market cap sanity (0-8 pts)
  checks.market_cap = { pass: token.market_cap >= 10000, value: "$" + formatNum(token.market_cap) };
  if (token.market_cap >= 100000) score += 8;
  else if (token.market_cap >= 50000) score += 6;
  else if (token.market_cap >= 10000) score += 4;

  // POST-PUMP DETECTION: 24h change strongly negative = already dumped
  if (token.change_24h < -50) {
    checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% dump" };
    penalties += 15;
  } else if (token.change_24h < -30) {
    checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% decline" };
    penalties += 8;
  }

  // 1h dump detection
  if (token.change_1h < -30) {
    checks.dumping_1h = { pass: false, value: token.change_1h.toFixed(0) + "% 1h" };
    penalties += 10;
  }

  // rugcheck data (0-28 pts when available, 10 pts base when not)
  if (token.rugcheck) {
    const rc = token.rugcheck;
    const mintOk = !rc.mintEnabled;
    const freezeOk = !rc.freezeEnabled;
    const lpOk = rc.lpBurned || rc.lpLocked;

    checks.mint = { pass: mintOk, value: rc.mintEnabled ? "ENABLED" : "disabled" };
    checks.freeze = { pass: freezeOk, value: rc.freezeEnabled ? "ENABLED" : "disabled" };
    checks.lp_lock = { pass: lpOk, value: rc.lpBurned ? "burned" : rc.lpLocked ? "locked" : "UNLOCKED" };

    if (mintOk) score += 10;
    if (freezeOk) score += 8;
    if (lpOk) score += 10;
    // PENALTY: LP unlocked is a major red flag
    if (!lpOk) penalties += 10;
    // PENALTY: mint enabled = dev can print tokens
    if (!mintOk) penalties += 8;
  } else {
    checks.contract = { pass: false, value: "pending scan" };
    score += 10;
  }

  // Jupiter slippage check (0 pts bonus, PENALTY if bad)
  if (token.jupiter && !token.jupiter.error) {
    // Buy slippage
    if (token.buy_slippage !== null && token.buy_slippage !== undefined) {
      const bsOk = token.buy_slippage < 5;
      checks.buy_slippage = { pass: bsOk, value: token.buy_slippage.toFixed(1) + "%" };
      if (token.buy_slippage > 15) penalties += 10;
      else if (token.buy_slippage > 10) penalties += 5;
    }

    // Sell slippage
    if (token.sell_slippage !== null && token.sell_slippage !== undefined) {
      const ssOk = token.sell_slippage < 8;
      checks.sell_slippage = { pass: ssOk, value: token.sell_slippage.toFixed(1) + "%" };
      if (token.sell_slippage > 20) penalties += 12;
      else if (token.sell_slippage > 10) penalties += 6;
    }

    // Sell tax (the big one)
    if (token.sell_tax !== null && token.sell_tax !== undefined) {
      const taxOk = token.sell_tax < 5;
      checks.sell_tax = { pass: taxOk, value: token.sell_tax.toFixed(1) + "%" };
      if (token.sell_tax > 30) penalties += 30;       // almost certainly a honeypot
      else if (token.sell_tax > 15) penalties += 20;   // heavy hidden tax
      else if (token.sell_tax > 5) penalties += 10;    // suspicious tax
    }

    // Honeypot detection
    if (token.honeypot_detected) {
      checks.honeypot = { pass: false, value: "HONEYPOT" };
      penalties += 40; // nuke the score
    }
  }

  const finalScore = Math.max(Math.min(score - penalties, 100), 0);
  return { score: finalScore, checks };
}

// ─── POTENTIAL SCORING ───
function calcPotential(token) {
  let score = 0;

  // Vol/MCap ratio (0-20 pts)
  const vmRatio = token.volume_24h / Math.max(token.market_cap, 1);
  if (vmRatio > 5) score += 20;
  else if (vmRatio > 2) score += 16;
  else if (vmRatio > 1) score += 12;
  else if (vmRatio > 0.5) score += 6;

  // Buy pressure 24h (0-15 pts)
  if (token.buys + token.sells > 10) {
    const buyRatio = token.buys / Math.max(token.buys + token.sells, 1);
    if (buyRatio > 0.75) score += 15;
    else if (buyRatio > 0.65) score += 12;
    else if (buyRatio > 0.55) score += 8;
    else score += 3;
  }

  // Buy pressure 1h (0-15 pts)
  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    if (ratio1h > 0.75) score += 15;
    else if (ratio1h > 0.6) score += 10;
    else if (ratio1h > 0.5) score += 5;
  }

  // MCap room (0-15 pts)
  if (token.market_cap < 50000) score += 15;
  else if (token.market_cap < 200000) score += 12;
  else if (token.market_cap < 500000) score += 8;
  else if (token.market_cap < 1000000) score += 4;

  // 1h price momentum (0-15 pts)
  if (token.change_1h > 100 && token.change_1h < 1000) score += 15;
  else if (token.change_1h > 30) score += 12;
  else if (token.change_1h > 10) score += 8;
  else if (token.change_1h > 0) score += 3;

  // 5m momentum (0-10 pts)
  if (token.change_5m > 20 && token.change_5m < 200) score += 10;
  else if (token.change_5m > 5) score += 6;

  // Liq/MCap ratio (0-10 pts)
  const liqMcapRatio = token.liquidity / Math.max(token.market_cap, 1);
  if (liqMcapRatio > 0.1 && liqMcapRatio < 0.5) score += 10;
  else if (liqMcapRatio > 0.05) score += 5;

  // PENALTIES
  // Post-pump dump: token already crashed
  if (token.change_24h < -50) score = Math.max(score - 30, 0);
  else if (token.change_24h < -30) score = Math.max(score - 15, 0);

  // Active dump right now
  if (token.change_1h < -20) score = Math.max(score - 20, 0);

  // Vol/liq extreme = wash trading
  const volLiq = token.volume_24h / Math.max(token.liquidity, 1);
  if (volLiq > 100) score = Math.max(score - 15, 0);

  // Staircase
  if (token.staircase_detected) score = Math.max(score - 30, 0);

  // LP not locked with rugcheck data
  if (token.rugcheck && !token.rugcheck.lpBurned && !token.rugcheck.lpLocked) {
    score = Math.max(score - 10, 0);
  }

  // Sell tax kills potential completely
  if (token.sell_tax > 15) score = Math.max(score - 40, 0);
  else if (token.sell_tax > 5) score = Math.max(score - 15, 0);

  // Honeypot = zero potential
  if (token.honeypot_detected) score = 0;

  return Math.min(Math.round(score), 100);
}

// ─── STAIRCASE DETECTION ───
function detectStaircase(priceHistory) {
  if (!priceHistory || priceHistory.length < 8) return { detected: false, confidence: 0 };

  let flat = 0, jump = 0, total = 0;
  for (let i = 1; i < priceHistory.length; i++) {
    const change = Math.abs(priceHistory[i] - priceHistory[i - 1]) / Math.max(priceHistory[i - 1], 0.001);
    if (change < 0.02) flat++;
    else if (change > 0.3) jump++;
    total++;
  }

  let pullbacks = 0;
  for (let i = 2; i < priceHistory.length; i++) {
    if (priceHistory[i] < priceHistory[i - 1] && priceHistory[i - 1] < priceHistory[i - 2]) pullbacks++;
  }

  const flatRatio = flat / total;
  const jumpRatio = jump / total;
  const pullbackRatio = pullbacks / (priceHistory.length - 2);

  const detected = flatRatio > 0.35 && jumpRatio > 0.15 && pullbackRatio < 0.08;
  const confidence = detected
    ? Math.min(Math.round(flatRatio * 40 + jumpRatio * 40 + (1 - pullbackRatio) * 20), 99)
    : Math.round(Math.max(0, flatRatio * 30 + jumpRatio * 20 - pullbackRatio * 50));

  return { detected, confidence };
}

// ─── DEX SCREENER FETCH ───
async function fetchNewPairs() {
  const allPairs = [];
  const startTime = Date.now();
  let fetchErrors = 0;

  const queries = [
    "https://api.dexscreener.com/latest/dex/search?q=pump",
    "https://api.dexscreener.com/latest/dex/search?q=SOL%20new",
    "https://api.dexscreener.com/latest/dex/search?q=raydium%20solana",
  ];

  for (const url of queries) {
    try {
      const t0 = Date.now();
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
        allPairs.push(...pairs);
      } else {
        fetchErrors++;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      fetchErrors++;
      console.error("DEX Screener fetch error:", err.message);
    }
  }

  try {
    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (boostRes.ok) {
      const boosts = await boostRes.json();
      const solBoosts = (boosts || []).filter(b => b.chainId === "solana").slice(0, 5);
      for (const boost of solBoosts) {
        try {
          const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${boost.tokenAddress}`);
          if (pairRes.ok) {
            const pairData = await pairRes.json();
            const pairs = (pairData.pairs || []).filter(p => p.chainId === "solana");
            allPairs.push(...pairs);
          }
          await new Promise(r => setTimeout(r, 200));
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) {
    fetchErrors++;
    console.error("Boosts fetch error:", e.message);
  }

  const seen = new Set();
  const unique = [];
  for (const pair of allPairs) {
    const key = pair.pairAddress || pair.baseToken?.address;
    if (key && !seen.has(key)) { seen.add(key); unique.push(pair); }
  }

  unique.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));

  // Track health
  const latency = Date.now() - startTime;
  updateServiceHealth("dexscreener", unique.length > 0, latency, { pairsReturned: unique.length });

  console.log(`Fetched ${unique.length} unique Solana pairs (${latency}ms, ${fetchErrors} errors)`);
  return unique;
}

// ─── RUGCHECK FETCH ───
async function fetchRugcheck(mintAddress) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`);
    const latency = Date.now() - t0;
    if (!res.ok) {
      updateServiceHealth("rugcheck", false, latency);
      return null;
    }
    const data = await res.json();
    serviceHealth.rugcheck.checksCompleted++;
    updateServiceHealth("rugcheck", true, latency);
    return {
      mintEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("mint")) || false,
      freezeEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("freeze")) || false,
      lpBurned: data.risks?.some(r => r.name?.toLowerCase().includes("burn") && r.level === "good") || false,
      lpLocked: data.risks?.some(r => r.name?.toLowerCase().includes("lock") && r.level === "good") || false,
      score: data.score || 0,
      risks: data.risks || [],
    };
  } catch (err) {
    updateServiceHealth("rugcheck", false, Date.now() - t0);
    console.error("rugcheck error:", err.message);
    return null;
  }
}

// ─── PRICE HISTORY (from DEX Screener pair data) ───
function extractPriceChanges(pair) {
  const changes = [];
  if (pair.priceChange) {
    changes.push(pair.priceChange.m5 || 0);
    changes.push(pair.priceChange.h1 || 0);
    changes.push(pair.priceChange.h6 || 0);
    changes.push(pair.priceChange.h24 || 0);
  }
  return changes;
}

// ─── JUPITER SLIPPAGE & SELL TAX CHECKER ───
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE = "https://api.jup.ag/swap/v1/quote";
const SIMULATE_AMOUNT_SOL = 100000000; // 0.1 SOL in lamports

async function checkSlippageAndTax(tokenMint) {
  const result = { buySlippage: null, sellSlippage: null, sellTax: null, honeypot: false, error: null };

  try {
    // STEP 1: Simulate BUY (SOL -> Token)
    const buyUrl = `${JUPITER_QUOTE}?inputMint=${SOL_MINT}&outputMint=${tokenMint}&amount=${SIMULATE_AMOUNT_SOL}&slippageBps=5000`;
    const buyRes = await fetch(buyUrl);

    if (!buyRes.ok) {
      const errText = await buyRes.text().catch(() => "");
      result.error = `buy_quote_${buyRes.status}`;
      console.log(`  Jupiter buy quote failed for ${tokenMint.slice(0,8)}: ${buyRes.status} ${errText.slice(0,100)}`);
      updateServiceHealth("jupiter", false, 0);
      return result;
    }

    const buyData = await buyRes.json();

    if (!buyData.outAmount || buyData.outAmount === "0") {
      result.honeypot = true;
      result.error = "no_buy_output";
      updateServiceHealth("jupiter", true, 0);
      return result;
    }

    const buyPriceImpact = parseFloat(buyData.priceImpactPct || 0);
    result.buySlippage = Math.abs(buyPriceImpact);
    const tokensReceived = buyData.outAmount;

    await new Promise(r => setTimeout(r, 400));

    // STEP 2: Simulate SELL (Token -> SOL)
    const sellUrl = `${JUPITER_QUOTE}?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${tokensReceived}&slippageBps=5000`;
    const sellRes = await fetch(sellUrl);

    if (!sellRes.ok) {
      result.honeypot = true;
      result.error = "sell_quote_failed";
      result.sellTax = 100;
      updateServiceHealth("jupiter", true, 0);
      return result;
    }

    const sellData = await sellRes.json();

    if (!sellData.outAmount || sellData.outAmount === "0") {
      result.honeypot = true;
      result.sellTax = 100;
      updateServiceHealth("jupiter", true, 0);
      return result;
    }

    const sellPriceImpact = parseFloat(sellData.priceImpactPct || 0);
    result.sellSlippage = Math.abs(sellPriceImpact);

    const solBack = parseInt(sellData.outAmount);
    const totalLoss = ((SIMULATE_AMOUNT_SOL - solBack) / SIMULATE_AMOUNT_SOL) * 100;
    const estimatedNormalSlippage = result.buySlippage + result.sellSlippage;
    const taxEstimate = Math.max(0, totalLoss - estimatedNormalSlippage - 2);

    result.sellTax = Math.round(taxEstimate * 10) / 10;

    if (result.sellTax > 30) {
      result.honeypot = true;
    }

    updateServiceHealth("jupiter", true, 0);

  } catch (err) {
    result.error = err.message;
    updateServiceHealth("jupiter", false, 0);
  }

  return result;
}

// ─── PROCESS RAW PAIR INTO TOKEN ───
function processPair(pair) {
  const baseToken = pair.baseToken || {};
  const now = Date.now();
  const createdAt = pair.pairCreatedAt || now;
  const ageHours = (now - createdAt) / (1000 * 60 * 60);

  return {
    id: pair.pairAddress || baseToken.address,
    address: baseToken.address || "",
    name: baseToken.name || "Unknown",
    symbol: baseToken.symbol || "???",
    pair_address: pair.pairAddress || "",
    dex: pair.dexId || "",
    price: parseFloat(pair.priceUsd || 0),
    market_cap: pair.marketCap || pair.fdv || 0,
    volume_24h: pair.volume?.h24 || 0,
    volume_6h: pair.volume?.h6 || 0,
    volume_1h: pair.volume?.h1 || 0,
    liquidity: pair.liquidity?.usd || 0,
    change_24h: pair.priceChange?.h24 || 0,
    change_6h: pair.priceChange?.h6 || 0,
    change_1h: pair.priceChange?.h1 || 0,
    change_5m: pair.priceChange?.m5 || 0,
    buys: pair.txns?.h24?.buys || 0,
    sells: pair.txns?.h24?.sells || 0,
    buys_1h: pair.txns?.h1?.buys || 0,
    sells_1h: pair.txns?.h1?.sells || 0,
    holders: pair.holders || 0,
    holders_prev: null,
    top10_pct: 0, // Need on-chain data for this
    age_hours: Math.round(ageHours * 10) / 10,
    created_at: createdAt,
    url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
    image: pair.info?.imageUrl || null,
    websites: pair.info?.websites || [],
    socials: pair.info?.socials || [],
    rugcheck: null,
    safety: 0,
    potential: 0,
    safety_checks: {},
    staircase_detected: false,
    staircase_confidence: 0,
    price_history: [],
    scanned_at: now,
  };
}

// ─── TELEGRAM ALERT ───
async function sendDiscordAlert(embed) {
  if (!DISCORD_WEBHOOK) {
    updateServiceHealth("discord", false, 0);
    return;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    const latency = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 300;
    if (ok) serviceHealth.discord.alertsSent++;
    updateServiceHealth("discord", ok, latency);
    if (!ok) console.error("Discord webhook returned:", res.status);
  } catch (err) {
    updateServiceHealth("discord", false, Date.now() - t0);
    console.error("Discord webhook error:", err.message);
  }
}

function formatDiscordAlert(token) {
  const safetyEmoji = token.safety >= 75 ? "🟢" : token.safety >= 50 ? "🟡" : token.safety >= 25 ? "🟠" : "🔴";
  const color = token.safety >= 75 ? 0x16a34a : token.safety >= 50 ? 0xd97706 : token.safety >= 25 ? 0xea580c : 0xdc2626;

  const lines = [];
  lines.push(`**Safety:** ${token.safety}/100  |  **Potential x2:** ${token.potential}/100`);
  lines.push(`**Price:** $${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(6)}  |  **MCap:** $${formatNum(token.market_cap)}  |  **Liq:** $${formatNum(token.liquidity)}`);
  lines.push(`**Vol 24H:** $${formatNum(token.volume_24h)}  |  **Age:** ${token.age_hours}h  |  **Buys/Sells:** ${token.buys}/${token.sells}`);

  const warns = [];
  if (token.honeypot_detected) warns.push("🚫 HONEYPOT");
  if (token.sell_tax > 15) warns.push(`💀 Tax ${token.sell_tax.toFixed(1)}%`);
  else if (token.sell_tax > 0) warns.push(`⚠️ Tax ${token.sell_tax.toFixed(1)}%`);
  if (token.staircase_detected) warns.push("📊 Staircase");
  if (token.buy_slippage > 10) warns.push(`📉 Slip ${token.buy_slippage.toFixed(1)}%`);

  const contract = [];
  if (token.rugcheck) {
    contract.push(token.rugcheck.mintEnabled ? "❌ Mint" : "✅ Mint off");
    contract.push(token.rugcheck.lpBurned ? "✅ LP burned" : token.rugcheck.lpLocked ? "✅ LP locked" : "❌ LP unlocked");
  }

  if (warns.length > 0) lines.push("\n" + warns.join("  |  "));
  if (contract.length > 0) lines.push(contract.join("  |  "));

  const dexUrl = token.url || `https://dexscreener.com/solana/${token.pair_address}`;
  lines.push(`\n[DEX Screener](${dexUrl})  |  [rugcheck](https://rugcheck.xyz/tokens/${token.address})  |  [Solscan](https://solscan.io/token/${token.address})`);

  return {
    title: `${safetyEmoji} ${token.symbol} — $${formatNum(token.market_cap)} MCap`,
    color,
    description: lines.join("\n"),
    footer: { text: token.address },
    timestamp: new Date().toISOString(),
  };
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toString();
}

// ─── MAIN SCAN LOOP ───
async function scanOnce() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);

  const pairs = await fetchNewPairs();
  if (!pairs.length) {
    console.log("No pairs returned");
    return;
  }

  console.log(`Found ${pairs.length} pairs`);

  const newTokens = [];

  for (const pair of pairs.slice(0, 30)) {
    // Limit to 30 per scan to stay within rate limits
    const token = processPair(pair);

    // Skip if already scanned recently
    const existing = tokenStore.find(t => t.address === token.address);
    if (existing && (Date.now() - existing.scanned_at) < 60000) {
      continue;
    }

    // Fetch rugcheck (rate limit: do max 15 per scan)
    if (newTokens.length < 15) {
      token.rugcheck = await fetchRugcheck(token.address);
      await new Promise(r => setTimeout(r, 200));
    }

    // Fetch Jupiter slippage & sell tax (max 10 per scan, only for tokens with some liquidity)
    if (newTokens.length < 10 && token.liquidity >= 1000) {
      const t0 = Date.now();
      const jupCheck = await checkSlippageAndTax(token.address);
      const latency = Date.now() - t0;

      token.jupiter = jupCheck;
      serviceHealth.jupiter.checksCompleted++;
      updateServiceHealth("jupiter", !jupCheck.error, latency);

      if (jupCheck.buySlippage !== null) {
        token.buy_slippage = jupCheck.buySlippage;
      }
      if (jupCheck.sellSlippage !== null) {
        token.sell_slippage = jupCheck.sellSlippage;
      }
      if (jupCheck.sellTax !== null) {
        token.sell_tax = jupCheck.sellTax;
      }
      if (jupCheck.honeypot) {
        token.honeypot_detected = true;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    // Score the token
    const safetyResult = calcSafety(token);
    token.safety = safetyResult.score;
    token.safety_checks = safetyResult.checks;
    token.potential = calcPotential(token);

    // Log top scoring tokens
    const jupInfo = token.jupiter ? ` | Slip:${token.buy_slippage?.toFixed(1)||"?"}%/${token.sell_slippage?.toFixed(1)||"?"}% Tax:${token.sell_tax?.toFixed(1)||"?"}%${token.honeypot_detected?" HONEYPOT":""}` : "";
    if (token.safety >= 60 || token.potential >= 50) {
      console.log(`  ★ ${token.symbol} | Safety:${token.safety} Pot:${token.potential} | MCap:$${formatNum(token.market_cap)} Liq:$${formatNum(token.liquidity)} | RC:${token.rugcheck ? "yes" : "no"}${jupInfo}`);
    }

    // Store previous holder count for growth tracking
    if (existing) {
      token.holders_prev = existing.holders;
      token.price_history = [...(existing.price_history || []).slice(-23), token.price];
    } else {
      token.price_history = [token.price];
    }

    // Staircase detection
    if (token.price_history.length >= 8) {
      const staircase = detectStaircase(token.price_history);
      token.staircase_detected = staircase.detected;
      token.staircase_confidence = staircase.confidence;
    }

    newTokens.push(token);

    // Alert logic
    if (token.safety >= MIN_SAFETY && token.potential >= MIN_POTENTIAL) {
      const alertMsg = {
        id: Date.now(),
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        type: token.safety >= 75 ? "safe" : "potential",
        symbol: token.symbol,
        message: `Safety ${token.safety}, Potential ${token.potential}. MCap $${formatNum(token.market_cap)}`,
        score: token.safety,
      };
      alertLog.unshift(alertMsg);
      if (alertLog.length > 100) alertLog = alertLog.slice(0, 100);

      // Send Discord alert (with dedup - max once per 30min per token)
      if (shouldAlertDiscord(token.address)) {
        await sendDiscordAlert(formatDiscordAlert(token));
      }
    }

    // Danger alert
    if (token.safety < 20 || token.staircase_detected || token.honeypot_detected || token.sell_tax > 15) {
      const reasons = [];
      if (token.honeypot_detected) reasons.push("HONEYPOT detected");
      if (token.sell_tax > 15) reasons.push("Sell tax " + token.sell_tax.toFixed(1) + "%");
      if (token.staircase_detected) reasons.push("Staircase pattern " + token.staircase_confidence + "%");
      if (token.rugcheck?.mintEnabled) reasons.push("Mint enabled");
      if (token.rugcheck && !token.rugcheck.lpBurned && !token.rugcheck.lpLocked) reasons.push("LP unlocked");
      if (reasons.length === 0) reasons.push("Safety " + token.safety);

      alertLog.unshift({
        id: Date.now() + 1,
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        type: "danger",
        symbol: token.symbol,
        message: reasons.join(". "),
        score: token.safety,
      });

      // Discord danger warning (with dedup)
      if ((token.honeypot_detected || token.staircase_detected || token.sell_tax > 30) && shouldAlertDiscord("danger-" + token.address)) {
        const desc = reasons.map(r => "⚠️ **" + r + "**").join("\n");
        await sendDiscordAlert({
          title: `🔴 DANGER: ${token.symbol} (${token.name})`,
          color: 0xdc2626,
          description: desc + "\nDo NOT buy this token.",
          fields: [
            { name: "Safety", value: `${token.safety}/100`, inline: true },
            { name: "MCap", value: `$${formatNum(token.market_cap)}`, inline: true },
            { name: "Sell Tax", value: token.sell_tax != null ? token.sell_tax.toFixed(1) + "%" : "?", inline: true },
          ],
          footer: { text: token.address },
          url: token.url || `https://dexscreener.com/solana/${token.pair_address}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Update store: merge new tokens with existing
  for (const token of newTokens) {
    const idx = tokenStore.findIndex(t => t.address === token.address);
    if (idx >= 0) {
      tokenStore[idx] = token;
    } else {
      tokenStore.unshift(token);
    }
  }

  // Keep max 200 tokens in memory
  if (tokenStore.length > 200) {
    tokenStore = tokenStore.slice(0, 200);
  }

  lastScan = Date.now();
  scanCount++;
  console.log(`Scan #${scanCount} complete. ${newTokens.length} tokens processed. Store: ${tokenStore.length}`);
}

// ─── API ROUTES ───

// All tokens
app.get("/api/tokens", (req, res) => {
  const { min_safety, min_potential, sort, dir, search, limit } = req.query;
  let tokens = [...tokenStore];

  if (search) {
    const q = search.toLowerCase();
    tokens = tokens.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.symbol.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q)
    );
  }
  if (min_safety) tokens = tokens.filter(t => t.safety >= parseInt(min_safety));
  if (min_potential) tokens = tokens.filter(t => t.potential >= parseInt(min_potential));

  const sortField = sort || "safety";
  const sortDir = dir === "asc" ? 1 : -1;
  tokens.sort((a, b) => ((a[sortField] || 0) - (b[sortField] || 0)) * sortDir);

  if (limit) tokens = tokens.slice(0, parseInt(limit));

  res.json({ tokens, total: tokenStore.length, last_scan: lastScan, scan_count: scanCount });
});

// Single token detail
app.get("/api/tokens/:address", (req, res) => {
  const token = tokenStore.find(t => t.address === req.params.address);
  if (!token) return res.status(404).json({ error: "Token not found" });
  res.json(token);
});

// Alerts
app.get("/api/alerts", (req, res) => {
  res.json({ alerts: alertLog.slice(0, 50) });
});

// Stats
app.get("/api/stats", (req, res) => {
  const total = tokenStore.length;
  const safe = tokenStore.filter(t => t.safety >= 75).length;
  const danger = tokenStore.filter(t => t.safety < 25).length;
  const stairs = tokenStore.filter(t => t.staircase_detected).length;
  const potHigh = tokenStore.filter(t => t.potential >= 50 && t.safety >= 50).length;
  const avgScore = total > 0 ? Math.round(tokenStore.reduce((a, t) => a + t.safety, 0) / total) : 0;
  const best = tokenStore.reduce((b, t) => t.safety > (b?.safety || 0) ? t : b, null);
  const bestPot = tokenStore.reduce((b, t) => (t.potential > (b?.potential || 0) && t.safety >= 50) ? t : b, null);

  res.json({
    total, safe, danger, stairs, potHigh, avgScore,
    rugRate: total > 0 ? Math.round(danger / total * 100) : 0,
    bestSafety: best ? { symbol: best.symbol, score: best.safety } : null,
    bestPotential: bestPot ? { symbol: bestPot.symbol, score: bestPot.potential } : null,
    lastScan, scanCount,
  });
});

// Health check
app.get("/api/health", (req, res) => {
  const now = Date.now();
  const formatService = (name) => {
    const s = serviceHealth[name];
    return {
      status: s.status,
      latency: s.latency,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      lastError: s.lastError ? new Date(s.lastError).toISOString() : null,
      errorCount: s.errorCount,
      sinceLastSuccess: s.lastSuccess ? Math.round((now - s.lastSuccess) / 1000) : null,
      ...Object.fromEntries(
        Object.entries(s).filter(([k]) => !["status","latency","lastSuccess","lastError","errorCount"].includes(k))
      ),
    };
  };

  res.json({
    status: Object.values(serviceHealth).every(s => s.status === "ok") ? "healthy" :
            Object.values(serviceHealth).some(s => s.status === "down") ? "degraded" : "partial",
    uptime: Math.round(process.uptime()),
    tokens: tokenStore.length,
    scans: scanCount,
    lastScan: lastScan ? new Date(lastScan).toISOString() : null,
    sinceLastScan: lastScan ? Math.round((now - lastScan) / 1000) : null,
    services: {
      dexscreener: formatService("dexscreener"),
      rugcheck: formatService("rugcheck"),
      jupiter: formatService("jupiter"),
      discord: formatService("discord"),
    },
  });
});

// Wake-up ping endpoint (for frontend auto-ping)
app.get("/api/ping", (req, res) => {
  res.json({ pong: true, time: new Date().toISOString(), tokens: tokenStore.length });
});

// ─── START ───
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Scan interval: ${SCAN_INTERVAL}ms`);
  console.log(`Discord: ${DISCORD_WEBHOOK ? "configured" : "not configured"}`);
  console.log(`Helius: ${HELIUS_KEY ? "configured" : "not configured"}`);

  // Initial scan
  scanOnce();

  // Recurring scan
  setInterval(scanOnce, SCAN_INTERVAL);
});

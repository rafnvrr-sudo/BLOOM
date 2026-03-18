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

// ─── SAFETY SCORING ───
function calcSafety(token) {
  let score = 0;
  const checks = {};

  // Liquidity (0-20 pts)
  checks.liquidity = { pass: token.liquidity >= 5000, value: "$" + formatNum(token.liquidity) };
  if (token.liquidity >= 100000) score += 20;
  else if (token.liquidity >= 50000) score += 16;
  else if (token.liquidity >= 20000) score += 12;
  else if (token.liquidity >= 5000) score += 8;
  else if (token.liquidity >= 1000) score += 3;

  // Volume health - vol/liq ratio indicates real trading (0-12 pts)
  const volLiqRatio = token.volume_24h / Math.max(token.liquidity, 1);
  checks.vol_liq_ratio = { pass: volLiqRatio > 0.5 && volLiqRatio < 50, value: volLiqRatio.toFixed(1) + "x" };
  if (volLiqRatio > 0.5 && volLiqRatio < 50) score += 12;
  else if (volLiqRatio > 0.2) score += 6;

  // Age (0-12 pts) - older = safer
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

  // Buy/sell ratio 1h - recent momentum (0-8 pts)
  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    checks.buy_ratio_1h = { pass: ratio1h > 0.45, value: (ratio1h * 100).toFixed(0) + "%" };
    if (ratio1h > 0.6) score += 8;
    else if (ratio1h > 0.45) score += 5;
  } else {
    checks.buy_ratio_1h = { pass: false, value: "low txns" };
  }

  // Market cap sanity (0-8 pts) - not too tiny, not dead
  checks.market_cap = { pass: token.market_cap >= 10000, value: "$" + formatNum(token.market_cap) };
  if (token.market_cap >= 100000) score += 8;
  else if (token.market_cap >= 50000) score += 6;
  else if (token.market_cap >= 10000) score += 4;

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
  } else {
    checks.contract = { pass: false, value: "pending scan" };
    score += 10; // neutral base - don't punish too hard for missing data
  }

  return { score: Math.min(score, 100), checks };
}

// ─── POTENTIAL SCORING ───
function calcPotential(token) {
  let score = 0;

  // Vol/MCap ratio (0-20 pts) - high = strong momentum
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

  // Buy pressure 1h - recent momentum (0-15 pts)
  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    if (ratio1h > 0.75) score += 15;
    else if (ratio1h > 0.6) score += 10;
    else if (ratio1h > 0.5) score += 5;
  }

  // MCap room (0-15 pts) - lower mcap = more upside
  if (token.market_cap < 50000) score += 15;
  else if (token.market_cap < 200000) score += 12;
  else if (token.market_cap < 500000) score += 8;
  else if (token.market_cap < 1000000) score += 4;

  // 1h price momentum (0-15 pts)
  if (token.change_1h > 100 && token.change_1h < 1000) score += 15;
  else if (token.change_1h > 30) score += 12;
  else if (token.change_1h > 10) score += 8;
  else if (token.change_1h > 0) score += 3;

  // 5m momentum - very recent action (0-10 pts)
  if (token.change_5m > 20 && token.change_5m < 200) score += 10;
  else if (token.change_5m > 5) score += 6;

  // Liquidity depth relative to mcap (0-10 pts) - healthy ratio
  const liqMcapRatio = token.liquidity / Math.max(token.market_cap, 1);
  if (liqMcapRatio > 0.1 && liqMcapRatio < 0.5) score += 10;
  else if (liqMcapRatio > 0.05) score += 5;

  // Penalize staircase
  if (token.staircase_detected) score = Math.max(score - 30, 0);

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

  // Strategy: multiple search queries to find fresh Solana pairs
  const queries = [
    "https://api.dexscreener.com/latest/dex/search?q=pump",       // pump.fun tokens
    "https://api.dexscreener.com/latest/dex/search?q=SOL%20new",  // new SOL pairs
    "https://api.dexscreener.com/latest/dex/search?q=raydium%20solana", // raydium pairs
  ];

  for (const url of queries) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
        allPairs.push(...pairs);
      }
      // Small delay between requests to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error("DEX Screener fetch error:", err.message);
    }
  }

  // Also fetch boosted tokens and resolve their pairs
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
    console.error("Boosts fetch error:", e.message);
  }

  // Deduplicate by pairAddress
  const seen = new Set();
  const unique = [];
  for (const pair of allPairs) {
    const key = pair.pairAddress || pair.baseToken?.address;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(pair);
    }
  }

  // Sort by creation date (newest first) if available
  unique.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));

  console.log(`Fetched ${unique.length} unique Solana pairs`);
  return unique;
}

// ─── RUGCHECK FETCH ───
async function fetchRugcheck(mintAddress) {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      mintEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("mint")) || false,
      freezeEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("freeze")) || false,
      lpBurned: data.risks?.some(r => r.name?.toLowerCase().includes("burn") && r.level === "good") || false,
      lpLocked: data.risks?.some(r => r.name?.toLowerCase().includes("lock") && r.level === "good") || false,
      score: data.score || 0,
      risks: data.risks || [],
    };
  } catch (err) {
    console.error("rugcheck error:", err.message);
    return null;
  }
}

// ─── PRICE HISTORY (from DEX Screener pair data) ───
function extractPriceChanges(pair) {
  // DEX Screener gives us price changes at different intervals
  const changes = [];
  if (pair.priceChange) {
    changes.push(pair.priceChange.m5 || 0);
    changes.push(pair.priceChange.h1 || 0);
    changes.push(pair.priceChange.h6 || 0);
    changes.push(pair.priceChange.h24 || 0);
  }
  return changes;
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
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error("Discord webhook error:", err.message);
  }
}

function formatDiscordAlert(token) {
  const safetyEmoji = token.safety >= 75 ? "🟢" : token.safety >= 50 ? "🟡" : token.safety >= 25 ? "🟠" : "🔴";
  const potEmoji = token.potential >= 70 ? "🚀" : token.potential >= 50 ? "📈" : "📊";
  const stairWarn = token.staircase_detected ? "\n⚠️ **STAIRCASE PATTERN DETECTED**" : "";

  const color = token.safety >= 75 ? 0x00e676 : token.safety >= 50 ? 0xffab00 : token.safety >= 25 ? 0xff6d00 : 0xff1744;

  return {
    title: `${safetyEmoji} ${token.symbol} (${token.name})`,
    color,
    fields: [
      { name: "Safety", value: `${token.safety}/100`, inline: true },
      { name: "Potential x2", value: `${token.potential}/100 ${potEmoji}`, inline: true },
      { name: "Price", value: `$${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(6)}`, inline: true },
      { name: "MCap", value: `$${formatNum(token.market_cap)}`, inline: true },
      { name: "Volume 24H", value: `$${formatNum(token.volume_24h)}`, inline: true },
      { name: "Liquidity", value: `$${formatNum(token.liquidity)}`, inline: true },
      { name: "Holders", value: `${token.holders}`, inline: true },
      { name: "Age", value: `${token.age_hours}h`, inline: true },
      { name: "Buys/Sells", value: `${token.buys}/${token.sells}`, inline: true },
    ],
    description: stairWarn || undefined,
    footer: {
      text: `${token.address}`,
    },
    url: token.url || `https://dexscreener.com/solana/${token.pair_address}`,
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

    // Fetch rugcheck (rate limit: do max 5 per scan)
    if (newTokens.length < 15) {
      token.rugcheck = await fetchRugcheck(token.address);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    // Score the token
    const safetyResult = calcSafety(token);
    token.safety = safetyResult.score;
    token.safety_checks = safetyResult.checks;
    token.potential = calcPotential(token);

    // Log top scoring tokens
    if (token.safety >= 60 || token.potential >= 50) {
      console.log(`  ★ ${token.symbol} | Safety:${token.safety} Pot:${token.potential} | MCap:$${formatNum(token.market_cap)} Vol:$${formatNum(token.volume_24h)} Liq:$${formatNum(token.liquidity)} | RC:${token.rugcheck ? "yes" : "no"}`);
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

      // Send Discord alert
      await sendDiscordAlert(formatDiscordAlert(token));
    }

    // Danger alert
    if (token.safety < 20 || token.staircase_detected) {
      alertLog.unshift({
        id: Date.now() + 1,
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        type: "danger",
        symbol: token.symbol,
        message: token.staircase_detected
          ? `Staircase pattern ${token.staircase_confidence}% confidence`
          : `Safety ${token.safety}. ${token.rugcheck?.mintEnabled ? "Mint enabled. " : ""}${token.rugcheck?.freezeEnabled ? "Freeze enabled." : ""}`,
        score: token.safety,
      });

      // Discord danger warning
      if (token.staircase_detected) {
        await sendDiscordAlert({
          title: `🔴 DANGER: ${token.symbol} (${token.name})`,
          color: 0xff1744,
          description: `⚠️ **STAIRCASE PATTERN** detected (${token.staircase_confidence}% confidence)\nArtificial pump pattern. Do NOT buy.`,
          fields: [
            { name: "Safety", value: `${token.safety}/100`, inline: true },
            { name: "MCap", value: `$${formatNum(token.market_cap)}`, inline: true },
            { name: "Top 10 Holders", value: `${token.top10_pct}%`, inline: true },
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
  res.json({ status: "ok", uptime: process.uptime(), tokens: tokenStore.length, scans: scanCount });
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

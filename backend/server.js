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

  // Liquidity check
  const liqOk = token.liquidity >= 5000;
  checks.liquidity = { pass: liqOk, value: token.liquidity };
  if (liqOk) score += 15;

  // Holder count
  const holdOk = token.holders >= 100;
  checks.holders = { pass: holdOk, value: token.holders };
  if (token.holders >= 500) score += 15;
  else if (token.holders >= 100) score += 8;

  // Top 10 concentration
  const top10Ok = token.top10_pct < 30;
  checks.top10 = { pass: top10Ok, value: token.top10_pct };
  if (token.top10_pct < 15) score += 15;
  else if (token.top10_pct < 30) score += 10;
  else if (token.top10_pct < 50) score += 3;

  // Age check
  const ageH = token.age_hours;
  const ageOk = ageH > 1;
  checks.age = { pass: ageOk, value: ageH };
  if (ageH > 24) score += 10;
  else if (ageH > 6) score += 7;
  else if (ageH > 1) score += 4;

  // rugcheck data (if available)
  if (token.rugcheck) {
    const rc = token.rugcheck;
    const mintOk = !rc.mintEnabled;
    const freezeOk = !rc.freezeEnabled;
    const lpBurnOk = rc.lpBurned || rc.lpLocked;

    checks.mint = { pass: mintOk, value: rc.mintEnabled ? "ENABLED" : "disabled" };
    checks.freeze = { pass: freezeOk, value: rc.freezeEnabled ? "ENABLED" : "disabled" };
    checks.lp_lock = { pass: lpBurnOk, value: rc.lpBurned ? "burned" : rc.lpLocked ? "locked" : "UNLOCKED" };

    if (mintOk) score += 12;
    if (freezeOk) score += 8;
    if (lpBurnOk) score += 15;
  } else {
    // No rugcheck data: assume moderate risk
    checks.mint = { pass: false, value: "unknown" };
    checks.freeze = { pass: false, value: "unknown" };
    checks.lp_lock = { pass: false, value: "unknown" };
    score += 5; // small base
  }

  // Buy/sell ratio
  if (token.buys > 0 && token.sells > 0) {
    const ratio = token.buys / (token.buys + token.sells);
    checks.buy_ratio = { pass: ratio > 0.5, value: (ratio * 100).toFixed(0) + "%" };
    if (ratio > 0.7) score += 10;
    else if (ratio > 0.5) score += 5;
  }

  return { score: Math.min(score, 100), checks };
}

// ─── POTENTIAL SCORING ───
function calcPotential(token) {
  let score = 0;

  // Vol/MCap ratio
  const vmRatio = token.volume_24h / Math.max(token.market_cap, 1);
  if (vmRatio > 5) score += 25;
  else if (vmRatio > 2) score += 20;
  else if (vmRatio > 1) score += 15;
  else if (vmRatio > 0.5) score += 8;

  // Holder growth (if we have historical data)
  if (token.holders_prev && token.holders > token.holders_prev) {
    const growth = (token.holders - token.holders_prev) / token.holders_prev;
    if (growth > 0.3) score += 25;
    else if (growth > 0.15) score += 20;
    else if (growth > 0.05) score += 12;
    else score += 5;
  }

  // Buy pressure
  if (token.buys > 0) {
    const buyRatio = token.buys / Math.max(token.buys + token.sells, 1);
    if (buyRatio > 0.8) score += 20;
    else if (buyRatio > 0.7) score += 15;
    else if (buyRatio > 0.6) score += 10;
  }

  // MCap room
  if (token.market_cap < 50000) score += 15;
  else if (token.market_cap < 200000) score += 12;
  else if (token.market_cap < 1000000) score += 8;
  else score += 3;

  // 1h momentum
  if (token.change_1h > 50 && token.change_1h < 500) score += 15;
  else if (token.change_1h > 10) score += 8;

  // Penalize if staircase detected
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
  try {
    const res = await fetch("https://api.dexscreener.com/token-pairs/v1/solana/latest?minLiq=1000&minAge=0&maxAge=24");
    if (!res.ok) {
      // Fallback to search endpoint
      const res2 = await fetch("https://api.dexscreener.com/latest/dex/search?q=sol");
      if (!res2.ok) throw new Error(`DEX Screener: ${res2.status}`);
      const data2 = await res2.json();
      return (data2.pairs || []).filter(p => p.chainId === "solana");
    }
    const data = await res.json();
    return data || [];
  } catch (err) {
    console.error("DEX Screener fetch error:", err.message);
    // Try the tokens/trending endpoint as another fallback
    try {
      const res3 = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
      if (res3.ok) {
        const data3 = await res3.json();
        return (data3 || []).filter(t => t.chainId === "solana");
      }
    } catch (e) { /* silent */ }
    return [];
  }
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
    if (newTokens.length < 5) {
      token.rugcheck = await fetchRugcheck(token.address);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    // Score the token
    const safetyResult = calcSafety(token);
    token.safety = safetyResult.score;
    token.safety_checks = safetyResult.checks;
    token.potential = calcPotential(token);

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

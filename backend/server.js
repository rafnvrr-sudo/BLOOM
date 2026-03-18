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
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

let tokenStore = [];
let alertLog = [];
let graduationLog = [];
let lastScan = null;
let scanCount = 0;

// ─── TREND STORE ───
const trendStore = {
  trends: new Map(),
  lastRefresh: null,
  refreshCount: 0,
};

// ─── SERVICE HEALTH ───
const serviceHealth = {
  dexscreener: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, pairsReturned: 0 },
  rugcheck: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  jupiter: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  discord: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, alertsSent: 0 },
  groq: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, analysesCompleted: 0 },
  trends: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, termsTracked: 0 },
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
  if (discordAlerted.size > 500) {
    const cutoff = Date.now() - DISCORD_COOLDOWN_MS;
    for (const [k, v] of discordAlerted) { if (v < cutoff) discordAlerted.delete(k); }
  }
  return true;
}

// ─── SAFETY SCORING ───
function calcSafety(token) {
  let score = 0;
  let penalties = 0;
  const checks = {};

  checks.liquidity = { pass: token.liquidity >= 5000, value: "$" + formatNum(token.liquidity) };
  if (token.liquidity >= 100000) score += 20;
  else if (token.liquidity >= 50000) score += 16;
  else if (token.liquidity >= 20000) score += 12;
  else if (token.liquidity >= 5000) score += 8;
  else if (token.liquidity >= 1000) score += 3;

  const volLiqRatio = token.volume_24h / Math.max(token.liquidity, 1);
  const volLiqOk = volLiqRatio > 0.5 && volLiqRatio < 50;
  checks.vol_liq_ratio = { pass: volLiqOk, value: volLiqRatio.toFixed(1) + "x" };
  if (volLiqOk) score += 12;
  else if (volLiqRatio > 0.2 && volLiqRatio <= 50) score += 6;
  if (volLiqRatio > 100) { penalties += 20; checks.vol_liq_ratio.value += " EXTREME"; }
  else if (volLiqRatio > 50) { penalties += 12; }

  const ageH = token.age_hours;
  checks.age = { pass: ageH > 2, value: ageH.toFixed(1) + "h" };
  if (ageH > 48) score += 12;
  else if (ageH > 12) score += 10;
  else if (ageH > 6) score += 8;
  else if (ageH > 2) score += 5;
  else if (ageH > 0.5) score += 2;

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

  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    checks.buy_ratio_1h = { pass: ratio1h > 0.45, value: (ratio1h * 100).toFixed(0) + "%" };
    if (ratio1h > 0.6) score += 8;
    else if (ratio1h > 0.45) score += 5;
    if (ratio1h < 0.3 && token.buys_1h + token.sells_1h > 20) penalties += 8;
  } else {
    checks.buy_ratio_1h = { pass: false, value: "low txns" };
  }

  checks.market_cap = { pass: token.market_cap >= 10000, value: "$" + formatNum(token.market_cap) };
  if (token.market_cap >= 100000) score += 8;
  else if (token.market_cap >= 50000) score += 6;
  else if (token.market_cap >= 10000) score += 4;

  if (token.change_24h < -50) {
    checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% dump" };
    penalties += 15;
  } else if (token.change_24h < -30) {
    checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% decline" };
    penalties += 8;
  }

  if (token.change_1h < -30) {
    checks.dumping_1h = { pass: false, value: token.change_1h.toFixed(0) + "% 1h" };
    penalties += 10;
  }

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
    if (!lpOk) penalties += 10;
    if (!mintOk) penalties += 8;
  } else {
    checks.contract = { pass: false, value: "pending scan" };
    score += 10;
  }

  if (token.jupiter && !token.jupiter.error) {
    if (token.buy_slippage !== null && token.buy_slippage !== undefined) {
      const bsOk = token.buy_slippage < 5;
      checks.buy_slippage = { pass: bsOk, value: token.buy_slippage.toFixed(1) + "%" };
      if (token.buy_slippage > 15) penalties += 10;
      else if (token.buy_slippage > 10) penalties += 5;
    }
    if (token.sell_slippage !== null && token.sell_slippage !== undefined) {
      const ssOk = token.sell_slippage < 8;
      checks.sell_slippage = { pass: ssOk, value: token.sell_slippage.toFixed(1) + "%" };
      if (token.sell_slippage > 20) penalties += 12;
      else if (token.sell_slippage > 10) penalties += 6;
    }
    if (token.sell_tax !== null && token.sell_tax !== undefined) {
      const taxOk = token.sell_tax < 5;
      checks.sell_tax = { pass: taxOk, value: token.sell_tax.toFixed(1) + "%" };
      if (token.sell_tax > 30) penalties += 30;
      else if (token.sell_tax > 15) penalties += 20;
      else if (token.sell_tax > 5) penalties += 10;
    }
    if (token.honeypot_detected) {
      checks.honeypot = { pass: false, value: "HONEYPOT" };
      penalties += 40;
    }
  }

  const finalScore = Math.max(Math.min(score - penalties, 100), 0);
  return { score: finalScore, checks };
}

// ─── FEATURE 2: RETURN PROBABILITY ───
function calcReturnProba(token) {
  let rawScore = 0;

  const vmRatio = token.volume_24h / Math.max(token.market_cap, 1);
  if (vmRatio > 5) rawScore += 20;
  else if (vmRatio > 2) rawScore += 16;
  else if (vmRatio > 1) rawScore += 12;
  else if (vmRatio > 0.5) rawScore += 6;

  if (token.buys + token.sells > 10) {
    const buyRatio = token.buys / Math.max(token.buys + token.sells, 1);
    if (buyRatio > 0.75) rawScore += 15;
    else if (buyRatio > 0.65) rawScore += 12;
    else if (buyRatio > 0.55) rawScore += 8;
    else rawScore += 3;
  }

  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    if (ratio1h > 0.75) rawScore += 15;
    else if (ratio1h > 0.6) rawScore += 10;
    else if (ratio1h > 0.5) rawScore += 5;
  }

  if (token.market_cap < 50000) rawScore += 15;
  else if (token.market_cap < 200000) rawScore += 12;
  else if (token.market_cap < 500000) rawScore += 8;
  else if (token.market_cap < 1000000) rawScore += 4;

  if (token.change_1h > 100 && token.change_1h < 1000) rawScore += 15;
  else if (token.change_1h > 30) rawScore += 12;
  else if (token.change_1h > 10) rawScore += 8;
  else if (token.change_1h > 0) rawScore += 3;

  if (token.change_5m > 20 && token.change_5m < 200) rawScore += 10;
  else if (token.change_5m > 5) rawScore += 6;

  const liqMcapRatio = token.liquidity / Math.max(token.market_cap, 1);
  if (liqMcapRatio > 0.1 && liqMcapRatio < 0.5) rawScore += 10;
  else if (liqMcapRatio > 0.05) rawScore += 5;

  // Penalties
  if (token.change_24h < -50) rawScore = Math.max(rawScore - 30, 0);
  else if (token.change_24h < -30) rawScore = Math.max(rawScore - 15, 0);
  if (token.change_1h < -20) rawScore = Math.max(rawScore - 20, 0);
  const volLiq = token.volume_24h / Math.max(token.liquidity, 1);
  if (volLiq > 100) rawScore = Math.max(rawScore - 15, 0);
  if (token.staircase_detected) rawScore = Math.max(rawScore - 30, 0);
  if (token.rugcheck && !token.rugcheck.lpBurned && !token.rugcheck.lpLocked) rawScore = Math.max(rawScore - 10, 0);
  if (token.sell_tax > 15) rawScore = Math.max(rawScore - 40, 0);
  else if (token.sell_tax > 5) rawScore = Math.max(rawScore - 15, 0);
  if (token.honeypot_detected) rawScore = 0;

  rawScore = Math.min(rawScore, 100);

  // Trend boost
  if (token.trend_match) rawScore = Math.min(rawScore + 10, 100);

  // Sigmoid conversion to probability (5%-85% range)
  const sigmoid = (x) => 1 / (1 + Math.exp(-0.08 * (x - 50)));
  const probability = Math.round(5 + sigmoid(rawScore) * 80);

  // Expected gain based on mcap room
  let expectedGain;
  if (token.market_cap < 30000) expectedGain = 500;
  else if (token.market_cap < 100000) expectedGain = 200;
  else if (token.market_cap < 500000) expectedGain = 100;
  else if (token.market_cap < 2000000) expectedGain = 50;
  else expectedGain = 20;

  if (token.change_24h < -30) expectedGain = Math.round(expectedGain * 0.3);
  if (token.sell_tax > 5) expectedGain = Math.round(expectedGain * 0.5);
  if (token.staircase_detected) expectedGain = Math.round(expectedGain * 0.2);

  let horizon;
  if (token.age_hours < 6) horizon = "4h";
  else if (token.age_hours < 24) horizon = "24h";
  else horizon = "1-3j";

  const factors = {
    vol_mcap: vmRatio.toFixed(2) + "x",
    buy_pressure_24h: token.buys + token.sells > 10 ? ((token.buys / (token.buys + token.sells)) * 100).toFixed(0) + "%" : "N/A",
    buy_pressure_1h: token.buys_1h + token.sells_1h > 3 ? ((token.buys_1h / (token.buys_1h + token.sells_1h)) * 100).toFixed(0) + "%" : "N/A",
    mcap_room: "$" + formatNum(token.market_cap),
    momentum_1h: (token.change_1h >= 0 ? "+" : "") + token.change_1h.toFixed(1) + "%",
    momentum_5m: (token.change_5m >= 0 ? "+" : "") + token.change_5m.toFixed(1) + "%",
    liq_mcap: liqMcapRatio.toFixed(3),
    raw_score: rawScore,
  };

  return { probability, expectedGain, horizon, rawScore, factors };
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

// ─── FEATURE 3: TREND SCANNER ───
async function fetchGoogleTrends() {
  const t0 = Date.now();
  try {
    const url = "https://trends.google.com/trending/rss?geo=US";
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BLOOM/1.0)" },
    });

    if (!res.ok) {
      return await fetchGoogleTrendsFallback();
    }

    const text = await res.text();
    const terms = [];

    const titleMatches = text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g);
    for (const match of titleMatches) {
      const term = match[1].trim().toLowerCase();
      if (term && term !== "daily search trends" && term.length > 1 && term.length < 50) terms.push(term);
    }

    const titleMatches2 = text.matchAll(/<title>([^<]+)<\/title>/g);
    for (const match of titleMatches2) {
      const term = match[1].trim().toLowerCase();
      if (term && term !== "daily search trends" && term.length > 1 && term.length < 50 && !terms.includes(term)) terms.push(term);
    }

    const trafficMatches = text.matchAll(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/g);
    const traffics = [];
    for (const match of trafficMatches) traffics.push(match[1].replace(/[+,]/g, ""));

    const latency = Date.now() - t0;
    updateServiceHealth("trends", terms.length > 0, latency, { termsTracked: terms.length });

    return terms.slice(0, 30).map((term, i) => ({
      term,
      source: "google",
      traffic: parseInt(traffics[i]) || 0,
    }));
  } catch (err) {
    console.error("Google Trends error:", err.message);
    updateServiceHealth("trends", false, Date.now() - t0);
    return await fetchGoogleTrendsFallback();
  }
}

async function fetchGoogleTrendsFallback() {
  try {
    const hotTerms = ["crypto", "solana", "meme", "trump", "ai", "pepe"];
    const allTerms = [];
    for (const seed of hotTerms.slice(0, 3)) {
      try {
        const url = `https://trends.google.com/trends/api/autocomplete/${encodeURIComponent(seed)}?hl=en-US`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BLOOM/1.0)" },
        });
        if (res.ok) {
          const text = await res.text();
          const clean = text.replace(/^\)]\}'\n/, "");
          try {
            const data = JSON.parse(clean);
            if (data.default?.topics) {
              for (const topic of data.default.topics) {
                if (topic.title) allTerms.push({ term: topic.title.toLowerCase(), source: "google-ac", traffic: 0 });
              }
            }
          } catch { /* skip */ }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch { /* skip */ }
    }
    return allTerms;
  } catch {
    return [];
  }
}

async function refreshTrends() {
  console.log("[Trends] Refreshing...");
  const now = Date.now();

  for (const [term, data] of trendStore.trends) {
    const ageH = (now - data.addedAt) / (1000 * 60 * 60);
    if (ageH > 24) trendStore.trends.delete(term);
    else if (ageH > 6) data.score = Math.round(data.score * 0.5);
    else if (ageH > 3) data.score = Math.round(data.score * 0.75);
  }

  const googleTerms = await fetchGoogleTrends();
  console.log(`[Trends] Got ${googleTerms.length} terms from Google`);

  for (const item of googleTerms) {
    const existing = trendStore.trends.get(item.term);
    if (existing) {
      existing.score = Math.min(existing.score + 10, 100);
      existing.lastSeen = now;
    } else {
      trendStore.trends.set(item.term, {
        term: item.term,
        score: 70 + Math.min(Math.floor((item.traffic || 0) / 10000), 30),
        addedAt: now,
        lastSeen: now,
        source: item.source,
        velocity: item.traffic || 0,
      });
    }
  }

  trendStore.lastRefresh = now;
  trendStore.refreshCount++;
  updateServiceHealth("trends", true, 0, { termsTracked: trendStore.trends.size });
  console.log(`[Trends] Active: ${trendStore.trends.size} terms`);
}

function matchTrend(token) {
  const name = (token.name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const symbol = (token.symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let bestMatch = null;
  let bestScore = 0;

  for (const [term, data] of trendStore.trends) {
    const termClean = term.replace(/[^a-z0-9 ]/g, "");
    const termWords = termClean.split(/\s+/);
    let matched = false;

    if (symbol === termClean.replace(/\s+/g, "")) matched = true;
    if (!matched && termClean.length >= 3 && name.includes(termClean)) matched = true;
    if (!matched) {
      for (const word of termWords) {
        if (word.length >= 3 && (name.includes(word) || symbol.includes(word))) { matched = true; break; }
      }
    }

    if (matched && data.score > bestScore) {
      bestScore = data.score;
      bestMatch = {
        term: data.term,
        score: data.score,
        source: data.source,
        freshness: Math.round((Date.now() - data.addedAt) / (1000 * 60)),
        velocity: data.velocity,
      };
    }
  }
  return bestMatch;
}

function countTokensOnTrend(trendTerm) {
  let count = 0;
  const termClean = trendTerm.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  for (const token of tokenStore) {
    const n = (token.name || "").toLowerCase();
    const s = (token.symbol || "").toLowerCase();
    if (n.includes(termClean) || s.includes(termClean)) count++;
  }
  return count;
}

// ─── FEATURE 1: GROQ AI ANALYSIS ───
const groqAnalysisCache = new Map();
const GROQ_CACHE_MS = 10 * 60 * 1000;

async function analyzeWithGroq(token) {
  if (!GROQ_API_KEY) return null;

  const cached = groqAnalysisCache.get(token.address);
  if (cached && (Date.now() - cached.timestamp) < GROQ_CACHE_MS) return cached.analysis;

  const t0 = Date.now();

  const trendInfo = token.trend_match
    ? `\nTREND MATCH: "${token.trend_match.term}" (score ${token.trend_match.score}/100, actif depuis ${token.trend_match.freshness} min)`
    : "\nPas de trend match actif.";

  const returnInfo = token.return_proba
    ? `\nRETOUR ESTIME: ${token.return_proba.probability}% de chance de +${token.return_proba.expectedGain}% sur ${token.return_proba.horizon}`
    : "";

  const prompt = `Tu es un analyste crypto specialise memecoins Solana. Analyse ce token et donne un verdict.

TOKEN: ${token.name} (${token.symbol})
Adresse: ${token.address}
Age: ${token.age_hours}h
Prix: $${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(8)}
Market Cap: $${formatNum(token.market_cap)}
Liquidite: $${formatNum(token.liquidity)}
Volume 24h: $${formatNum(token.volume_24h)}
Variation 24h: ${token.change_24h.toFixed(1)}%
Variation 1h: ${token.change_1h.toFixed(1)}%
Variation 5m: ${token.change_5m.toFixed(1)}%
Buys/Sells 24h: ${token.buys}/${token.sells}
Buys/Sells 1h: ${token.buys_1h}/${token.sells_1h}

SAFETY SCORE: ${token.safety}/100
Rugcheck: ${token.rugcheck ? `Mint=${token.rugcheck.mintEnabled}, Freeze=${token.rugcheck.freezeEnabled}, LP=${token.rugcheck.lpBurned ? "burned" : token.rugcheck.lpLocked ? "locked" : "UNLOCKED"}` : "non disponible"}
Jupiter: Buy slip=${token.buy_slippage != null ? token.buy_slippage.toFixed(1) + "%" : "?"}, Sell slip=${token.sell_slippage != null ? token.sell_slippage.toFixed(1) + "%" : "?"}, Sell tax=${token.sell_tax != null ? token.sell_tax.toFixed(1) + "%" : "?"}
Honeypot: ${token.honeypot_detected ? "OUI" : "non"}
Staircase: ${token.staircase_detected ? "OUI (confiance " + token.staircase_confidence + "%)" : "non"}
${trendInfo}${returnInfo}

Reponds UNIQUEMENT en JSON avec ce format exact (pas de markdown, pas de backticks) :
{"verdict":"ACHETER|SURVEILLER|EVITER","resume":"2-3 phrases en francais sur la situation du token","raisons":["raison1","raison2","raison3"]}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: "Tu es un analyste crypto. Reponds uniquement en JSON valide, sans markdown ni backticks." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    const latency = Date.now() - t0;

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`Groq API error ${res.status}:`, errText.slice(0, 200));
      updateServiceHealth("groq", false, latency);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";

    let analysis;
    try {
      const clean = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      analysis = JSON.parse(clean);
    } catch (parseErr) {
      console.error("Groq JSON parse error:", content.slice(0, 300));
      updateServiceHealth("groq", false, latency);
      return null;
    }

    if (!analysis.verdict || !analysis.resume) {
      console.error("Groq response missing fields:", analysis);
      return null;
    }

    const v = analysis.verdict.toUpperCase();
    if (v.includes("ACHET")) analysis.verdict = "ACHETER";
    else if (v.includes("SURVEIL")) analysis.verdict = "SURVEILLER";
    else analysis.verdict = "EVITER";

    serviceHealth.groq.analysesCompleted++;
    updateServiceHealth("groq", true, latency);

    groqAnalysisCache.set(token.address, { analysis, timestamp: Date.now() });

    if (groqAnalysisCache.size > 200) {
      const cutoff = Date.now() - GROQ_CACHE_MS;
      for (const [k, v] of groqAnalysisCache) { if (v.timestamp < cutoff) groqAnalysisCache.delete(k); }
    }

    return analysis;
  } catch (err) {
    console.error("Groq error:", err.message);
    updateServiceHealth("groq", false, Date.now() - t0);
    return null;
  }
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
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
        allPairs.push(...pairs);
      } else { fetchErrors++; }
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
            allPairs.push(...(pairData.pairs || []).filter(p => p.chainId === "solana"));
          }
          await new Promise(r => setTimeout(r, 200));
        } catch { /* skip */ }
      }
    }
  } catch (e) { fetchErrors++; console.error("Boosts fetch error:", e.message); }

  const seen = new Set();
  const unique = [];
  for (const pair of allPairs) {
    const key = pair.pairAddress || pair.baseToken?.address;
    if (key && !seen.has(key)) { seen.add(key); unique.push(pair); }
  }
  unique.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));

  const latency = Date.now() - startTime;
  updateServiceHealth("dexscreener", unique.length > 0, latency, { pairsReturned: unique.length });
  console.log(`Fetched ${unique.length} unique Solana pairs (${latency}ms, ${fetchErrors} errors)`);
  return unique;
}

// ─── RUGCHECK ───
async function fetchRugcheck(mintAddress) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`);
    const latency = Date.now() - t0;
    if (!res.ok) { updateServiceHealth("rugcheck", false, latency); return null; }
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

// ─── JUPITER ───
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE = "https://api.jup.ag/swap/v1/quote";
const SIMULATE_AMOUNT_SOL = 100000000;

async function checkSlippageAndTax(tokenMint) {
  const result = { buySlippage: null, sellSlippage: null, sellTax: null, honeypot: false, error: null };
  try {
    const buyUrl = `${JUPITER_QUOTE}?inputMint=${SOL_MINT}&outputMint=${tokenMint}&amount=${SIMULATE_AMOUNT_SOL}&slippageBps=5000`;
    const buyRes = await fetch(buyUrl);
    if (!buyRes.ok) {
      result.error = `buy_quote_${buyRes.status}`;
      updateServiceHealth("jupiter", false, 0);
      return result;
    }
    const buyData = await buyRes.json();
    if (!buyData.outAmount || buyData.outAmount === "0") {
      result.honeypot = true; result.error = "no_buy_output";
      updateServiceHealth("jupiter", true, 0);
      return result;
    }
    result.buySlippage = Math.abs(parseFloat(buyData.priceImpactPct || 0));
    const tokensReceived = buyData.outAmount;
    await new Promise(r => setTimeout(r, 400));

    const sellUrl = `${JUPITER_QUOTE}?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${tokensReceived}&slippageBps=5000`;
    const sellRes = await fetch(sellUrl);
    if (!sellRes.ok) {
      result.honeypot = true; result.error = "sell_quote_failed"; result.sellTax = 100;
      updateServiceHealth("jupiter", true, 0);
      return result;
    }
    const sellData = await sellRes.json();
    if (!sellData.outAmount || sellData.outAmount === "0") {
      result.honeypot = true; result.sellTax = 100;
      updateServiceHealth("jupiter", true, 0);
      return result;
    }
    result.sellSlippage = Math.abs(parseFloat(sellData.priceImpactPct || 0));
    const solBack = parseInt(sellData.outAmount);
    const totalLoss = ((SIMULATE_AMOUNT_SOL - solBack) / SIMULATE_AMOUNT_SOL) * 100;
    const estimatedNormalSlippage = result.buySlippage + result.sellSlippage;
    result.sellTax = Math.round(Math.max(0, totalLoss - estimatedNormalSlippage - 2) * 10) / 10;
    if (result.sellTax > 30) result.honeypot = true;
    updateServiceHealth("jupiter", true, 0);
  } catch (err) {
    result.error = err.message;
    updateServiceHealth("jupiter", false, 0);
  }
  return result;
}

// ─── PROCESS PAIR ───
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
    top10_pct: 0,
    age_hours: Math.round(ageHours * 10) / 10,
    created_at: createdAt,
    url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
    image: pair.info?.imageUrl || null,
    websites: pair.info?.websites || [],
    socials: pair.info?.socials || [],
    rugcheck: null,
    safety: 0,
    potential: 0,
    return_proba: null,
    trend_match: null,
    ai_analysis: null,
    ai_analysis_at: null,
    safety_checks: {},
    staircase_detected: false,
    staircase_confidence: 0,
    price_history: [],
    scanned_at: now,
  };
}

// ─── DISCORD ───
async function sendDiscordAlert(embed) {
  if (!DISCORD_WEBHOOK) { updateServiceHealth("discord", false, 0); return; }
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
  lines.push(`**Safety:** ${token.safety}/100`);
  if (token.return_proba) {
    const rp = token.return_proba;
    lines.push(`**Retour:** ${rp.probability}% → +${rp.expectedGain}% (${rp.horizon})`);
  }
  lines.push(`**Price:** $${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(6)}  |  **MCap:** $${formatNum(token.market_cap)}  |  **Liq:** $${formatNum(token.liquidity)}`);
  lines.push(`**Vol 24H:** $${formatNum(token.volume_24h)}  |  **Age:** ${token.age_hours}h  |  **Buys/Sells:** ${token.buys}/${token.sells}`);

  if (token.trend_match) {
    lines.push(`\n🔥 **TREND:** ${token.trend_match.term} (score ${token.trend_match.score})`);
  }

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

  if (token.ai_analysis) {
    const ai = token.ai_analysis;
    const verdictEmoji = ai.verdict === "ACHETER" ? "🟢" : ai.verdict === "SURVEILLER" ? "🟡" : "🔴";
    lines.push(`\n${verdictEmoji} **IA: ${ai.verdict}**\n${ai.resume}`);
  }

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
  if (!pairs.length) { console.log("No pairs returned"); return; }
  console.log(`Found ${pairs.length} pairs`);

  const newTokens = [];

  for (const pair of pairs.slice(0, 30)) {
    const token = processPair(pair);
    const existing = tokenStore.find(t => t.address === token.address);
    if (existing && (Date.now() - existing.scanned_at) < 60000) continue;

    if (newTokens.length < 15) {
      token.rugcheck = await fetchRugcheck(token.address);
      await new Promise(r => setTimeout(r, 200));
    }

    if (newTokens.length < 10 && token.liquidity >= 1000) {
      const t0 = Date.now();
      const jupCheck = await checkSlippageAndTax(token.address);
      const latency = Date.now() - t0;
      token.jupiter = jupCheck;
      serviceHealth.jupiter.checksCompleted++;
      updateServiceHealth("jupiter", !jupCheck.error, latency);
      if (jupCheck.buySlippage !== null) token.buy_slippage = jupCheck.buySlippage;
      if (jupCheck.sellSlippage !== null) token.sell_slippage = jupCheck.sellSlippage;
      if (jupCheck.sellTax !== null) token.sell_tax = jupCheck.sellTax;
      if (jupCheck.honeypot) token.honeypot_detected = true;
      await new Promise(r => setTimeout(r, 300));
    }

    const safetyResult = calcSafety(token);
    token.safety = safetyResult.score;
    token.safety_checks = safetyResult.checks;

    // Feature 3: Trend matching
    token.trend_match = matchTrend(token);
    if (token.trend_match) {
      const comp = countTokensOnTrend(token.trend_match.term);
      token.trend_match.competition = comp;
      if (comp > 20) token.trend_match.score = Math.round(token.trend_match.score * 0.3);
      else if (comp > 10) token.trend_match.score = Math.round(token.trend_match.score * 0.6);
      else if (comp > 5) token.trend_match.score = Math.round(token.trend_match.score * 0.8);
    }

    // Feature 2: Return probability
    const returnResult = calcReturnProba(token);
    token.return_proba = returnResult;
    token.potential = returnResult.rawScore;

    if (existing) {
      token.holders_prev = existing.holders;
      token.price_history = [...(existing.price_history || []).slice(-23), token.price];
      if (existing.ai_analysis && (Date.now() - (existing.ai_analysis_at || 0)) < GROQ_CACHE_MS) {
        token.ai_analysis = existing.ai_analysis;
        token.ai_analysis_at = existing.ai_analysis_at;
      }
    } else {
      token.price_history = [token.price];
    }

    if (token.price_history.length >= 8) {
      const staircase = detectStaircase(token.price_history);
      token.staircase_detected = staircase.detected;
      token.staircase_confidence = staircase.confidence;
    }

    newTokens.push(token);

    // Feature 1: AI analysis (async, non-blocking)
    if (GROQ_API_KEY && token.safety >= 60 && token.potential >= 40 && !token.ai_analysis) {
      analyzeWithGroq(token).then(analysis => {
        if (analysis) {
          token.ai_analysis = analysis;
          token.ai_analysis_at = Date.now();
          const stored = tokenStore.find(t => t.address === token.address);
          if (stored) { stored.ai_analysis = analysis; stored.ai_analysis_at = Date.now(); }
        }
      }).catch(err => console.error("Groq async error:", err.message));
    }

    // Alert logic
    if (token.safety >= MIN_SAFETY && token.potential >= MIN_POTENTIAL) {
      const rp = token.return_proba;
      alertLog.unshift({
        id: Date.now(),
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        type: token.safety >= 75 ? "safe" : "potential",
        symbol: token.symbol,
        message: `Safety ${token.safety}, ${rp ? rp.probability + "% → +" + rp.expectedGain + "% (" + rp.horizon + ")" : "Pot " + token.potential}. MCap $${formatNum(token.market_cap)}${token.trend_match ? " 🔥" + token.trend_match.term : ""}`,
        score: token.safety,
      });
      if (alertLog.length > 100) alertLog = alertLog.slice(0, 100);

      if (shouldAlertDiscord(token.address)) {
        setTimeout(async () => {
          const freshToken = tokenStore.find(t => t.address === token.address) || token;
          await sendDiscordAlert(formatDiscordAlert(freshToken));
        }, 3000);
      }
    }

    if (token.trend_match && token.safety >= 50 && token.trend_match.score >= 50) {
      alertLog.unshift({
        id: Date.now() + 2,
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        type: "narrative",
        symbol: token.symbol,
        message: `Trend match: "${token.trend_match.term}" (score ${token.trend_match.score})`,
        score: token.safety,
      });
    }

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

  for (const token of newTokens) {
    const idx = tokenStore.findIndex(t => t.address === token.address);
    if (idx >= 0) tokenStore[idx] = token;
    else tokenStore.unshift(token);
  }
  if (tokenStore.length > 200) tokenStore = tokenStore.slice(0, 200);

  lastScan = Date.now();
  scanCount++;
  console.log(`Scan #${scanCount} complete. ${newTokens.length} tokens processed. Store: ${tokenStore.length}`);
}

// ─── API ROUTES ───
app.get("/api/tokens", (req, res) => {
  const { min_safety, min_potential, sort, dir, search, limit } = req.query;
  let tokens = [...tokenStore];
  if (search) {
    const q = search.toLowerCase();
    tokens = tokens.filter(t => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.address.toLowerCase().includes(q));
  }
  if (min_safety) tokens = tokens.filter(t => t.safety >= parseInt(min_safety));
  if (min_potential) tokens = tokens.filter(t => t.potential >= parseInt(min_potential));

  const sortField = sort || "safety";
  const sortDir2 = dir === "asc" ? 1 : -1;
  if (sortField === "return_proba") {
    tokens.sort((a, b) => ((a.return_proba?.probability || 0) - (b.return_proba?.probability || 0)) * sortDir2);
  } else {
    tokens.sort((a, b) => ((a[sortField] || 0) - (b[sortField] || 0)) * sortDir2);
  }
  if (limit) tokens = tokens.slice(0, parseInt(limit));
  res.json({ tokens, total: tokenStore.length, last_scan: lastScan, scan_count: scanCount });
});

app.get("/api/tokens/:address", (req, res) => {
  const token = tokenStore.find(t => t.address === req.params.address);
  if (!token) return res.status(404).json({ error: "Token not found" });
  res.json(token);
});

app.get("/api/alerts", (req, res) => { res.json({ alerts: alertLog.slice(0, 50) }); });

app.get("/api/stats", (req, res) => {
  const total = tokenStore.length;
  const safe = tokenStore.filter(t => t.safety >= 75).length;
  const danger = tokenStore.filter(t => t.safety < 25).length;
  const stairs = tokenStore.filter(t => t.staircase_detected).length;
  const potHigh = tokenStore.filter(t => t.potential >= 50 && t.safety >= 50).length;
  const avgScore = total > 0 ? Math.round(tokenStore.reduce((a, t) => a + t.safety, 0) / total) : 0;
  const best = tokenStore.reduce((b, t) => t.safety > (b?.safety || 0) ? t : b, null);
  const bestPot = tokenStore.reduce((b, t) => (t.potential > (b?.potential || 0) && t.safety >= 50) ? t : b, null);
  const trending = tokenStore.filter(t => t.trend_match).length;

  res.json({
    total, safe, danger, stairs, potHigh, avgScore, trending,
    rugRate: total > 0 ? Math.round(danger / total * 100) : 0,
    bestSafety: best ? { symbol: best.symbol, score: best.safety } : null,
    bestPotential: bestPot ? { symbol: bestPot.symbol, score: bestPot.potential } : null,
    lastScan, scanCount,
    activeTrends: trendStore.trends.size,
  });
});

app.get("/api/trends", (req, res) => {
  const trends = [];
  for (const [term, data] of trendStore.trends) {
    trends.push({
      term: data.term, score: data.score, source: data.source,
      freshness: Math.round((Date.now() - data.addedAt) / (1000 * 60)),
      velocity: data.velocity, tokensMatched: countTokensOnTrend(data.term),
    });
  }
  trends.sort((a, b) => b.score - a.score);
  res.json({ trends: trends.slice(0, 30), total: trendStore.trends.size, lastRefresh: trendStore.lastRefresh });
});

app.post("/api/trends", (req, res) => {
  const { term, score } = req.body;
  if (!term) return res.status(400).json({ error: "term required" });
  const cleanTerm = term.toLowerCase().trim();
  trendStore.trends.set(cleanTerm, {
    term: cleanTerm, score: score || 80, addedAt: Date.now(), lastSeen: Date.now(), source: "manual", velocity: 0,
  });
  res.json({ ok: true, term: cleanTerm, total: trendStore.trends.size });
});

app.get("/api/health", (req, res) => {
  const now = Date.now();
  const formatService = (name) => {
    const s = serviceHealth[name];
    return {
      status: s.status, latency: s.latency,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      lastError: s.lastError ? new Date(s.lastError).toISOString() : null,
      errorCount: s.errorCount,
      sinceLastSuccess: s.lastSuccess ? Math.round((now - s.lastSuccess) / 1000) : null,
      ...Object.fromEntries(Object.entries(s).filter(([k]) => !["status", "latency", "lastSuccess", "lastError", "errorCount"].includes(k))),
    };
  };
  res.json({
    status: Object.values(serviceHealth).every(s => s.status === "ok") ? "healthy" :
      Object.values(serviceHealth).some(s => s.status === "down") ? "degraded" : "partial",
    uptime: Math.round(process.uptime()),
    tokens: tokenStore.length, scans: scanCount,
    lastScan: lastScan ? new Date(lastScan).toISOString() : null,
    sinceLastScan: lastScan ? Math.round((now - lastScan) / 1000) : null,
    services: {
      dexscreener: formatService("dexscreener"), rugcheck: formatService("rugcheck"),
      jupiter: formatService("jupiter"), discord: formatService("discord"),
      groq: formatService("groq"), trends: formatService("trends"),
    },
  });
});

app.get("/api/ping", (req, res) => {
  res.json({ pong: true, time: new Date().toISOString(), tokens: tokenStore.length });
});

// ─── START ───
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Scan interval: ${SCAN_INTERVAL}ms`);
  console.log(`Discord: ${DISCORD_WEBHOOK ? "configured" : "not configured"}`);
  console.log(`Groq: ${GROQ_API_KEY ? "configured" : "not configured"}`);
  console.log(`Helius: ${HELIUS_KEY ? "configured" : "not configured"}`);

  refreshTrends();
  scanOnce();
  setInterval(scanOnce, SCAN_INTERVAL);
  setInterval(refreshTrends, 15 * 60 * 1000);
});

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

// ─── FEATURE 5: SMART MONEY STORE ───
const smartMoneyStore = {
  knownWallets: new Map(), // wallet -> { pnl, wins, trades, label, lastSeen }
  walletActivity: new Map(), // tokenAddress -> [{ wallet, amount, timestamp, isKnown, label }]
  lastRefresh: null,
};

// ─── FEATURE 4: EARLY PUMP TRACKING ───
const volumeHistory = new Map(); // tokenAddress -> [{ vol5m, timestamp }]

// ─── BACKTESTING LOGGER ───
const backtestLog = []; // { address, symbol, timestamp, safety, potential, probability, price, mcap, earlyPump, smartMoney }
const BACKTEST_MAX = 500;

function logForBacktest(token) {
  backtestLog.push({
    address: token.address,
    symbol: token.symbol,
    timestamp: Date.now(),
    safety: token.safety,
    potential: token.potential,
    probability: token.return_proba?.probability || 0,
    expectedGain: token.return_proba?.expectedGain || 0,
    horizon: token.return_proba?.horizon || "?",
    price: token.price,
    mcap: token.market_cap,
    liq: token.liquidity,
    earlyPump: token.early_pump_score || 0,
    smartMoney: token.smart_money?.score || 0,
    trendMatch: token.trend_match?.term || null,
    socialScore: token.social_score || 0,
    aiVerdict: token.ai_analysis?.verdict || null,
    aiConfirmation: token.ai_analysis?.score_confirmation || null,
    change_1h: token.change_1h,
    change_24h: token.change_24h,
    // These will be filled later by the backtest checker
    price_4h_later: null,
    price_24h_later: null,
    result_4h: null, // "win" | "loss" | "pending"
    result_24h: null,
  });
  if (backtestLog.length > BACKTEST_MAX) backtestLog.splice(0, backtestLog.length - BACKTEST_MAX);
}

// Check backtest results: compare logged prices with current prices
function checkBacktestResults() {
  const now = Date.now();
  for (const entry of backtestLog) {
    const ageMs = now - entry.timestamp;
    const token = tokenStore.find(t => t.address === entry.address);
    if (!token) continue;
    if (!entry.price_4h_later && ageMs >= 4 * 60 * 60 * 1000) {
      entry.price_4h_later = token.price;
      const change = ((token.price - entry.price) / Math.max(entry.price, 0.0000001)) * 100;
      entry.result_4h = change > 10 ? "win" : change < -20 ? "loss" : "flat";
    }
    if (!entry.price_24h_later && ageMs >= 24 * 60 * 60 * 1000) {
      entry.price_24h_later = token.price;
      const change = ((token.price - entry.price) / Math.max(entry.price, 0.0000001)) * 100;
      entry.result_24h = change > 20 ? "win" : change < -30 ? "loss" : "flat";
    }
  }
}

// ─── PAPER TRADING MODULE ───
// Realistic simulation: USD -> SOL -> Token with fees, slippage, and live price updates

const SOL_PRICE_CACHE = { price: 150, lastFetch: 0 }; // SOL/USD cache

async function fetchSolPrice() {
  if (Date.now() - SOL_PRICE_CACHE.lastFetch < 60000) return SOL_PRICE_CACHE.price;
  try {
    const res = await fetchWithTimeout("https://api.dexscreener.com/latest/dex/search?q=SOL%20USDC", 5000);
    if (res.ok) {
      const data = await res.json();
      const solPair = (data.pairs || []).find(p => p.chainId === "solana" && p.baseToken?.symbol === "SOL" && p.quoteToken?.symbol === "USDC");
      if (solPair) { SOL_PRICE_CACHE.price = parseFloat(solPair.priceUsd || 150); SOL_PRICE_CACHE.lastFetch = Date.now(); }
    }
  } catch {}
  return SOL_PRICE_CACHE.price;
}

// Fee structure (realistic Solana memecoin trading)
const FEES = {
  SOL_TX_FEE: 0.000005,       // SOL network fee per tx (~0.000005 SOL)
  PHANTOM_PRIORITY: 0.0001,   // Phantom priority fee
  RAYDIUM_FEE_PCT: 0.25,      // Raydium/PumpSwap LP fee 0.25%
  DEFAULT_BUY_SLIPPAGE: 2.0,  // Default buy slippage % if not measured
  DEFAULT_SELL_SLIPPAGE: 3.0,  // Default sell slippage % (sells usually worse)
};

const paperPortfolio = {
  balance_usd: 1000,           // Starting paper balance
  initial_balance: 1000,
  positions: [],               // Active positions
  history: [],                 // Closed trades
  trade_count: 0,
};

function calcBuyFees(amountUsd, token, solPrice) {
  const solAmount = amountUsd / solPrice;
  const solAfterTxFee = solAmount - FEES.SOL_TX_FEE - FEES.PHANTOM_PRIORITY;
  const solAfterLpFee = solAfterTxFee * (1 - FEES.RAYDIUM_FEE_PCT / 100);
  const buySlippage = (token.buy_slippage != null && token.buy_slippage > 0) ? token.buy_slippage : FEES.DEFAULT_BUY_SLIPPAGE;
  const solAfterSlippage = solAfterLpFee * (1 - buySlippage / 100);
  const usdAfterFees = solAfterSlippage * solPrice;
  const tokensReceived = usdAfterFees / Math.max(token.price, 0.0000000001);
  const totalFeesUsd = amountUsd - usdAfterFees;
  const totalFeePct = (totalFeesUsd / amountUsd) * 100;

  return {
    sol_spent: solAmount,
    sol_after_fees: solAfterSlippage,
    usd_after_fees: usdAfterFees,
    tokens_received: tokensReceived,
    total_fees_usd: totalFeesUsd,
    total_fee_pct: totalFeePct,
    breakdown: {
      network_fee: (FEES.SOL_TX_FEE + FEES.PHANTOM_PRIORITY) * solPrice,
      lp_fee: (solAfterTxFee - solAfterLpFee) * solPrice,
      slippage: (solAfterLpFee - solAfterSlippage) * solPrice,
      slippage_pct: buySlippage,
    },
  };
}

function calcSellFees(tokensToSell, token, solPrice) {
  const grossUsd = tokensToSell * token.price;
  const sellSlippage = (token.sell_slippage != null && token.sell_slippage > 0) ? token.sell_slippage : FEES.DEFAULT_SELL_SLIPPAGE;
  const sellTax = (token.sell_tax != null && token.sell_tax > 0) ? token.sell_tax : 0;
  const afterSlippage = grossUsd * (1 - sellSlippage / 100);
  const afterTax = afterSlippage * (1 - sellTax / 100);
  const afterLpFee = afterTax * (1 - FEES.RAYDIUM_FEE_PCT / 100);
  const solReceived = afterLpFee / solPrice;
  const solAfterTxFee = solReceived - FEES.SOL_TX_FEE - FEES.PHANTOM_PRIORITY;
  const netUsd = solAfterTxFee * solPrice;
  const totalFeesUsd = grossUsd - netUsd;
  const totalFeePct = grossUsd > 0 ? (totalFeesUsd / grossUsd) * 100 : 0;

  return {
    gross_usd: grossUsd,
    net_usd: Math.max(netUsd, 0),
    sol_received: Math.max(solAfterTxFee, 0),
    total_fees_usd: totalFeesUsd,
    total_fee_pct: totalFeePct,
    breakdown: {
      slippage: grossUsd - afterSlippage,
      slippage_pct: sellSlippage,
      sell_tax: afterSlippage - afterTax,
      sell_tax_pct: sellTax,
      lp_fee: afterTax - afterLpFee,
      network_fee: (FEES.SOL_TX_FEE + FEES.PHANTOM_PRIORITY) * solPrice,
    },
  };
}

// Update all open positions with current prices (called each scan)
function updatePaperPositions() {
  for (const pos of paperPortfolio.positions) {
    const token = tokenStore.find(t => t.address === pos.address);
    if (token) {
      pos.current_price = token.price;
      pos.current_value = pos.tokens * token.price;
      pos.pnl_usd = pos.current_value - pos.cost_basis;
      pos.pnl_pct = pos.cost_basis > 0 ? ((pos.current_value - pos.cost_basis) / pos.cost_basis) * 100 : 0;
      pos.safety = token.safety;
      pos.last_update = Date.now();
      // Track ATH for this position
      if (pos.current_value > (pos.ath_value || 0)) {
        pos.ath_value = pos.current_value;
        pos.ath_price = token.price;
      }
      // Drawdown from ATH
      pos.drawdown_from_ath = pos.ath_value > 0 ? ((pos.ath_value - pos.current_value) / pos.ath_value) * 100 : 0;
    }
  }
}

function calcPortfolioStats() {
  const positions = paperPortfolio.positions;
  const totalValue = positions.reduce((s, p) => s + (p.current_value || 0), 0);
  const totalCost = positions.reduce((s, p) => s + (p.cost_basis || 0), 0);
  const totalPnl = totalValue - totalCost;
  const closedPnl = paperPortfolio.history.reduce((s, h) => s + (h.pnl_usd || 0), 0);
  const totalFeesPaid = paperPortfolio.history.reduce((s, h) => s + (h.total_fees || 0), 0)
    + positions.reduce((s, p) => s + (p.buy_fees || 0), 0);
  const wins = paperPortfolio.history.filter(h => h.pnl_usd > 0).length;
  const losses = paperPortfolio.history.filter(h => h.pnl_usd <= 0).length;

  return {
    balance_usd: paperPortfolio.balance_usd,
    portfolio_value: totalValue,
    total_equity: paperPortfolio.balance_usd + totalValue,
    initial_balance: paperPortfolio.initial_balance,
    total_return_pct: ((paperPortfolio.balance_usd + totalValue - paperPortfolio.initial_balance) / paperPortfolio.initial_balance) * 100,
    open_positions: positions.length,
    open_pnl: totalPnl,
    closed_pnl: closedPnl,
    total_fees_paid: totalFeesPaid,
    trades_total: paperPortfolio.trade_count,
    wins, losses,
    win_rate: wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
    avg_win: wins > 0 ? paperPortfolio.history.filter(h => h.pnl_usd > 0).reduce((s, h) => s + h.pnl_usd, 0) / wins : 0,
    avg_loss: losses > 0 ? paperPortfolio.history.filter(h => h.pnl_usd <= 0).reduce((s, h) => s + h.pnl_usd, 0) / losses : 0,
  };
}

// ─── SERVICE HEALTH ───
const serviceHealth = {
  dexscreener: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, pairsReturned: 0 },
  rugcheck: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  jupiter: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, checksCompleted: 0 },
  discord: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, alertsSent: 0 },
  groq: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, analysesCompleted: 0 },
  trends: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, termsTracked: 0 },
  helius: { status: "unknown", lastSuccess: null, lastError: null, errorCount: 0, latency: 0, queriesCompleted: 0 },
};

function updateServiceHealth(service, success, latencyMs, extra = {}) {
  const s = serviceHealth[service];
  if (!s) return;
  s.latency = latencyMs;
  if (success) {
    s.status = "ok"; s.lastSuccess = Date.now(); s.errorCount = 0; Object.assign(s, extra);
  } else {
    s.errorCount++; s.lastError = Date.now();
    s.status = s.errorCount >= 3 ? "down" : "degraded"; Object.assign(s, extra);
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

  if (token.change_24h < -50) { checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% dump" }; penalties += 15; }
  else if (token.change_24h < -30) { checks.post_pump = { pass: false, value: token.change_24h.toFixed(0) + "% decline" }; penalties += 8; }
  if (token.change_1h < -30) { checks.dumping_1h = { pass: false, value: token.change_1h.toFixed(0) + "% 1h" }; penalties += 10; }

  // Very young token penalty (< 30 min = highest risk)
  if (token.age_hours < 0.5) {
    checks.very_new = { pass: false, value: Math.round(token.age_hours * 60) + "min" };
    penalties += 5;
  }

  if (token.rugcheck) {
    const rc = token.rugcheck;
    const mintOk = !rc.mintEnabled; const freezeOk = !rc.freezeEnabled;
    const lpOk = rc.lpBurned || rc.lpLocked;
    checks.mint = { pass: mintOk, value: rc.mintEnabled ? "ENABLED" : "disabled" };
    checks.freeze = { pass: freezeOk, value: rc.freezeEnabled ? "ENABLED" : "disabled" };
    checks.lp_lock = { pass: lpOk, value: rc.lpBurned ? "burned" : rc.lpLocked ? "locked" : "UNLOCKED" };
    if (mintOk) score += 10; if (freezeOk) score += 8; if (lpOk) score += 10;
    if (!lpOk) penalties += 10; if (!mintOk) penalties += 8;
  } else { checks.contract = { pass: false, value: "pending scan" }; }

  if (token.jupiter && !token.jupiter.error) {
    if (token.buy_slippage !== null && token.buy_slippage !== undefined) {
      checks.buy_slippage = { pass: token.buy_slippage < 5, value: token.buy_slippage.toFixed(1) + "%" };
      if (token.buy_slippage > 15) penalties += 10; else if (token.buy_slippage > 10) penalties += 5;
    }
    if (token.sell_slippage !== null && token.sell_slippage !== undefined) {
      checks.sell_slippage = { pass: token.sell_slippage < 8, value: token.sell_slippage.toFixed(1) + "%" };
      if (token.sell_slippage > 20) penalties += 12; else if (token.sell_slippage > 10) penalties += 6;
    }
    if (token.sell_tax !== null && token.sell_tax !== undefined) {
      checks.sell_tax = { pass: token.sell_tax < 8, value: token.sell_tax.toFixed(1) + "%" };
      if (token.sell_tax > 30) penalties += 30; else if (token.sell_tax > 15) penalties += 20; else if (token.sell_tax > 8) penalties += 8;
    }
    if (token.honeypot_detected) { checks.honeypot = { pass: false, value: "HONEYPOT" }; penalties += 40; }
  }

  // Feature 6: Social presence bonus
  if (token.social_score) {
    if (token.social_score >= 60) { score += 5; checks.social = { pass: true, value: "Score " + token.social_score }; }
    else if (token.social_score >= 30) { score += 2; checks.social = { pass: true, value: "Score " + token.social_score }; }
    else { checks.social = { pass: false, value: "Score " + token.social_score }; }
  }

  // Holders bonus (when data available)
  if (token.holders > 0) {
    checks.holders = { pass: token.holders >= 100, value: token.holders.toLocaleString() };
    if (token.holders >= 500) score += 5;
    else if (token.holders >= 100) score += 3;
    else if (token.holders < 20 && token.age_hours > 1) penalties += 3;
  }

  const finalScore = Math.max(Math.min(score - penalties, 100), 0);
  return { score: finalScore, checks };
}

// ─── RETURN PROBABILITY ───
function calcReturnProba(token) {
  let rawScore = 0;

  const vmRatio = token.volume_24h / Math.max(token.market_cap, 1);
  if (vmRatio > 5) rawScore += 20; else if (vmRatio > 2) rawScore += 16;
  else if (vmRatio > 1) rawScore += 12; else if (vmRatio > 0.5) rawScore += 6;

  if (token.buys + token.sells > 10) {
    const buyRatio = token.buys / Math.max(token.buys + token.sells, 1);
    if (buyRatio > 0.75) rawScore += 15; else if (buyRatio > 0.65) rawScore += 12;
    else if (buyRatio > 0.55) rawScore += 8; else rawScore += 3;
  }

  if (token.buys_1h + token.sells_1h > 3) {
    const ratio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    if (ratio1h > 0.75) rawScore += 15; else if (ratio1h > 0.6) rawScore += 10; else if (ratio1h > 0.5) rawScore += 5;
  }

  if (token.market_cap < 50000) rawScore += 15; else if (token.market_cap < 200000) rawScore += 12;
  else if (token.market_cap < 500000) rawScore += 8; else if (token.market_cap < 1000000) rawScore += 4;
  // MCap ceiling: big caps have less x2 potential
  if (token.market_cap > 10000000) rawScore = Math.max(rawScore - 10, 0);
  else if (token.market_cap > 5000000) rawScore = Math.max(rawScore - 5, 0);

  // 1h momentum: moderate gains are better signals than extreme pumps
  if (token.change_1h > 10 && token.change_1h <= 50) rawScore += 15;
  else if (token.change_1h > 50 && token.change_1h <= 150) rawScore += 10; // already pumped, less upside
  else if (token.change_1h > 150) rawScore += 3; // likely post-pump
  else if (token.change_1h > 0) rawScore += 5;

  if (token.change_5m > 20 && token.change_5m < 200) rawScore += 10; else if (token.change_5m > 5) rawScore += 6;

  const liqMcapRatio = token.liquidity / Math.max(token.market_cap, 1);
  if (liqMcapRatio > 0.1 && liqMcapRatio < 0.5) rawScore += 10; else if (liqMcapRatio > 0.05) rawScore += 5;

  if (token.change_24h < -50) rawScore = Math.max(rawScore - 30, 0);
  else if (token.change_24h < -30) rawScore = Math.max(rawScore - 15, 0);
  if (token.change_1h < -20) rawScore = Math.max(rawScore - 20, 0);
  if (token.volume_24h / Math.max(token.liquidity, 1) > 100) rawScore = Math.max(rawScore - 15, 0);
  if (token.staircase_detected) rawScore = Math.max(rawScore - 30, 0);
  if (token.rugcheck && !token.rugcheck.lpBurned && !token.rugcheck.lpLocked) rawScore = Math.max(rawScore - 10, 0);
  if (token.sell_tax > 15) rawScore = Math.max(rawScore - 40, 0);
  else if (token.sell_tax > 8) rawScore = Math.max(rawScore - 12, 0);
  if (token.honeypot_detected) rawScore = 0;

  rawScore = Math.min(rawScore, 100);
  if (token.trend_match) rawScore = Math.min(rawScore + 10, 100);

  // Feature 4: early pump boost
  if (token.early_pump_score >= 70) rawScore = Math.min(rawScore + 15, 100);
  else if (token.early_pump_score >= 40) rawScore = Math.min(rawScore + 8, 100);

  // Feature 5: smart money boost
  if (token.smart_money && token.smart_money.score >= 60) rawScore = Math.min(rawScore + 12, 100);
  else if (token.smart_money && token.smart_money.score >= 30) rawScore = Math.min(rawScore + 5, 100);

  // Steeper sigmoid (0.12 vs 0.08) for better mid-range differentiation
  const sigmoid = (x) => 1 / (1 + Math.exp(-0.12 * (x - 50)));
  const probability = Math.round(5 + sigmoid(rawScore) * 80);

  let expectedGain;
  if (token.market_cap < 30000) expectedGain = 300;
  else if (token.market_cap < 100000) expectedGain = 150;
  else if (token.market_cap < 500000) expectedGain = 80;
  else if (token.market_cap < 2000000) expectedGain = 40;
  else expectedGain = 15;

  if (token.change_24h < -30) expectedGain = Math.round(expectedGain * 0.3);
  if (token.sell_tax > 8) expectedGain = Math.round(expectedGain * 0.5);
  if (token.staircase_detected) expectedGain = Math.round(expectedGain * 0.2);

  // Dynamic horizon based on volatility + age + volume pace
  let horizon;
  const absVol1h = Math.abs(token.change_1h || 0);
  const absVol5m = Math.abs(token.change_5m || 0);
  const volatility = absVol1h + absVol5m * 3; // 5m weighted more (recent action)
  const volPace = token.volume_1h / Math.max(token.market_cap, 1); // how fast money flows

  if (token.age_hours < 1 && volatility > 50) horizon = "30min-1h";
  else if (token.age_hours < 2 && volatility > 30) horizon = "1-2h";
  else if (token.age_hours < 6 && volPace > 0.5) horizon = "2-4h";
  else if (token.age_hours < 6) horizon = "4-6h";
  else if (token.age_hours < 24 && volatility > 20) horizon = "6-12h";
  else if (token.age_hours < 24) horizon = "12-24h";
  else if (volatility > 15) horizon = "1-2j";
  else horizon = "2-5j";

  const factors = {
    vol_mcap: vmRatio.toFixed(2) + "x",
    buy_pressure_24h: token.buys + token.sells > 10 ? ((token.buys / (token.buys + token.sells)) * 100).toFixed(0) + "%" : "N/A",
    buy_pressure_1h: token.buys_1h + token.sells_1h > 3 ? ((token.buys_1h / (token.buys_1h + token.sells_1h)) * 100).toFixed(0) + "%" : "N/A",
    mcap_room: "$" + formatNum(token.market_cap),
    momentum_1h: (token.change_1h >= 0 ? "+" : "") + token.change_1h.toFixed(1) + "%",
    momentum_5m: (token.change_5m >= 0 ? "+" : "") + token.change_5m.toFixed(1) + "%",
    liq_mcap: liqMcapRatio.toFixed(3),
    early_pump: token.early_pump_score || 0,
    smart_money: token.smart_money?.score || 0,
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
    if (change < 0.02) flat++; else if (change > 0.3) jump++; total++;
  }
  let pullbacks = 0;
  for (let i = 2; i < priceHistory.length; i++) {
    if (priceHistory[i] < priceHistory[i - 1] && priceHistory[i - 1] < priceHistory[i - 2]) pullbacks++;
  }
  const flatRatio = flat / total; const jumpRatio = jump / total;
  const pullbackRatio = pullbacks / (priceHistory.length - 2);
  const detected = flatRatio > 0.35 && jumpRatio > 0.15 && pullbackRatio < 0.08;
  const confidence = detected
    ? Math.min(Math.round(flatRatio * 40 + jumpRatio * 40 + (1 - pullbackRatio) * 20), 99)
    : Math.round(Math.max(0, flatRatio * 30 + jumpRatio * 20 - pullbackRatio * 50));
  return { detected, confidence };
}

// ─── FEATURE 4: EARLY PUMP DETECTOR ───
function calcEarlyPumpScore(token, existing) {
  let score = 0;
  const signals = [];

  // Signal 1: Volume spike (vol 5m compared to token age expectations)
  // Young token (< 4h) with high volume relative to mcap = accumulation phase
  if (token.age_hours < 4 && token.volume_1h > 0) {
    const volMcap1h = token.volume_1h / Math.max(token.market_cap, 1);
    if (volMcap1h > 2) { score += 25; signals.push("Vol 1h > 2x MCap"); }
    else if (volMcap1h > 1) { score += 18; signals.push("Vol 1h > MCap"); }
    else if (volMcap1h > 0.5) { score += 10; signals.push("Vol 1h > 50% MCap"); }
  }

  // Signal 2: 5m momentum spike on young token
  if (token.age_hours < 6 && token.change_5m > 15 && token.change_5m < 300) {
    score += 20;
    signals.push("+5m " + token.change_5m.toFixed(0) + "%");
  } else if (token.change_5m > 30 && token.change_5m < 500) {
    score += 12;
    signals.push("+5m " + token.change_5m.toFixed(0) + "%");
  }

  // Signal 3: Buy pressure > 80% in 1h with significant volume
  if (token.buys_1h + token.sells_1h > 10) {
    const buyRatio1h = token.buys_1h / (token.buys_1h + token.sells_1h);
    if (buyRatio1h > 0.8) { score += 20; signals.push("Buy 1h " + (buyRatio1h * 100).toFixed(0) + "%"); }
    else if (buyRatio1h > 0.7) { score += 12; signals.push("Buy 1h " + (buyRatio1h * 100).toFixed(0) + "%"); }
  }

  // Signal 4: Liquidity healthy for young token
  if (token.age_hours < 4 && token.liquidity >= 30000) {
    score += 10;
    signals.push("Liq $" + formatNum(token.liquidity));
  } else if (token.age_hours < 12 && token.liquidity >= 50000) {
    score += 8;
    signals.push("Liq $" + formatNum(token.liquidity));
  }

  // Signal 5: Holder velocity (holders gained since last scan)
  if (existing && existing.holders > 0 && token.holders > 0) {
    const holderGain = token.holders - existing.holders;
    const timeDiffH = Math.max((Date.now() - existing.scanned_at) / (1000 * 60 * 60), 0.01);
    const holdersPerHour = holderGain / timeDiffH;
    if (holdersPerHour > 500) { score += 15; signals.push("+" + Math.round(holdersPerHour) + " holders/h"); }
    else if (holdersPerHour > 100) { score += 10; signals.push("+" + Math.round(holdersPerHour) + " holders/h"); }
    else if (holdersPerHour > 30) { score += 5; signals.push("+" + Math.round(holdersPerHour) + " holders/h"); }
  }

  // Signal 6: Volume acceleration (vol 1h vs vol 6h pace)
  if (token.volume_6h > 0 && token.volume_1h > 0) {
    const avgHourly6h = token.volume_6h / 6;
    const volAccel = token.volume_1h / Math.max(avgHourly6h, 1);
    if (volAccel > 5) { score += 15; signals.push("Vol accel " + volAccel.toFixed(1) + "x"); }
    else if (volAccel > 3) { score += 10; signals.push("Vol accel " + volAccel.toFixed(1) + "x"); }
    else if (volAccel > 2) { score += 5; signals.push("Vol accel " + volAccel.toFixed(1) + "x"); }
  }

  // Signal 7: Boosted on DEX Screener (detected in pair data)
  if (token.boosted) {
    score += 10;
    signals.push("DEX Boost active");
  }

  // Penalties
  if (token.change_1h < -15) { score = Math.max(score - 20, 0); signals.push("Dumping -" + Math.abs(token.change_1h).toFixed(0) + "%"); }
  if (token.honeypot_detected) { score = 0; }
  if (token.staircase_detected) { score = Math.max(score - 25, 0); }

  return { score: Math.min(score, 100), signals };
}

// ─── FEATURE 5: SMART MONEY TRACKER VIA HELIUS ───
async function fetchTopHolders(tokenMint) {
  if (!HELIUS_KEY) return null;
  const t0 = Date.now();
  try {
    // Helius DAS API: get token largest accounts
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_KEY}`;
    // Use getTokenLargestAccounts via RPC
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [tokenMint],
      }),
    });

    const latency = Date.now() - t0;
    if (!res.ok) {
      updateServiceHealth("helius", false, latency);
      return null;
    }

    const data = await res.json();
    const accounts = data.result?.value || [];
    serviceHealth.helius.queriesCompleted = (serviceHealth.helius.queriesCompleted || 0) + 1;
    updateServiceHealth("helius", true, latency);

    return accounts.map(a => ({
      address: a.address,
      amount: parseFloat(a.uiAmount || a.amount || 0),
      pct: 0, // will be calculated
    }));
  } catch (err) {
    updateServiceHealth("helius", false, Date.now() - t0);
    console.error("Helius top holders error:", err.message);
    return null;
  }
}

async function fetchRecentBuyers(tokenMint) {
  if (!HELIUS_KEY) return [];
  const t0 = Date.now();
  try {
    // Helius enhanced transactions API: get recent transfers for this token
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${HELIUS_KEY}&type=SWAP&limit=20`;
    const res = await fetch(url);
    const latency = Date.now() - t0;

    if (!res.ok) {
      updateServiceHealth("helius", false, latency);
      return [];
    }

    const txns = await res.json();
    serviceHealth.helius.queriesCompleted = (serviceHealth.helius.queriesCompleted || 0) + 1;
    updateServiceHealth("helius", true, latency);

    const buyers = [];
    for (const tx of (txns || [])) {
      // Parse swap transactions: look for wallets buying this token
      const desc = tx.description || "";
      const feePayer = tx.feePayer || "";
      const tokenTransfers = tx.tokenTransfers || [];

      for (const transfer of tokenTransfers) {
        if (transfer.mint === tokenMint && transfer.toUserAccount) {
          buyers.push({
            wallet: transfer.toUserAccount,
            amount: transfer.tokenAmount || 0,
            timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
            feePayer,
          });
        }
      }
    }
    return buyers;
  } catch (err) {
    updateServiceHealth("helius", false, Date.now() - t0);
    console.error("Helius recent buyers error:", err.message);
    return [];
  }
}

// Build smart money profile with REPUTATION system
// Wallets are tracked with wins AND losses. A wallet present on rugged tokens gets flagged.
function calcSmartMoneyScore(token, recentBuyers) {
  let score = 0;
  const signals = [];
  const knownBuyers = [];
  const toxicBuyers = [];

  if (!recentBuyers || recentBuyers.length === 0) {
    return { score: 0, signals: ["No buyer data"], knownBuyers: [], toxicBuyers: [], trustLevel: "unknown" };
  }

  // Check each buyer against known wallets
  for (const buyer of recentBuyers) {
    const known = smartMoneyStore.knownWallets.get(buyer.wallet);
    if (known) {
      const walletInfo = {
        wallet: buyer.wallet.slice(0, 4) + "..." + buyer.wallet.slice(-4),
        label: known.label,
        pnl: known.pnl,
        wins: known.wins,
        losses: known.losses || 0,
        trades: known.trades,
        reputation: known.reputation || 0,
        amount: buyer.amount,
      };

      // Reputation check: positive rep = legit, negative = toxic
      if (known.reputation < -2 || known.label === "rug_associated" || known.label === "dump_wallet") {
        toxicBuyers.push(walletInfo);
      } else if (known.reputation >= 2 || known.wins >= 3) {
        knownBuyers.push(walletInfo);
      } else {
        // Neutral wallet, count as basic buyer
        knownBuyers.push(walletInfo);
      }
    }
  }

  // TOXIC WALLETS = BIG RED FLAG
  if (toxicBuyers.length >= 2) {
    score -= 30;
    signals.push("⚠ " + toxicBuyers.length + " wallets toxiques detectes");
  } else if (toxicBuyers.length === 1) {
    score -= 15;
    signals.push("⚠ 1 wallet toxique detecte");
  }

  // Legit known wallets (positive reputation only)
  const legitBuyers = knownBuyers.filter(b => (b.reputation || 0) >= 0 && b.wins > b.losses);
  if (legitBuyers.length >= 3) { score += 35; signals.push(legitBuyers.length + " wallets confirmes"); }
  else if (legitBuyers.length >= 2) { score += 25; signals.push(legitBuyers.length + " wallets confirmes"); }
  else if (legitBuyers.length >= 1) { score += 15; signals.push("1 wallet confirme"); }

  // Win rate of known wallets matters
  const totalWins = legitBuyers.reduce((s, b) => s + (b.wins || 0), 0);
  const totalLosses = legitBuyers.reduce((s, b) => s + (b.losses || 0), 0);
  if (totalWins + totalLosses > 0) {
    const winRate = totalWins / (totalWins + totalLosses);
    if (winRate >= 0.7) { score += 15; signals.push("Win rate " + Math.round(winRate * 100) + "%"); }
    else if (winRate >= 0.5) { score += 8; signals.push("Win rate " + Math.round(winRate * 100) + "%"); }
    else { score -= 5; signals.push("Win rate faible " + Math.round(winRate * 100) + "%"); }
  }

  // Unique organic buyers
  const uniqueBuyers = new Set(recentBuyers.map(b => b.wallet)).size;
  if (uniqueBuyers >= 15) { score += 15; signals.push(uniqueBuyers + " buyers uniques"); }
  else if (uniqueBuyers >= 8) { score += 10; signals.push(uniqueBuyers + " buyers uniques"); }
  else if (uniqueBuyers >= 3) { score += 5; }

  // Concentration check: if top 3 wallets hold > 80% of buys, suspicious
  const buyerAmounts = recentBuyers.reduce((map, b) => { map.set(b.wallet, (map.get(b.wallet) || 0) + (b.amount || 0)); return map; }, new Map());
  const sortedAmounts = [...buyerAmounts.values()].sort((a, b) => b - a);
  const totalAmount = sortedAmounts.reduce((s, v) => s + v, 0);
  if (sortedAmounts.length >= 3 && totalAmount > 0) {
    const top3Pct = (sortedAmounts[0] + sortedAmounts[1] + sortedAmounts[2]) / totalAmount;
    if (top3Pct > 0.8) { score -= 10; signals.push("Top 3 = " + Math.round(top3Pct * 100) + "% (concentre)"); }
  }

  // Recent activity
  const recentCount = recentBuyers.filter(b => Date.now() - b.timestamp < 5 * 60 * 1000).length;
  if (recentCount >= 5) { score += 10; signals.push(recentCount + " buys en 5min"); }

  // Trust level
  let trustLevel = "neutral";
  if (toxicBuyers.length >= 2) trustLevel = "suspect";
  else if (toxicBuyers.length === 1 && legitBuyers.length < 2) trustLevel = "suspect";
  else if (legitBuyers.length >= 3) trustLevel = "high";
  else if (legitBuyers.length >= 1) trustLevel = "moderate";

  return { score: Math.max(Math.min(score, 100), 0), signals, knownBuyers, toxicBuyers, trustLevel };
}

// Periodically discover top performing wallets AND flag rug wallets
async function refreshSmartMoneyWallets() {
  if (!HELIUS_KEY) return;
  console.log("[Smart Money] Refreshing wallet database...");

  // WINNERS: tokens that went up significantly
  const winners = tokenStore
    .filter(t => t.safety >= 60 && t.change_24h > 50)
    .sort((a, b) => b.change_24h - a.change_24h)
    .slice(0, 5);

  for (const token of winners) {
    try {
      const buyers = await fetchRecentBuyers(token.address);
      for (const buyer of buyers) {
        const existing = smartMoneyStore.knownWallets.get(buyer.wallet);
        if (existing) {
          existing.trades++;
          existing.wins++;
          existing.reputation = (existing.reputation || 0) + 1;
          existing.lastSeen = Date.now();
        } else {
          smartMoneyStore.knownWallets.set(buyer.wallet, {
            pnl: 0, wins: 1, losses: 0, trades: 1, label: "early_buyer",
            reputation: 1, lastSeen: Date.now(), rugsAssociated: 0,
          });
        }
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) { console.error("Smart money refresh error:", err.message); }
  }

  // LOSERS/RUGS: tokens that crashed hard (safety < 20, or honeypot, or -80% 24h)
  const rugs = tokenStore
    .filter(t => t.honeypot_detected || t.safety < 15 || t.change_24h < -80 || t.staircase_detected)
    .slice(0, 5);

  for (const token of rugs) {
    try {
      const buyers = await fetchRecentBuyers(token.address);
      for (const buyer of buyers) {
        const existing = smartMoneyStore.knownWallets.get(buyer.wallet);
        if (existing) {
          existing.losses = (existing.losses || 0) + 1;
          existing.reputation = (existing.reputation || 0) - 2; // rugs penalize harder than wins reward
          existing.rugsAssociated = (existing.rugsAssociated || 0) + 1;
          if (existing.rugsAssociated >= 3) existing.label = "rug_associated";
          else if (existing.reputation < -3) existing.label = "dump_wallet";
        } else {
          smartMoneyStore.knownWallets.set(buyer.wallet, {
            pnl: 0, wins: 0, losses: 1, trades: 1, label: "early_buyer",
            reputation: -2, lastSeen: Date.now(), rugsAssociated: 1,
          });
        }
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) { console.error("Smart money rug scan error:", err.message); }
  }

  // Update labels based on accumulated data
  for (const [wallet, data] of smartMoneyStore.knownWallets) {
    if (data.rugsAssociated >= 3) data.label = "rug_associated";
    else if (data.reputation < -3) data.label = "dump_wallet";
    else if (data.reputation >= 5 && data.wins >= 5) data.label = "whale_sniper";
    else if (data.reputation >= 3 && data.wins >= 3) data.label = "consistent_winner";
    else if (data.reputation >= 0) data.label = "early_buyer";

    // Clean old wallets (> 7 days)
    if (Date.now() - data.lastSeen > 7 * 24 * 60 * 60 * 1000) {
      smartMoneyStore.knownWallets.delete(wallet);
    }
  }

  if (smartMoneyStore.knownWallets.size > 5000) {
    const sorted = [...smartMoneyStore.knownWallets.entries()]
      .sort((a, b) => Math.abs(b[1].reputation) - Math.abs(a[1].reputation));
    smartMoneyStore.knownWallets.clear();
    for (const [k, v] of sorted.slice(0, 3000)) smartMoneyStore.knownWallets.set(k, v);
  }

  const totalWallets = smartMoneyStore.knownWallets.size;
  const toxicCount = [...smartMoneyStore.knownWallets.values()].filter(w => w.reputation < -2).length;
  smartMoneyStore.lastRefresh = Date.now();
  console.log(`[Smart Money] ${totalWallets} wallets tracked (${toxicCount} toxic)`);
}

// ─── FEATURE 6: SOCIAL PRE-CHECK ───
function calcSocialScore(token) {
  let score = 0;
  const signals = [];

  // Check if token has Twitter/X from DEX Screener data
  const socials = token.socials || [];
  const websites = token.websites || [];

  const hasTwitter = socials.some(s =>
    s.type === "twitter" || s.url?.includes("twitter.com") || s.url?.includes("x.com")
  );
  const hasTelegram = socials.some(s =>
    s.type === "telegram" || s.url?.includes("t.me") || s.url?.includes("telegram")
  );
  const hasDiscord = socials.some(s =>
    s.type === "discord" || s.url?.includes("discord")
  );
  const hasWebsite = websites.length > 0 || socials.some(s =>
    s.type === "website" || (s.url && !s.url.includes("twitter") && !s.url.includes("t.me") && !s.url.includes("discord") && !s.url.includes("x.com"))
  );

  if (hasTwitter) { score += 30; signals.push("Twitter"); }
  if (hasTelegram) { score += 15; signals.push("Telegram"); }
  if (hasDiscord) { score += 10; signals.push("Discord"); }
  if (hasWebsite) { score += 25; signals.push("Website"); }

  // No social at all = red flag for any token > 1h old
  if (!hasTwitter && !hasTelegram && !hasWebsite && token.age_hours > 1) {
    signals.push("No social presence");
  }

  // Bonus: multiple socials = more legitimate
  const socialCount = [hasTwitter, hasTelegram, hasDiscord, hasWebsite].filter(Boolean).length;
  if (socialCount >= 3) { score += 20; signals.push("Multi-platform"); }
  else if (socialCount >= 2) { score += 10; }

  return { score: Math.min(score, 100), signals, hasTwitter, hasTelegram, hasDiscord, hasWebsite };
}

// ─── TREND SCANNER (from v4) ───
async function fetchGoogleTrends() {
  const t0 = Date.now();
  try {
    const url = "https://trends.google.com/trending/rss?geo=US";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BLOOM/1.0)" } });
    if (!res.ok) return await fetchGoogleTrendsFallback();
    const text = await res.text();
    const terms = [];
    for (const match of text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)) {
      const term = match[1].trim().toLowerCase();
      if (term && term !== "daily search trends" && term.length > 1 && term.length < 50) terms.push(term);
    }
    for (const match of text.matchAll(/<title>([^<]+)<\/title>/g)) {
      const term = match[1].trim().toLowerCase();
      if (term && term !== "daily search trends" && term.length > 1 && term.length < 50 && !terms.includes(term)) terms.push(term);
    }
    const traffics = [];
    for (const match of text.matchAll(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/g)) traffics.push(match[1].replace(/[+,]/g, ""));
    updateServiceHealth("trends", terms.length > 0, Date.now() - t0, { termsTracked: terms.length });
    return terms.slice(0, 30).map((term, i) => ({ term, source: "google", traffic: parseInt(traffics[i]) || 0 }));
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
        const res = await fetch(`https://trends.google.com/trends/api/autocomplete/${encodeURIComponent(seed)}?hl=en-US`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BLOOM/1.0)" } });
        if (res.ok) {
          const text = await res.text();
          try { const data = JSON.parse(text.replace(/^\)]\}'\n/, "")); if (data.default?.topics) { for (const topic of data.default.topics) { if (topic.title) allTerms.push({ term: topic.title.toLowerCase(), source: "google-ac", traffic: 0 }); } } } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
      } catch {}
    }
    return allTerms;
  } catch { return []; }
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
    if (existing) { existing.score = Math.min(existing.score + 10, 100); existing.lastSeen = now; }
    else { trendStore.trends.set(item.term, { term: item.term, score: 70 + Math.min(Math.floor((item.traffic || 0) / 10000), 30), addedAt: now, lastSeen: now, source: item.source, velocity: item.traffic || 0 }); }
  }
  trendStore.lastRefresh = now; trendStore.refreshCount++;
  updateServiceHealth("trends", true, 0, { termsTracked: trendStore.trends.size });
  console.log(`[Trends] Active: ${trendStore.trends.size} terms`);
}

function matchTrend(token) {
  const name = (token.name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const symbol = (token.symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let bestMatch = null, bestScore = 0;
  for (const [term, data] of trendStore.trends) {
    const termClean = term.replace(/[^a-z0-9 ]/g, "");
    let matched = false;
    if (symbol === termClean.replace(/\s+/g, "")) matched = true;
    if (!matched && termClean.length >= 3 && name.includes(termClean)) matched = true;
    if (!matched) { for (const word of termClean.split(/\s+/)) { if (word.length >= 3 && (name.includes(word) || symbol.includes(word))) { matched = true; break; } } }
    if (matched && data.score > bestScore) { bestScore = data.score; bestMatch = { term: data.term, score: data.score, source: data.source, freshness: Math.round((Date.now() - data.addedAt) / (1000 * 60)), velocity: data.velocity }; }
  }
  return bestMatch;
}

function countTokensOnTrend(trendTerm) {
  let count = 0;
  const termClean = trendTerm.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  for (const token of tokenStore) { if ((token.name || "").toLowerCase().includes(termClean) || (token.symbol || "").toLowerCase().includes(termClean)) count++; }
  return count;
}

// ─── GROQ AI ANALYSIS ───
const groqAnalysisCache = new Map();
const GROQ_CACHE_MS = 10 * 60 * 1000;
const GROQ_MODELS = [
  "llama-3.1-70b-versatile",
  "llama-3.3-70b-versatile",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
  "llama3-8b-8192",
];
let groqActiveModel = GROQ_MODELS[0];
let groqConsecutiveErrors = 0;

async function analyzeWithGroq(token) {
  if (!GROQ_API_KEY) return null;
  const cached = groqAnalysisCache.get(token.address);
  if (cached && (Date.now() - cached.timestamp) < GROQ_CACHE_MS) return cached.analysis;
  const t0 = Date.now();

  const buyRatio24 = token.buys + token.sells > 0 ? ((token.buys / (token.buys + token.sells)) * 100).toFixed(1) : "N/A";
  const buyRatio1h = token.buys_1h + token.sells_1h > 0 ? ((token.buys_1h / (token.buys_1h + token.sells_1h)) * 100).toFixed(1) : "N/A";
  const volLiq = token.liquidity > 0 ? (token.volume_24h / token.liquidity).toFixed(1) : "N/A";

  const prompt = `Tu es un analyste senior specialise memecoins Solana. Fais une analyse complete de confirmation/rejet d'achat.

=== TOKEN ===
Nom: ${token.name} (${token.symbol}) | Age: ${token.age_hours}h
Prix: $${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(8)}
MCap: $${formatNum(token.market_cap)} | Liq: $${formatNum(token.liquidity)} | Vol24h: $${formatNum(token.volume_24h)}
Vol/Liq: ${volLiq}x | Vol6h: $${formatNum(token.volume_6h)} | Vol1h: $${formatNum(token.volume_1h)}

=== PRICE ACTION ===
24h: ${token.change_24h.toFixed(1)}% | 6h: ${token.change_6h.toFixed(1)}% | 1h: ${token.change_1h.toFixed(1)}% | 5m: ${token.change_5m.toFixed(1)}%
Buys/Sells 24h: ${token.buys}/${token.sells} (${buyRatio24}%) | 1h: ${token.buys_1h}/${token.sells_1h} (${buyRatio1h}%)
Holders: ${token.holders || "?"}

=== SECURITE ===
Safety: ${token.safety}/100
Rugcheck: ${token.rugcheck ? `Mint=${token.rugcheck.mintEnabled ? "ENABLED!" : "off"}, Freeze=${token.rugcheck.freezeEnabled ? "ENABLED" : "off"}, LP=${token.rugcheck.lpBurned ? "burned" : token.rugcheck.lpLocked ? "locked" : "UNLOCKED!"}` : "N/A"}
Jupiter: BuySlip=${token.buy_slippage != null ? token.buy_slippage.toFixed(1) + "%" : "?"}, SellSlip=${token.sell_slippage != null ? token.sell_slippage.toFixed(1) + "%" : "?"}, Tax=${token.sell_tax != null ? token.sell_tax.toFixed(1) + "%" : "?"}
Honeypot: ${token.honeypot_detected ? "OUI!" : "non"} | Staircase: ${token.staircase_detected ? "OUI " + token.staircase_confidence + "%" : "non"}

=== SIGNAUX ===
${token.trend_match ? "Trend: " + token.trend_match.term + " (score " + token.trend_match.score + ", " + (token.trend_match.competition||0) + " concurrents)" : "Pas de trend"}
${token.early_pump_score ? "Early pump: " + token.early_pump_score + "/100 (" + (token.early_pump_signals||[]).join(", ") + ")" : ""}
${token.smart_money?.score ? "Smart money: " + token.smart_money.score + "/100 (" + (token.smart_money.signals||[]).join(", ") + ")" : ""}
Social: ${token.social ? token.social.score + "/100 (" + (token.social.signals||[]).join(", ") + ")" : "0"}
Retour BLOOM: ${token.return_proba ? token.return_proba.probability + "% de +" + token.return_proba.expectedGain + "% sur " + token.return_proba.horizon : "N/A"}

Reponds en JSON UNIQUEMENT (pas de markdown):
{"verdict":"ACHETER|SURVEILLER|EVITER","confiance":1,"resume":"3-4 phrases fr.","forces":["f1","f2"],"faiblesses":["r1","r2"],"risque_principal":"1 phrase","entry_zone":"condition entree","stop_loss":"niveau SL","take_profit":"objectif TP","horizon":"duree","score_confirmation":50}`;

  try {
    if (groqConsecutiveErrors >= 5) {
      if (Date.now() - (serviceHealth.groq.lastError || 0) < 5 * 60 * 1000) return null;
      groqConsecutiveErrors = 0;
    }
    let res = null;
    for (const model of [groqActiveModel, ...GROQ_MODELS.filter(m => m !== groqActiveModel)]) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({ model, messages: [{ role: "system", content: "Analyste crypto senior. JSON uniquement, pas de markdown." }, { role: "user", content: prompt }], temperature: 0.3, max_tokens: 800 }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) { if (model !== groqActiveModel) { groqActiveModel = model; console.log(`Groq -> ${model}`); } break; }
        console.error(`Groq ${model}: ${res.status}`);
        res = null;
      } catch (e) { res = null; }
    }
    const latency = Date.now() - t0;
    if (!res || !res.ok) { groqConsecutiveErrors++; updateServiceHealth("groq", false, latency); return null; }
    groqConsecutiveErrors = 0;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    let analysis;
    try { analysis = JSON.parse(content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()); } catch { console.error("Groq parse:", content.slice(0, 300)); updateServiceHealth("groq", false, latency); return null; }
    if (!analysis.verdict || !analysis.resume) return null;
    const vv = analysis.verdict.toUpperCase();
    if (vv.includes("ACHET")) analysis.verdict = "ACHETER"; else if (vv.includes("SURVEIL")) analysis.verdict = "SURVEILLER"; else analysis.verdict = "EVITER";
    analysis.confiance = Math.max(1, Math.min(10, parseInt(analysis.confiance) || 5));
    analysis.score_confirmation = Math.max(1, Math.min(100, parseInt(analysis.score_confirmation) || 50));
    if (!analysis.forces) analysis.forces = [];
    if (!analysis.faiblesses) analysis.faiblesses = [];
    serviceHealth.groq.analysesCompleted++;
    updateServiceHealth("groq", true, latency);
    groqAnalysisCache.set(token.address, { analysis, timestamp: Date.now() });
    if (groqAnalysisCache.size > 200) { const cutoff = Date.now() - GROQ_CACHE_MS; for (const [k, v2] of groqAnalysisCache) { if (v2.timestamp < cutoff) groqAnalysisCache.delete(k); } }
    return analysis;
  } catch (err) { console.error("Groq error:", err.message); updateServiceHealth("groq", false, Date.now() - t0); return null; }
}

// ─── DEX SCREENER FETCH ───
async function fetchNewPairs() {
  const allPairs = []; const startTime = Date.now(); let fetchErrors = 0;
  const queries = ["https://api.dexscreener.com/latest/dex/search?q=pump", "https://api.dexscreener.com/latest/dex/search?q=SOL%20new", "https://api.dexscreener.com/latest/dex/search?q=raydium%20solana"];

  // Parallel fetch with timeout
  const results = await Promise.allSettled(
    queries.map(url => fetchWithTimeout(url, 8000).then(r => r.ok ? r.json() : null).catch(() => null))
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value?.pairs) {
      allPairs.push(...r.value.pairs.filter(p => p.chainId === "solana"));
    } else { fetchErrors++; }
  }

  // Boosted tokens
  const boostedAddresses = new Set();
  try {
    const boostRes = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (boostRes.ok) {
      const boosts = await boostRes.json();
      const solBoosts = (boosts || []).filter(b => b.chainId === "solana").slice(0, 5);
      for (const boost of solBoosts) {
        boostedAddresses.add(boost.tokenAddress);
        try { const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${boost.tokenAddress}`); if (pairRes.ok) { const pairData = await pairRes.json(); allPairs.push(...(pairData.pairs || []).filter(p => p.chainId === "solana")); } await new Promise(r => setTimeout(r, 200)); } catch {}
      }
    }
  } catch (e) { fetchErrors++; }

  const seen = new Set(); const unique = [];
  for (const pair of allPairs) {
    const key = pair.pairAddress || pair.baseToken?.address;
    if (key && !seen.has(key)) { seen.add(key); pair._boosted = boostedAddresses.has(pair.baseToken?.address); unique.push(pair); }
  }
  unique.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
  updateServiceHealth("dexscreener", unique.length > 0, Date.now() - startTime, { pairsReturned: unique.length });
  console.log(`Fetched ${unique.length} unique Solana pairs (${Date.now() - startTime}ms, ${fetchErrors} errors)`);
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
    return { mintEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("mint")) || false, freezeEnabled: data.risks?.some(r => r.name?.toLowerCase().includes("freeze")) || false, lpBurned: data.risks?.some(r => r.name?.toLowerCase().includes("burn") && r.level === "good") || false, lpLocked: data.risks?.some(r => r.name?.toLowerCase().includes("lock") && r.level === "good") || false, score: data.score || 0, risks: data.risks || [] };
  } catch (err) { updateServiceHealth("rugcheck", false, Date.now() - t0); return null; }
}

// ─── JUPITER ───
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SIMULATE_AMOUNT_SOL = 100000000;
// Multiple endpoints: try v1 first, fallback to v6
const JUPITER_ENDPOINTS = [
  "https://api.jup.ag/swap/v1/quote",
  "https://quote-api.jup.ag/v6/quote",
  "https://api.jup.ag/quote/v1",
];
let jupiterActiveEndpoint = JUPITER_ENDPOINTS[0];
let jupiterConsecutiveErrors = 0;

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function jupiterQuote(inputMint, outputMint, amount) {
  const params = `?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=5000`;

  // Try active endpoint first
  try {
    const res = await fetchWithTimeout(jupiterActiveEndpoint + params, 8000);
    if (res.ok) { jupiterConsecutiveErrors = 0; return await res.json(); }
    // If 429 rate limit, wait and skip
    if (res.status === 429) { console.log("Jupiter rate limited, skipping"); return null; }
  } catch (err) {
    // timeout or network error on active endpoint
  }

  // Fallback: try other endpoints
  for (const ep of JUPITER_ENDPOINTS) {
    if (ep === jupiterActiveEndpoint) continue;
    try {
      const res = await fetchWithTimeout(ep + params, 8000);
      if (res.ok) {
        jupiterActiveEndpoint = ep; // switch to working endpoint
        jupiterConsecutiveErrors = 0;
        console.log(`Jupiter switched to: ${ep}`);
        return await res.json();
      }
    } catch { /* try next */ }
  }

  jupiterConsecutiveErrors++;
  return null;
}

async function checkSlippageAndTax(tokenMint) {
  const result = { buySlippage: null, sellSlippage: null, sellTax: null, honeypot: false, error: null };

  // Skip if Jupiter has been failing too much (back off)
  if (jupiterConsecutiveErrors >= 10) {
    // Reset every 5 min to retry
    result.error = "jupiter_backoff";
    return result;
  }

  const t0 = Date.now();
  try {
    const buyData = await jupiterQuote(SOL_MINT, tokenMint, SIMULATE_AMOUNT_SOL);
    if (!buyData) { result.error = "buy_quote_failed"; updateServiceHealth("jupiter", false, Date.now() - t0); return result; }
    if (!buyData.outAmount || buyData.outAmount === "0") { result.honeypot = true; result.error = "no_buy_output"; updateServiceHealth("jupiter", true, Date.now() - t0); return result; }
    result.buySlippage = Math.abs(parseFloat(buyData.priceImpactPct || 0));

    await new Promise(r => setTimeout(r, 500));

    const sellData = await jupiterQuote(tokenMint, SOL_MINT, buyData.outAmount);
    if (!sellData) { result.honeypot = true; result.error = "sell_quote_failed"; result.sellTax = 100; updateServiceHealth("jupiter", true, Date.now() - t0); return result; }
    if (!sellData.outAmount || sellData.outAmount === "0") { result.honeypot = true; result.sellTax = 100; updateServiceHealth("jupiter", true, Date.now() - t0); return result; }
    result.sellSlippage = Math.abs(parseFloat(sellData.priceImpactPct || 0));
    const solBack = parseInt(sellData.outAmount);
    result.sellTax = Math.round(Math.max(0, ((SIMULATE_AMOUNT_SOL - solBack) / SIMULATE_AMOUNT_SOL) * 100 - result.buySlippage - result.sellSlippage - 2) * 10) / 10;
    if (result.sellTax > 30) result.honeypot = true;
    updateServiceHealth("jupiter", true, Date.now() - t0);
  } catch (err) { result.error = err.message; updateServiceHealth("jupiter", false, Date.now() - t0); }
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
    volume_24h: pair.volume?.h24 || 0, volume_6h: pair.volume?.h6 || 0, volume_1h: pair.volume?.h1 || 0,
    liquidity: pair.liquidity?.usd || 0,
    change_24h: pair.priceChange?.h24 || 0, change_6h: pair.priceChange?.h6 || 0, change_1h: pair.priceChange?.h1 || 0, change_5m: pair.priceChange?.m5 || 0,
    buys: pair.txns?.h24?.buys || 0, sells: pair.txns?.h24?.sells || 0,
    buys_1h: pair.txns?.h1?.buys || 0, sells_1h: pair.txns?.h1?.sells || 0,
    holders: pair.holders || 0, holders_prev: null, top10_pct: 0,
    age_hours: Math.round(ageHours * 10) / 10,
    created_at: createdAt,
    url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
    image: pair.info?.imageUrl || null,
    websites: pair.info?.websites || [],
    socials: pair.info?.socials || [],
    boosted: pair._boosted || false,
    rugcheck: null, safety: 0, potential: 0,
    return_proba: null, trend_match: null, ai_analysis: null, ai_analysis_at: null,
    early_pump_score: 0, early_pump_signals: [],
    smart_money: null, social: null, social_score: 0,
    safety_checks: {},
    staircase_detected: false, staircase_confidence: 0,
    price_history: [], scanned_at: now,
  };
}

// ─── DISCORD ───
async function sendDiscordAlert(embed) {
  if (!DISCORD_WEBHOOK) { updateServiceHealth("discord", false, 0); return; }
  const t0 = Date.now();
  try {
    const res = await fetch(DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [embed] }) });
    const latency = Date.now() - t0; const ok = res.status >= 200 && res.status < 300;
    if (ok) serviceHealth.discord.alertsSent++;
    updateServiceHealth("discord", ok, latency);
  } catch (err) { updateServiceHealth("discord", false, Date.now() - t0); console.error("Discord error:", err.message); }
}

function formatDiscordAlert(token) {
  const safetyEmoji = token.safety >= 75 ? "🟢" : token.safety >= 50 ? "🟡" : token.safety >= 25 ? "🟠" : "🔴";
  const color = token.safety >= 75 ? 0x16a34a : token.safety >= 50 ? 0xd97706 : token.safety >= 25 ? 0xea580c : 0xdc2626;
  const lines = [];
  lines.push(`**Safety:** ${token.safety}/100`);
  if (token.return_proba) lines.push(`**Retour:** ${token.return_proba.probability}% → +${token.return_proba.expectedGain}% (${token.return_proba.horizon})`);
  lines.push(`**Price:** $${token.price < 0.0001 ? token.price.toExponential(2) : token.price.toFixed(6)}  |  **MCap:** $${formatNum(token.market_cap)}  |  **Liq:** $${formatNum(token.liquidity)}`);
  lines.push(`**Vol 24H:** $${formatNum(token.volume_24h)}  |  **Age:** ${token.age_hours}h  |  **Buys/Sells:** ${token.buys}/${token.sells}`);
  if (token.early_pump_score >= 50) lines.push(`\n🚀 **EARLY PUMP:** ${token.early_pump_score}/100 (${(token.early_pump_signals||[]).slice(0,3).join(", ")})`);
  if (token.smart_money && token.smart_money.score >= 30) lines.push(`\n🐋 **SMART MONEY:** ${token.smart_money.score}/100 (${(token.smart_money.signals||[]).slice(0,2).join(", ")})`);
  if (token.social && token.social.score >= 30) lines.push(`📱 **Social:** ${token.social.signals.join(", ")}`);
  if (token.trend_match) lines.push(`\n🔥 **TREND:** ${token.trend_match.term} (score ${token.trend_match.score})`);
  const warns = [];
  if (token.honeypot_detected) warns.push("🚫 HONEYPOT");
  if (token.sell_tax > 15) warns.push(`💀 Tax ${token.sell_tax.toFixed(1)}%`);
  else if (token.sell_tax > 0) warns.push(`⚠️ Tax ${token.sell_tax.toFixed(1)}%`);
  if (token.staircase_detected) warns.push("📊 Staircase");
  if (token.buy_slippage > 10) warns.push(`📉 Slip ${token.buy_slippage.toFixed(1)}%`);
  const contract = [];
  if (token.rugcheck) { contract.push(token.rugcheck.mintEnabled ? "❌ Mint" : "✅ Mint off"); contract.push(token.rugcheck.lpBurned ? "✅ LP burned" : token.rugcheck.lpLocked ? "✅ LP locked" : "❌ LP unlocked"); }
  if (warns.length > 0) lines.push("\n" + warns.join("  |  "));
  if (contract.length > 0) lines.push(contract.join("  |  "));
  if (token.ai_analysis) { const ai = token.ai_analysis; lines.push(`\n${ai.verdict === "ACHETER" ? "🟢" : ai.verdict === "SURVEILLER" ? "🟡" : "🔴"} **IA: ${ai.verdict}**\n${ai.resume}`); }
  lines.push(`\n[DEX Screener](${token.url || "https://dexscreener.com/solana/" + token.pair_address})  |  [rugcheck](https://rugcheck.xyz/tokens/${token.address})  |  [Solscan](https://solscan.io/token/${token.address})`);
  return { title: `${safetyEmoji} ${token.symbol} — $${formatNum(token.market_cap)} MCap`, color, description: lines.join("\n"), footer: { text: token.address }, timestamp: new Date().toISOString() };
}

function formatNum(n) { if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toString(); }

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

    // Rugcheck (max 15/scan)
    if (newTokens.length < 15) { token.rugcheck = await fetchRugcheck(token.address); await new Promise(r => setTimeout(r, 200)); }

    // Jupiter (max 6/scan, liq >= 2000, skip if in backoff)
    if (newTokens.length < 6 && token.liquidity >= 2000 && jupiterConsecutiveErrors < 10) {
      const t0 = Date.now(); const jupCheck = await checkSlippageAndTax(token.address);
      token.jupiter = jupCheck; serviceHealth.jupiter.checksCompleted++;
      updateServiceHealth("jupiter", !jupCheck.error, Date.now() - t0);
      if (jupCheck.buySlippage !== null) token.buy_slippage = jupCheck.buySlippage;
      if (jupCheck.sellSlippage !== null) token.sell_slippage = jupCheck.sellSlippage;
      if (jupCheck.sellTax !== null) token.sell_tax = jupCheck.sellTax;
      if (jupCheck.honeypot) token.honeypot_detected = true;
      await new Promise(r => setTimeout(r, 300));
    }

    // Feature 6: Social score
    const socialResult = calcSocialScore(token);
    token.social = socialResult;
    token.social_score = socialResult.score;

    // Safety scoring (includes social bonus)
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

    // Feature 4: Early pump score
    const pumpResult = calcEarlyPumpScore(token, existing);
    token.early_pump_score = pumpResult.score;
    token.early_pump_signals = pumpResult.signals;

    // Feature 5: Smart money (only for promising tokens, max 5/scan to save API calls)
    if (HELIUS_KEY && newTokens.length < 5 && token.safety >= 40 && token.liquidity >= 5000) {
      try {
        const buyers = await fetchRecentBuyers(token.address);
        token.smart_money = calcSmartMoneyScore(token, buyers);
        // Store activity for this token
        smartMoneyStore.walletActivity.set(token.address, buyers.slice(0, 20));
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.error("Smart money scan error:", err.message);
        token.smart_money = { score: 0, signals: ["Error"], knownBuyers: [] };
      }
    }

    // Feature 2: Return probability (uses early_pump and smart_money)
    const returnResult = calcReturnProba(token);
    token.return_proba = returnResult;
    token.potential = returnResult.rawScore;

    // Preserve history from existing
    if (existing) {
      token.holders_prev = existing.holders;
      token.price_history = [...(existing.price_history || []).slice(-23), token.price];
      if (existing.ai_analysis && (Date.now() - (existing.ai_analysis_at || 0)) < GROQ_CACHE_MS) { token.ai_analysis = existing.ai_analysis; token.ai_analysis_at = existing.ai_analysis_at; }
      if (!token.smart_money && existing.smart_money) token.smart_money = existing.smart_money;
    } else { token.price_history = [token.price]; }

    if (token.price_history.length >= 8) { const sc = detectStaircase(token.price_history); token.staircase_detected = sc.detected; token.staircase_confidence = sc.confidence; }

    newTokens.push(token);

    // Backtest: log scored tokens for later comparison
    if (token.safety >= 40 || token.early_pump_score >= 40) {
      logForBacktest(token);
    }

    // Groq AI (async)
    if (GROQ_API_KEY && token.safety >= 60 && token.potential >= 40 && !token.ai_analysis) {
      analyzeWithGroq(token).then(a => { if (a) { token.ai_analysis = a; token.ai_analysis_at = Date.now(); const s = tokenStore.find(t => t.address === token.address); if (s) { s.ai_analysis = a; s.ai_analysis_at = Date.now(); } } }).catch(() => {});
    }

    // Alerts
    if (token.safety >= MIN_SAFETY && token.potential >= MIN_POTENTIAL) {
      const rp = token.return_proba;
      alertLog.unshift({ id: Date.now(), time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }), type: token.safety >= 75 ? "safe" : "potential", symbol: token.symbol, message: `Safety ${token.safety}, ${rp ? rp.probability + "% → +" + rp.expectedGain + "% (" + rp.horizon + ")" : "Pot " + token.potential}. MCap $${formatNum(token.market_cap)}${token.trend_match ? " 🔥" + token.trend_match.term : ""}${token.early_pump_score >= 50 ? " 🚀" : ""}${token.smart_money?.score >= 30 ? " 🐋" : ""}`, score: token.safety });
      if (alertLog.length > 100) alertLog = alertLog.slice(0, 100);
      if (shouldAlertDiscord(token.address)) { setTimeout(async () => { const ft = tokenStore.find(t => t.address === token.address) || token; await sendDiscordAlert(formatDiscordAlert(ft)); }, 3000); }
    }

    // Early pump alert
    if (token.early_pump_score >= 60 && token.safety >= 40) {
      alertLog.unshift({ id: Date.now() + 3, time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }), type: "potential", symbol: token.symbol, message: `🚀 Early pump ${token.early_pump_score}/100: ${token.early_pump_signals.slice(0,2).join(", ")}`, score: token.safety });
    }

    // Trend alert
    if (token.trend_match && token.safety >= 50 && token.trend_match.score >= 50) {
      alertLog.unshift({ id: Date.now() + 2, time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }), type: "narrative", symbol: token.symbol, message: `Trend: "${token.trend_match.term}" (score ${token.trend_match.score})`, score: token.safety });
    }

    // Danger alert
    if (token.safety < 20 || token.staircase_detected || token.honeypot_detected || token.sell_tax > 15) {
      const reasons = [];
      if (token.honeypot_detected) reasons.push("HONEYPOT"); if (token.sell_tax > 15) reasons.push("Tax " + token.sell_tax.toFixed(1) + "%");
      if (token.staircase_detected) reasons.push("Staircase " + token.staircase_confidence + "%");
      if (token.rugcheck?.mintEnabled) reasons.push("Mint enabled");
      if (token.rugcheck && !token.rugcheck.lpBurned && !token.rugcheck.lpLocked) reasons.push("LP unlocked");
      if (reasons.length === 0) reasons.push("Safety " + token.safety);
      alertLog.unshift({ id: Date.now() + 1, time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }), type: "danger", symbol: token.symbol, message: reasons.join(". "), score: token.safety });
      if ((token.honeypot_detected || token.staircase_detected || token.sell_tax > 30) && shouldAlertDiscord("danger-" + token.address)) {
        await sendDiscordAlert({ title: `🔴 DANGER: ${token.symbol} (${token.name})`, color: 0xdc2626, description: reasons.map(r => "⚠️ **" + r + "**").join("\n") + "\nDo NOT buy.", fields: [{ name: "Safety", value: `${token.safety}/100`, inline: true }, { name: "MCap", value: `$${formatNum(token.market_cap)}`, inline: true }], footer: { text: token.address }, timestamp: new Date().toISOString() });
      }
    }
  }

  for (const token of newTokens) { const idx = tokenStore.findIndex(t => t.address === token.address); if (idx >= 0) tokenStore[idx] = token; else tokenStore.unshift(token); }
  if (tokenStore.length > 200) tokenStore = tokenStore.slice(0, 200);
  lastScan = Date.now(); scanCount++;
  updatePaperPositions();
  console.log(`Scan #${scanCount} complete. ${newTokens.length} tokens. Store: ${tokenStore.length}. SmartWallets: ${smartMoneyStore.knownWallets.size}. Paper: ${paperPortfolio.positions.length} pos`);
}

// ─── API ROUTES ───
app.get("/api/tokens", (req, res) => {
  const { min_safety, min_potential, sort, dir, search, limit } = req.query;
  let tokens = [...tokenStore];
  if (search) { const q = search.toLowerCase(); tokens = tokens.filter(t => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)); }
  if (min_safety) tokens = tokens.filter(t => t.safety >= parseInt(min_safety));
  if (min_potential) tokens = tokens.filter(t => t.potential >= parseInt(min_potential));
  const sf = sort || "safety"; const sd = dir === "asc" ? 1 : -1;
  if (sf === "return_proba") tokens.sort((a, b) => ((a.return_proba?.probability || 0) - (b.return_proba?.probability || 0)) * sd);
  else if (sf === "early_pump_score") tokens.sort((a, b) => ((a.early_pump_score || 0) - (b.early_pump_score || 0)) * sd);
  else if (sf === "smart_money") tokens.sort((a, b) => ((a.smart_money?.score || 0) - (b.smart_money?.score || 0)) * sd);
  else tokens.sort((a, b) => ((a[sf] || 0) - (b[sf] || 0)) * sd);
  if (limit) tokens = tokens.slice(0, parseInt(limit));
  res.json({ tokens, total: tokenStore.length, last_scan: lastScan, scan_count: scanCount });
});
app.get("/api/tokens/:address", (req, res) => { const t = tokenStore.find(t => t.address === req.params.address); if (!t) return res.status(404).json({ error: "Not found" }); res.json(t); });

// Manual AI analysis on any token
app.post("/api/analyze/:address", async (req, res) => {
  if (!GROQ_API_KEY) return res.status(400).json({ error: "GROQ_API_KEY not configured" });
  const token = tokenStore.find(t => t.address === req.params.address);
  if (!token) return res.status(404).json({ error: "Token not found in store" });
  // Force fresh analysis (clear cache for this token)
  groqAnalysisCache.delete(token.address);
  try {
    const analysis = await analyzeWithGroq(token);
    if (!analysis) return res.status(500).json({ error: "AI analysis failed. Check Groq service status." });
    // Update token in store
    token.ai_analysis = analysis;
    token.ai_analysis_at = Date.now();
    res.json({ ok: true, analysis, token_symbol: token.symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/alerts", (req, res) => { res.json({ alerts: alertLog.slice(0, 50) }); });

// Backtest results
app.get("/api/backtest", (req, res) => {
  checkBacktestResults();
  const completed = backtestLog.filter(e => e.result_4h || e.result_24h);
  const wins4h = completed.filter(e => e.result_4h === "win").length;
  const losses4h = completed.filter(e => e.result_4h === "loss").length;
  const wins24h = completed.filter(e => e.result_24h === "win").length;
  const losses24h = completed.filter(e => e.result_24h === "loss").length;
  const total4h = completed.filter(e => e.result_4h).length;
  const total24h = completed.filter(e => e.result_24h).length;

  res.json({
    total_logged: backtestLog.length,
    results_4h: { total: total4h, wins: wins4h, losses: losses4h, winRate: total4h > 0 ? Math.round(wins4h / total4h * 100) : 0 },
    results_24h: { total: total24h, wins: wins24h, losses: losses24h, winRate: total24h > 0 ? Math.round(wins24h / total24h * 100) : 0 },
    recent: backtestLog.slice(-20).reverse().map(e => ({
      symbol: e.symbol, safety: e.safety, probability: e.probability, price: e.price,
      mcap: e.mcap, logged: new Date(e.timestamp).toLocaleTimeString("fr-FR"),
      result_4h: e.result_4h, result_24h: e.result_24h,
      price_4h: e.price_4h_later, price_24h: e.price_24h_later,
    })),
  });
});
app.get("/api/stats", (req, res) => {
  const total = tokenStore.length;
  const safe = tokenStore.filter(t => t.safety >= 75).length;
  const danger = tokenStore.filter(t => t.safety < 25).length;
  const stairs = tokenStore.filter(t => t.staircase_detected).length;
  const trending = tokenStore.filter(t => t.trend_match).length;
  const earlyPumps = tokenStore.filter(t => t.early_pump_score >= 50 && t.safety >= 40).length;
  const smartMoney = tokenStore.filter(t => t.smart_money?.score >= 30).length;
  const avgScore = total > 0 ? Math.round(tokenStore.reduce((a, t) => a + t.safety, 0) / total) : 0;
  const best = tokenStore.reduce((b, t) => t.safety > (b?.safety || 0) ? t : b, null);
  // Dynamic safe threshold: 80th percentile, clamped 50-85
  let safeThreshold = 75;
  if (total >= 10) {
    const sorted = tokenStore.map(t => t.safety).sort((a, b) => a - b);
    safeThreshold = Math.min(85, Math.max(50, sorted[Math.floor(sorted.length * 0.8)] || 75));
  }
  res.json({ total, safe, danger, stairs, trending, earlyPumps, smartMoney, avgScore, safeThreshold, rugRate: total > 0 ? Math.round(danger / total * 100) : 0, bestSafety: best ? { symbol: best.symbol, score: best.safety } : null, lastScan, scanCount, activeTrends: trendStore.trends.size, trackedWallets: smartMoneyStore.knownWallets.size });
});
app.get("/api/trends", (req, res) => {
  const trends = [];
  for (const [, data] of trendStore.trends) trends.push({ term: data.term, score: data.score, source: data.source, freshness: Math.round((Date.now() - data.addedAt) / (1000 * 60)), velocity: data.velocity, tokensMatched: countTokensOnTrend(data.term) });
  trends.sort((a, b) => b.score - a.score);
  res.json({ trends: trends.slice(0, 30), total: trendStore.trends.size, lastRefresh: trendStore.lastRefresh });
});
app.post("/api/trends", (req, res) => {
  const { term, score } = req.body; if (!term) return res.status(400).json({ error: "term required" });
  const ct = term.toLowerCase().trim();
  trendStore.trends.set(ct, { term: ct, score: score || 80, addedAt: Date.now(), lastSeen: Date.now(), source: "manual", velocity: 0 });
  res.json({ ok: true, term: ct, total: trendStore.trends.size });
});
// Manual smart wallet add
app.post("/api/wallets", (req, res) => {
  const { wallet, label, pnl } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  smartMoneyStore.knownWallets.set(wallet, { pnl: pnl || 0, wins: 5, trades: 10, label: label || "manual", lastSeen: Date.now() });
  res.json({ ok: true, wallet, total: smartMoneyStore.knownWallets.size });
});
app.get("/api/wallets", (req, res) => {
  const wallets = [];
  for (const [addr, data] of smartMoneyStore.knownWallets) wallets.push({ address: addr.slice(0, 4) + "..." + addr.slice(-4), full: addr, ...data });
  wallets.sort((a, b) => b.wins - a.wins);
  res.json({ wallets: wallets.slice(0, 100), total: smartMoneyStore.knownWallets.size });
});

// ─── PAPER TRADING ROUTES ───

// Get portfolio overview
app.get("/api/paper", async (req, res) => {
  updatePaperPositions();
  const stats = calcPortfolioStats();
  const solPrice = await fetchSolPrice();
  res.json({
    ...stats,
    sol_price: solPrice,
    positions: paperPortfolio.positions.map(p => ({
      id: p.id, address: p.address, symbol: p.symbol, name: p.name,
      tokens: p.tokens, entry_price: p.entry_price, current_price: p.current_price,
      cost_basis: p.cost_basis, current_value: p.current_value,
      pnl_usd: p.pnl_usd, pnl_pct: p.pnl_pct,
      buy_fees: p.buy_fees, ath_value: p.ath_value, drawdown_from_ath: p.drawdown_from_ath,
      safety: p.safety, opened_at: p.opened_at, last_update: p.last_update,
      bloom_scores_at_entry: p.bloom_scores_at_entry,
    })),
    history: paperPortfolio.history.slice(-30).reverse(),
  });
});

// BUY: open a paper position
app.post("/api/paper/buy", async (req, res) => {
  const { address, amount_usd } = req.body;
  if (!address || !amount_usd) return res.status(400).json({ error: "address and amount_usd required" });
  const usd = parseFloat(amount_usd);
  if (usd <= 0 || usd > paperPortfolio.balance_usd) return res.status(400).json({ error: "Invalid amount. Balance: $" + paperPortfolio.balance_usd.toFixed(2) });

  const token = tokenStore.find(t => t.address === address);
  if (!token) return res.status(404).json({ error: "Token not in store" });
  if (token.price <= 0) return res.status(400).json({ error: "Token has no price data" });

  const solPrice = await fetchSolPrice();
  const fees = calcBuyFees(usd, token, solPrice);

  // Check if already have position on this token
  const existing = paperPortfolio.positions.find(p => p.address === address);
  if (existing) {
    // Add to position (average up/down)
    const newTokens = fees.tokens_received;
    const newCost = fees.usd_after_fees;
    existing.tokens += newTokens;
    existing.cost_basis += newCost;
    existing.entry_price = existing.cost_basis / existing.tokens;
    existing.buy_fees += fees.total_fees_usd;
    existing.current_price = token.price;
    existing.current_value = existing.tokens * token.price;
    existing.pnl_usd = existing.current_value - existing.cost_basis;
    existing.pnl_pct = (existing.pnl_usd / existing.cost_basis) * 100;
  } else {
    const pos = {
      id: "PT-" + (++paperPortfolio.trade_count),
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      tokens: fees.tokens_received,
      entry_price: token.price,
      current_price: token.price,
      cost_basis: fees.usd_after_fees,
      current_value: fees.usd_after_fees,
      buy_fees: fees.total_fees_usd,
      pnl_usd: 0,
      pnl_pct: 0,
      ath_value: fees.usd_after_fees,
      ath_price: token.price,
      drawdown_from_ath: 0,
      safety: token.safety,
      opened_at: Date.now(),
      last_update: Date.now(),
      bloom_scores_at_entry: {
        safety: token.safety,
        potential: token.potential,
        probability: token.return_proba?.probability || 0,
        earlyPump: token.early_pump_score || 0,
        smartMoney: token.smart_money?.score || 0,
        aiVerdict: token.ai_analysis?.verdict || null,
        aiConfirmation: token.ai_analysis?.score_confirmation || null,
      },
    };
    paperPortfolio.positions.push(pos);
  }

  paperPortfolio.balance_usd -= usd;

  res.json({
    ok: true,
    action: "BUY",
    symbol: token.symbol,
    amount_usd: usd,
    tokens_received: fees.tokens_received,
    price: token.price,
    sol_price: solPrice,
    fees: fees,
    new_balance: paperPortfolio.balance_usd,
  });
});

// SELL: close or partial close a paper position
app.post("/api/paper/sell", async (req, res) => {
  const { address, pct } = req.body; // pct: 1-100, how much of position to sell
  if (!address) return res.status(400).json({ error: "address required" });
  const sellPct = Math.min(100, Math.max(1, parseInt(pct) || 100));

  const posIdx = paperPortfolio.positions.findIndex(p => p.address === address);
  if (posIdx === -1) return res.status(404).json({ error: "No open position for this token" });

  const pos = paperPortfolio.positions[posIdx];
  const token = tokenStore.find(t => t.address === address);
  if (token) { pos.current_price = token.price; pos.current_value = pos.tokens * token.price; }

  const solPrice = await fetchSolPrice();
  const tokensToSell = pos.tokens * (sellPct / 100);
  const costBasisSold = pos.cost_basis * (sellPct / 100);
  const fees = calcSellFees(tokensToSell, token || { price: pos.current_price, sell_slippage: null, sell_tax: null }, solPrice);

  const pnlUsd = fees.net_usd - costBasisSold;
  const pnlPct = costBasisSold > 0 ? (pnlUsd / costBasisSold) * 100 : 0;

  // Record in history
  paperPortfolio.history.push({
    id: pos.id + (sellPct < 100 ? "-P" + sellPct : ""),
    address: pos.address,
    symbol: pos.symbol,
    name: pos.name,
    entry_price: pos.entry_price,
    exit_price: pos.current_price,
    tokens_sold: tokensToSell,
    cost_basis: costBasisSold,
    gross_usd: fees.gross_usd,
    net_usd: fees.net_usd,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    total_fees: pos.buy_fees * (sellPct / 100) + fees.total_fees_usd,
    sell_fees: fees.total_fees_usd,
    sell_fee_breakdown: fees.breakdown,
    hold_duration_min: Math.round((Date.now() - pos.opened_at) / 60000),
    opened_at: pos.opened_at,
    closed_at: Date.now(),
    ath_value: pos.ath_value,
    bloom_scores_at_entry: pos.bloom_scores_at_entry,
    bloom_scores_at_exit: token ? {
      safety: token.safety, potential: token.potential,
      probability: token.return_proba?.probability || 0,
    } : null,
  });

  paperPortfolio.balance_usd += fees.net_usd;

  if (sellPct >= 100) {
    paperPortfolio.positions.splice(posIdx, 1);
  } else {
    pos.tokens -= tokensToSell;
    pos.cost_basis -= costBasisSold;
    pos.buy_fees *= (1 - sellPct / 100);
    pos.current_value = pos.tokens * pos.current_price;
    pos.pnl_usd = pos.current_value - pos.cost_basis;
    pos.pnl_pct = pos.cost_basis > 0 ? (pos.pnl_usd / pos.cost_basis) * 100 : 0;
  }

  res.json({
    ok: true,
    action: "SELL",
    symbol: pos.symbol,
    pct: sellPct,
    tokens_sold: tokensToSell,
    gross_usd: fees.gross_usd,
    net_usd: fees.net_usd,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    fees: fees,
    new_balance: paperPortfolio.balance_usd,
    position_closed: sellPct >= 100,
  });
});

// Reset paper portfolio
app.post("/api/paper/reset", (req, res) => {
  const startBalance = parseFloat(req.body.balance) || 1000;
  paperPortfolio.balance_usd = startBalance;
  paperPortfolio.initial_balance = startBalance;
  paperPortfolio.positions = [];
  paperPortfolio.history = [];
  paperPortfolio.trade_count = 0;
  res.json({ ok: true, balance: startBalance });
});

// ─── END PAPER TRADING ───

app.get("/api/health", (req, res) => {
  const now = Date.now();
  const fmt2 = (name) => { const s = serviceHealth[name]; return { status: s.status, latency: s.latency, lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null, lastError: s.lastError ? new Date(s.lastError).toISOString() : null, errorCount: s.errorCount, sinceLastSuccess: s.lastSuccess ? Math.round((now - s.lastSuccess) / 1000) : null, ...Object.fromEntries(Object.entries(s).filter(([k]) => !["status", "latency", "lastSuccess", "lastError", "errorCount"].includes(k))) }; };
  res.json({ status: Object.values(serviceHealth).every(s => s.status === "ok") ? "healthy" : Object.values(serviceHealth).some(s => s.status === "down") ? "degraded" : "partial", uptime: Math.round(process.uptime()), tokens: tokenStore.length, scans: scanCount, lastScan: lastScan ? new Date(lastScan).toISOString() : null, sinceLastScan: lastScan ? Math.round((now - lastScan) / 1000) : null, services: { dexscreener: fmt2("dexscreener"), rugcheck: fmt2("rugcheck"), jupiter: fmt2("jupiter"), discord: fmt2("discord"), groq: fmt2("groq"), trends: fmt2("trends"), helius: fmt2("helius") } });
});
app.get("/api/ping", (req, res) => { res.json({ pong: true, time: new Date().toISOString(), tokens: tokenStore.length }); });

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
  // Reset Jupiter backoff every 5 min
  setInterval(() => { if (jupiterConsecutiveErrors >= 10) { console.log("[Jupiter] Resetting backoff, retrying..."); jupiterConsecutiveErrors = 0; } }, 5 * 60 * 1000);
  // Check backtest results every 10 min
  setInterval(checkBacktestResults, 10 * 60 * 1000);
  // Refresh smart money wallets every 30 min
  if (HELIUS_KEY) { setTimeout(() => refreshSmartMoneyWallets(), 60000); setInterval(refreshSmartMoneyWallets, 30 * 60 * 1000); }
  // Validate Groq key at startup
  if (GROQ_API_KEY) {
    fetch("https://api.groq.com/openai/v1/models", { headers: { "Authorization": `Bearer ${GROQ_API_KEY}` } })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        const available = (data.data || []).map(m => m.id);
        console.log(`Groq models available: ${available.join(", ")}`);
        // Pick best available model
        for (const m of GROQ_MODELS) { if (available.includes(m)) { groqActiveModel = m; console.log(`Groq using: ${m}`); break; } }
        updateServiceHealth("groq", true, 0);
      })
      .catch(err => console.error("Groq key validation failed:", err));
  }
});

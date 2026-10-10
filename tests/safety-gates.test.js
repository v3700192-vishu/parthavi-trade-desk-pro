import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEvents, fuse, normalizeNews, analyzeNews, normalizeGlobal, analyzeGlobal } from "../fusion.js";
import { buildPrediction, backtestFiveMinute } from "../prediction.js";
import { evaluate as evaluateRisk } from "../riskGuard.js";

test("an empty economic calendar is never marked event-safe", () => {
  const result = analyzeEvents([]);
  assert.equal(result.connected, false);
  assert.equal(result.eventSafe, false);
});

test("a successful empty calendar response can be verified safe", () => {
  const rows = [];
  Object.defineProperty(rows, "feedConnected", { value: true });
  const result = analyzeEvents(rows);
  assert.equal(result.connected, true);
  assert.equal(result.eventSafe, true);
});

test("an event without a verifiable timestamp keeps the calendar unverified", () => {
  const result = analyzeEvents([{ title: "Scheduled macro event", risk: "WATCH", time: "" }]);
  assert.equal(result.connected, false);
  assert.equal(result.unverifiedTimes, true);
  assert.equal(result.eventSafe, false);
});

test("a high-impact event with an invalid timestamp is blocked", () => {
  const result = analyzeEvents([{ title: "Central bank decision", risk: "HIGH", time: "not-a-date" }]);
  assert.equal(result.unverifiedHighImpact, true);
  assert.equal(result.eventSafe, false);
});

test("a high-impact release outside NSE hours does not block the full Indian session", () => {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const result = analyzeEvents([{
    title: "North American labour release",
    risk: "HIGH",
    time: day + "T18:00:00+05:30"
  }]);
  assert.equal(result.eventDayBlock, false);
});

test("a high-impact release during NSE hours keeps the session blocked", () => {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const result = analyzeEvents([{
    title: "RBI policy decision",
    risk: "HIGH",
    time: day + "T13:00:00+05:30"
  }]);
  assert.equal(result.eventDayBlock, true);
  assert.equal(result.eventSafe, false);
});

test("fusion cannot pass when event safety was not explicitly verified", () => {
  const base = { technicalScore: 80, marketOpen: true, feeds: {
    market: true, options: true, news: true, global: true
  }};
  assert.equal(fuse(base).hardGate, true);
  assert.equal(fuse({ ...base, feeds: { ...base.feeds, eventSafe: false } }).hardGate, true);
  assert.equal(fuse({ ...base, feeds: { ...base.feeds, eventSafe: true } }).hardGate, false);
});

test("prediction cannot emit a trade when option Greeks are missing", () => {
  const latestTime = new Date(Date.now() - 5 * 60_000).toISOString();
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", last: 101, ema20: 100, ema50: 99,
      rsi: 60, macd: { hist: 1 }, adx: 25, atr: 2, vwap: 100,
      volumeRatio10d: 1.6, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: latestTime, o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true,
    vix: 15,
    news: { connected: true, freshCount: 5 },
    global: { connected: true, freshInputs: 4 },
    options: { connected: true, pcr: 1.1, ceoi: 100, peoi: 110 },
    events: { connected: true, eventSafe: true }
  });
  assert.equal(prediction.signalState, "NO TRADE");
  assert.equal(prediction.confirmations.greeks, false);
  assert.equal(prediction.delta, null);
  assert.equal(prediction.finalPlan.available, false);
});

test("prediction returns NO TRADE when verified futures volume is missing", () => {
  const latestTime = new Date(Date.now() - 5 * 60_000).toISOString();
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", last: 101, ema20: 100, ema50: 99,
      rsi: 60, macd: { hist: 1 }, adx: 25, atr: 2, vwap: 100, volumeRatio10d: 2 },
    rows5: [{ t: latestTime, o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true,
    vix: 15,
    news: {},
    global: {},
    options: {},
    events: {}
  });
  assert.equal(prediction.signalState, "NO TRADE");
  assert.equal(prediction.confirmations.volume, false);
  assert.equal(prediction.confirmations.eventSafe, false);
  assert.equal(prediction.volumeRatio10d, null);
  assert.equal(prediction.finalPlan.available, false);
});

test("the index-candle backtest is explicitly marked as not valid for option P&L", () => {
  const result = backtestFiveMinute([]);
  assert.equal(result.kind, "UNDERLYING_PRICE_ONLY");
  assert.equal(result.notValidForOptionPnl, true);
  assert.equal(result.optionsPremiumIncluded, false);
  assert.equal(result.feesIncluded, false);
  assert.equal(result.slippageIncluded, false);
});

test("an underlying-only historical hit rate cannot add a prediction-confidence bonus", () => {
  const input = {
    h1: { trend: "NEUTRAL", last: 100 },
    m15: { trend: "NEUTRAL", last: 100 },
    m5: { trend: "NEUTRAL", candle: "DOJI", last: 100, rsi: 50, atr: 1 },
    rows5: [{ t: new Date(Date.now() - 2 * 60_000).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 0 }],
    marketOpen: false,
    vix: null,
    news: {},
    global: {},
    options: {},
    events: {}
  };
  const base = buildPrediction(input);
  const proxy = buildPrediction({
    ...input,
    backtest: {
      available: true, kind: "UNDERLYING_PRICE_ONLY", verified: false,
      targetHitRate: 100, expectedR: 1, feesIncluded: false, slippageIncluded: false
    }
  });
  assert.equal(proxy.modelConfidence, base.modelConfidence);
  assert.equal(proxy.optionBacktest.available, false);
  assert.equal(proxy.optionBacktest.verified, false);
});

test("only a verified option-premium backtest with fees and slippage may affect confidence", () => {
  const input = {
    h1: { trend: "NEUTRAL", last: 100 },
    m15: { trend: "NEUTRAL", last: 100 },
    m5: { trend: "NEUTRAL", candle: "DOJI", last: 100, rsi: 50, atr: 1 },
    rows5: [{ t: new Date(Date.now() - 2 * 60_000).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 0 }],
    marketOpen: false,
    vix: null,
    news: {},
    global: {},
    options: {},
    events: {}
  };
  const base = buildPrediction(input);
  const verifiedOptionBacktest = buildPrediction({
    ...input,
    backtest: {
      available: true, kind: "OPTION_PREMIUM", verified: true,
      targetHitRate: 100, feesIncluded: true, slippageIncluded: true
    }
  });
  assert.ok(verifiedOptionBacktest.modelConfidence > base.modelConfidence);
});

test("future-dated 5-minute candles are invalid and cannot become fresh entry signals", () => {
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", last: 101, ema20: 100, ema50: 99,
      rsi: 60, macd: { hist: 1 }, adx: 25, atr: 2, vwap: 100,
      volumeRatio10d: 1.6, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() + 60_000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5 },
    global: { connected: true, freshInputs: 4 },
    options: { connected: true, pcr: 1.1, ceoi: 100, peoi: 110, theta: 2, delta: 0.5 },
    events: { connected: true }
  });
  assert.equal(prediction.futureCandleTimestamp, true);
  assert.equal(prediction.candlesFresh, false);
  assert.equal(prediction.action, "NO TRADE");
});

test("conflicting declared trend and EMA structure do not force a directional vote", () => {
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", last: 101, ema20: 99, ema50: 100 },
    m15: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m5: { trend: "BEARISH", candle: "BEARISH CANDLE", last: 99, rsi: 40, macd: { hist: -1 }, adx: 25, atr: 2 },
    rows5: [{ t: new Date(Date.now() - 60_000).toISOString(), o: 100, h: 101, l: 98, c: 99, v: 100 }],
    marketOpen: true, vix: 15, news: {}, global: {}, options: {}, events: {}
  });
  assert.equal(prediction.trend1h, "NEUTRAL");
  assert.equal(prediction.confirmations.trend, false);
  assert.equal(prediction.action, "NO TRADE");
});

test("connected option feed with no valid PCR or OI is not a verified option signal", () => {
  const prediction = buildPrediction({
    h1: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m15: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m5: { trend: "BEARISH", candle: "BEARISH CANDLE", last: 99, rsi: 40, macd: { hist: -1 }, adx: 25, atr: 2, vwap: 100,
      volumeRatio10d: 1.6, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() - 60_000).toISOString(), o: 100, h: 101, l: 98, c: 99, v: 100 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 2, bias: "BEARISH" },
    global: { connected: true, freshInputs: 3, bias: "RISK-OFF" },
    options: { connected: true, pcr: null, ceoi: null, peoi: null, cedoi: null, pedoi: null, theta: 2, delta: 0.5 },
    events: { connected: true }
  });
  assert.equal(prediction.prediction, "BEARISH");
  assert.equal(prediction.optionDataVerified, false);
  assert.equal(prediction.finalPlan.available, false);
  assert.equal(prediction.confirmations.options, false);
  assert.ok(prediction.noTradeReasons.some(x => x.includes("option-chain PCR/OI values")));
  assert.equal(prediction.action, "NO TRADE");
});

test("risk guard treats a missing option Greek as unverified, not as numeric zero", () => {
  const result = evaluateRisk({
    isOption: true, side: "BUY", theta: null, delta: 0.5, vix: 15, adx: 25,
    volumeRatio10d: 1.6, volumeMode: "BREAKOUT", rr: 2, modelConfidence: 80,
    confirmationPct: 100, spreadPct: 0, openPositions: 0, maxLoss: 100,
    signalAction: "CALL", hasStopLoss: true
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("OPTION_GREEKS_UNVERIFIED"));
});

test("risk guard accepts a complete safe option input fixture without missing-value coercion", () => {
  const result = evaluateRisk({
    isOption: true, side: "BUY", theta: 4, delta: 0.5, vix: 15, adx: 25,
    volumeRatio10d: 1.6, volumeMode: "BREAKOUT", rr: 2, modelConfidence: 80,
    confirmationPct: 100, spreadPct: 0, openPositions: 0, maxLoss: 100,
    signalAction: "CALL", hasStopLoss: true
  });
  assert.equal(result.ok, true, result.errors.join(","));
});
test("headlines with missing age are not treated as fresh market news even if provider says LIVE", () => {
  assert.equal(analyzeNews([{ title: "NIFTY rally", status: "LIVE", ageMin: null, score: 90, impact: "HIGH", freshness: 1 }]).connected, false);
});

test("future-dated headlines are not treated as fresh market news", () => {
  const headlines = normalizeNews([{
    title: "NIFTY market rally outlook",
    source: "Reuters",
    publishedAt: new Date(Date.now() + 60_000).toISOString()
  }]);
  assert.equal(headlines.length, 1);
  assert.equal(headlines[0].status, "UNVERIFIED");
  assert.equal(analyzeNews(headlines).connected, false);
});

test("global inputs with missing change values do not count as verified risk inputs", () => {
  const normalized = normalizeGlobal({
    GIFT_NIFTY: {
      value: 22500,
      changePct: null,
      asOf: new Date(Date.now() - 30_000).toISOString(),
      status: "LIVE"
    }
  });
  assert.equal(normalized.GIFT_NIFTY.change, null);
  const summary = analyzeGlobal(normalized);
  assert.equal(summary.connected, false);
  assert.equal(summary.freshInputs, 0);
});

test("future-dated global quotes are excluded even if provider labels them LIVE", () => {
  const normalized = normalizeGlobal({
    GIFT_NIFTY: {
      value: 22500,
      changePct: 0.5,
      asOf: new Date(Date.now() + 60_000).toISOString(),
      status: "LIVE"
    }
  });
  assert.equal(normalized.GIFT_NIFTY.ageMin, null);
  const summary = analyzeGlobal(normalized);
  assert.equal(summary.connected, false);
  assert.equal(summary.freshInputs, 0);
});
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEvents, fuse, normalizeNews, analyzeNews, normalizeGlobal, analyzeGlobal } from "../fusion.js";
import { buildPrediction, buildTradeTiming, backtestFiveMinute } from "../prediction.js";
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

test("a non-Indian high-impact release during NSE hours does not block the whole session", () => {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const result = analyzeEvents([{
    title: "UK GDP m/m",
    country: "GBP",
    risk: "HIGH",
    time: day + "T13:00:00+05:30"
  }]);
  assert.equal(result.eventDayBlock, false);
});

test("an explicitly India-specific high-impact event during NSE hours blocks the session", () => {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const result = analyzeEvents([{
    title: "CPI inflation",
    country: "INR",
    risk: "HIGH",
    time: day + "T13:00:00+05:30"
  }]);
  assert.equal(result.eventDayBlock, true);
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
  assert.equal(fuse({ ...base, feeds: { ...base.feeds, eventSafe: true, eventDayBlock: true } }).hardGate, true);
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

test("unsafe ATM Greeks allow a scan for a separately verified contract, but never allow a trade by themselves", () => {
  const input = {
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", candleSource: "ANGEL", last: 101, ema20: 100, ema50: 99,
      rsi: 48, macd: { hist: -1 }, adx: 25, atr: 2, vwap: 100,
      volumeRatio10d: 1.6, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() - 5 * 60_000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true,
    vix: 15,
    news: { connected: true, freshCount: 5, bias: "BULLISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-ON" },
    options: { connected: true, pcr: 0.8, ceoi: 120, peoi: 100, theta: -14, delta: 0.5 },
    events: { connected: true, eventSafe: true }
  };
  const waiting = buildPrediction(input);
  assert.equal(waiting.action, "NO TRADE");
  assert.equal(waiting.confirmations.greeks, false);
  assert.equal(waiting.contractScanEligible, true, "verified feeds must permit candidate scanning even if momentum and option-direction alignment are false");
  assert.equal(waiting.confirmations.momentum, false);
  assert.equal(waiting.confirmations.options, false);
  assert.equal(waiting.tradeFinder.watchThreshold, 70);
  assert.equal(waiting.tradeFinder.contractThreshold, 70);
  assert.equal(waiting.tradeFinder.advisorThreshold, 80);
  assert.equal(waiting.tradeFinder.commandCenterThreshold, 90);
  assert.equal(waiting.opportunityConfidenceThreshold, 80);
  assert.equal(waiting.candidatePlan.available, true);

  const selected = buildPrediction({
    ...input,
    options: { ...input.options, theta: -4, delta: 0.5,
      greekRisk: { status: "PASS", message: "Selected live contract passed safeguards." } }
  });
  assert.equal(selected.confirmations.greeks, true);
  assert.equal(selected.signalState, "WATCH", "a verified contract must not bypass opposing momentum/options confirmations");
  assert.equal(selected.action, "NO TRADE");
  assert.equal(selected.finalPlan.available, true);
});

test("80% AI Adviser tier may omit only momentum while 90% confirmation remains unconfirmed", () => {
  const input = {
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", candleSource: "ANGEL", last: 101, ema20: 100, ema50: 99,
      rsi: 58, macd: { hist: -1 }, adx: 28, atr: 2, vwap: 100,
      volumeRatio10d: 1.8, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() - 5 * 60_000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5, bias: "BULLISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-ON" },
    options: { connected: true, pcr: 1.1, ceoi: 100, peoi: 120, theta: -4, delta: 0.5 },
    events: { connected: true, eventSafe: true }
  };
  const p = buildPrediction(input);
  assert.equal(p.confirmations.momentum, false);
  assert.equal(p.confirmations.options, true);
  assert.equal(p.confirmations.trigger, true);
  assert.equal(p.advisorMomentumExceptionEligible, true);
  assert.ok(p.modelConfidence >= 80);
  assert.ok(p.confirmationPct >= 80 && p.confirmationPct < 100);
  assert.equal(p.signalState, "WATCH", "missing momentum must prevent 90% Command Center confirmation");
  assert.equal(p.action, "NO TRADE");
  assert.equal(p.commandCenterEligible, undefined, "live contract and exchange tick must be verified by server before tier eligibility");
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

test("completed five-minute broker candle freshness is measured from bar close", () => {
  const latestTime = new Date(Date.now() - 12 * 60_000).toISOString();
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m15: { trend: "BULLISH", last: 101, ema20: 100, ema50: 99 },
    m5: { trend: "BULLISH", candle: "BULLISH CANDLE", candleSource: "ANGEL", last: 101,
      ema20: 100, ema50: 99, rsi: 60, macd: { hist: 1 }, adx: 25, atr: 2, vwap: 100,
      volumeRatio10d: 1.6, volumeSource: "NIFTY FUTURES 5M fixture" },
    rows5: [{ t: latestTime, o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5, bias: "BULLISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-ON" },
    options: { connected: true, pcr: 1.1, ceoi: 100, peoi: 110, theta: -4, delta: 0.5 },
    events: { connected: true }
  });
  assert.equal(prediction.candlesFresh, true);
  assert.equal(prediction.candleAgeMinutes, 7);
  assert.equal(prediction.candlesVerified, true);
});

test("fresh fallback candles cannot satisfy the broker-verified entry gate", () => {
  const prediction = buildPrediction({
    h1: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m15: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m5: { trend: "BEARISH", candle: "BEARISH CANDLE", last: 99, ema20: 100, ema50: 101,
      rsi: 40, macd: { hist: -1 }, adx: 30, atr: 2, vwap: 100,
      candleSource: "YAHOO_FALLBACK", volumeRatio10d: 1.8, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() - 60_000).toISOString(), o: 100, h: 101, l: 98, c: 99, v: 0 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5, bias: "BEARISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-OFF" },
    options: { connected: true, pcr: 0.9, ceoi: 200, peoi: 100, theta: 2, delta: 0.5 },
    events: { connected: true }
  });
  assert.equal(prediction.candlesFresh, true);
  assert.equal(prediction.candlesVerified, false);
  assert.equal(prediction.feedComplete, false);
  assert.equal(prediction.action, "NO TRADE");
  assert.ok(prediction.noTradeReasons.some(x => x.includes("unverified, fallback, or stale source")));
});

test("Yahoo history augmented by live WebSocket candles remains unverified for trade entry", () => {
  const prediction = buildPrediction({
    h1: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m15: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m5: { trend: "BEARISH", candle: "BEARISH CANDLE", last: 99, ema20: 100, ema50: 101,
      rsi: 40, macd: { hist: -1 }, adx: 30, atr: 2, vwap: 100,
      candleSource: "YAHOO_FALLBACK + ANGEL_WS_LIVE", volumeRatio10d: 1.8, volumeSource: "NIFTY FUTURES 5M test fixture" },
    rows5: [{ t: new Date(Date.now() - 60_000).toISOString(), o: 100, h: 101, l: 98, c: 99, v: 0 }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5, bias: "BEARISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-OFF" },
    options: { connected: true, pcr: 0.9, ceoi: 200, peoi: 100, theta: 2, delta: 0.5 },
    events: { connected: true }
  });
  assert.equal(prediction.candlesFresh, true);
  assert.equal(prediction.candlesVerified, false);
  assert.equal(prediction.feedComplete, false);
  assert.equal(prediction.action, "NO TRADE");
});

test("authenticated Upstox V3 history is accepted but stale alternate-provider candles are blocked", () => {
  const input = {
    h1: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m15: { trend: "BEARISH", last: 99, ema20: 100, ema50: 101 },
    m5: { trend: "BEARISH", candle: "BEARISH CANDLE", last: 99, ema20: 100, ema50: 101,
      rsi: 40, macd: { hist: -1 }, adx: 30, atr: 2, vwap: 100,
      candleSource: "UPSTOX_HISTORICAL", volumeRatio10d: 1.8, volumeSource: "UPSTOX FUTURES 5M verified fixture" },
    rows5: [{ t: new Date(Date.now() - 60_000).toISOString(), o: 100, h: 101, l: 98, c: 99, v: null }],
    marketOpen: true, vix: 15,
    news: { connected: true, freshCount: 5, bias: "BEARISH" },
    global: { connected: true, freshInputs: 4, bias: "RISK-OFF" },
    options: { connected: true, pcr: 0.9, ceoi: 200, peoi: 100, theta: 2, delta: 0.5 },
    events: { connected: true }
  };
  const fresh = buildPrediction(input);
  assert.equal(fresh.candlesFresh, true);
  assert.equal(fresh.candlesVerified, true);

  const stale = buildPrediction({
    ...input,
    m5: { ...input.m5, candleSource: "UPSTOX_HISTORICAL [STALE CACHE]" }
  });
  assert.equal(stale.candlesFresh, true);
  assert.equal(stale.candlesVerified, false);
  assert.equal(stale.action, "NO TRADE");
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

test("trade timing expires stale five-minute entry windows instead of chasing", () => {
  const now=Date.parse("2026-10-22T10:00:00.000Z");
  const timing=buildTradeTiming({signalBarTime:new Date(now-11*60_000).toISOString(),candlesVerified:true,modelConfidence:92,signalState:"CONFIRMED",action:"CALL",confirmationPct:100,feedComplete:true,exchangeTickVerified:true,eventSafe:true,directionalCalibrationEligible:true,directionProbability:72,commandCenterEligible:true,noTradeReasons:[],optionPlan:{available:true,candidateOnly:false,greekStatus:"PASS"}},{marketOpen:true,now});
  assert.equal(timing.status,"MISSED • SIGNAL EXPIRED");
  assert.equal(timing.remainingSeconds,0);
});

test("90 percent confidence cannot pass trade timing when command-center eligibility fails", () => {
  const now=Date.parse("2026-10-22T10:00:00.000Z");
  const timing=buildTradeTiming({signalBarTime:new Date(now-6*60_000).toISOString(),candlesVerified:true,modelConfidence:92,signalState:"CONFIRMED",action:"CALL",confirmationPct:100,feedComplete:true,exchangeTickVerified:true,eventSafe:true,directionalCalibrationEligible:true,directionProbability:72,commandCenterEligible:false,noTradeReasons:[],optionPlan:{available:true,candidateOnly:false,greekStatus:"PASS"}},{marketOpen:true,now});
  assert.equal(timing.status,"WAIT • 90% + ALL CHECKS REQUIRED");
});

test("ENTRY READY requires a fresh candle and every final gate", () => {
  const now=Date.parse("2026-10-22T10:00:00.000Z");
  const timing=buildTradeTiming({signalBarTime:new Date(now-6*60_000).toISOString(),candlesVerified:true,modelConfidence:92,signalState:"CONFIRMED",action:"CALL",confirmationPct:100,feedComplete:true,exchangeTickVerified:true,eventSafe:true,directionalCalibrationEligible:true,directionProbability:72,commandCenterEligible:true,noTradeReasons:[],optionPlan:{available:true,candidateOnly:false,greekStatus:"PASS"}},{marketOpen:true,now});
  assert.equal(timing.status,"ENTRY READY");
  assert.equal(timing.remainingSeconds,4*60);
});

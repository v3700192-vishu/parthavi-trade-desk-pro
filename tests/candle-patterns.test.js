import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCandlestickPatterns } from "../candlePatterns.js";
import { buildPrediction } from "../prediction.js";

function downtrendWithHammer() {
  const rows = [];
  let close = 120;
  for (let i = 0; i < 24; i++) {
    const next = close - 0.7;
    rows.push({ t: new Date(Date.UTC(2026, 0, 1, 3, 45 + i * 5)).toISOString(),
      o: close, h: close + 0.4, l: next - 0.3, c: next });
    close = next;
  }
  rows.push({ t: new Date(Date.UTC(2026, 0, 1, 5, 45)).toISOString(),
    o: close - 0.1, h: close + 0.2, l: close - 2.4, c: close + 0.2 });
  return rows;
}

test("detects bullish engulfing from the two most recent completed OHLC candles", () => {
  const rows = [
    { t: "2026-10-22T03:45:00.000Z", o: 105, h: 106, l: 99, c: 100 },
    { t: "2026-10-22T03:50:00.000Z", o: 99, h: 107, l: 98, c: 106 }
  ];
  const result = analyzeCandlestickPatterns(rows);
  assert.ok(result.latestPatterns.some(p => p.name === "BULLISH ENGULFING" && p.direction === "BULLISH"));
  assert.equal(result.triggerBullish, true);
  assert.equal(result.probability, undefined, "a candle pattern must not invent win probability");
});

test("recognizes a hammer shape only as a contextual bullish reversal after a downtrend", () => {
  const result = analyzeCandlestickPatterns(downtrendWithHammer());
  assert.equal(result.trend, "BEARISH");
  assert.ok(result.latestPatterns.some(p => p.name === "HAMMER" && p.direction === "BULLISH"));
  assert.equal(result.triggerBullish, true);
});

test("finds a completed 20-bar resistance breakout and bounded pattern adjustment", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const close = 100 + Math.sin(i * 0.7) * 1.5;
    rows.push({ t: new Date(Date.UTC(2026, 0, 1, 3, 45 + i * 5)).toISOString(),
      o: close - 0.2, h: close + 0.6, l: close - 0.8, c: close });
  }
  rows.push({ t: new Date(Date.UTC(2026, 0, 1, 5, 45)).toISOString(), o: 100, h: 104, l: 99.8, c: 103 });
  const result = analyzeCandlestickPatterns(rows);
  assert.ok(result.chartPatterns.some(p => p.name === "20-BAR RESISTANCE BREAKOUT"));
  assert.ok(result.scoreAdjustment <= 8 && result.scoreAdjustment >= -8);
  assert.equal(result.disclaimer.includes("not calibrated win probabilities"), true);
});

test("invalid and empty OHLC data fails closed without directional triggers", () => {
  const result = analyzeCandlestickPatterns([{ o: 100, h: 99, l: 101, c: 100 }]);
  assert.equal(result.available, false);
  assert.equal(result.direction, "NEUTRAL");
  assert.equal(result.triggerBullish, false);
  assert.equal(result.triggerBearish, false);
  assert.equal(result.support, null);
});

test("prediction publishes the chart engine while closed-market and missing-feed gates remain NO TRADE", () => {
  const rows = downtrendWithHammer();
  const prediction = buildPrediction({
    h1: { trend: "BEARISH", ema20: 99, ema50: 100 },
    m15: { trend: "BEARISH", ema20: 99, ema50: 100 },
    m5: { trend: "BEARISH", candle: "SHOOTING STAR", ema20: 99, ema50: 100 },
    rows5: rows, marketOpen: false
  });
  assert.ok(prediction.chartAnalysis);
  assert.ok(prediction.chartAnalysis.latestPatterns.length > 0);
  assert.equal(prediction.action, "NO TRADE");
  assert.equal(prediction.directionalProbability, null);
});

function risingPatternCandles(count, startPrice, baseMinutes = 0) {
  const rows = [];
  let close = startPrice;
  for (let i = 0; i < count; i++) {
    const next = close + 1;
    rows.push({ t: new Date(Date.UTC(2026, 0, 5, 3, 45 + baseMinutes + i * 5)).toISOString(),
      o: close, h: next + 0.02, l: close - 0.02, c: next });
    close = next;
  }
  return rows;
}

test("higher timeframe candle structures are returned and provide only a small alignment adjustment", () => {
  const rows15 = risingPatternCandles(30, 100, 0);
  const rows60 = risingPatternCandles(30, 200, 0);
  const prediction = buildPrediction({
    h1: { trend: "BULLISH", ema20: 220, ema50: 210 },
    m15: { trend: "BULLISH", ema20: 130, ema50: 120 },
    m5: { trend: "BULLISH", ema20: 100, ema50: 99 },
    rows5: risingPatternCandles(30, 100, 0),
    rows15, rows60, marketOpen: false
  });
  assert.equal(prediction.chartAnalysisByTimeframe["15M"].direction, "BULLISH");
  assert.equal(prediction.chartAnalysisByTimeframe["1H"].direction, "BULLISH");
  assert.equal(prediction.patternTimeframeAdjustment, 3);
  assert.equal(prediction.action, "NO TRADE", "multi-timeframe patterns cannot override closed-session/feed gates");
});

test("detects three white soldiers as a three-candle continuation pattern", () => {
  const rows = [
    { t: "2026-10-22T03:45:00.000Z", o: 100, h: 102.2, l: 99.9, c: 102 },
    { t: "2026-10-22T03:50:00.000Z", o: 102, h: 104.2, l: 101.9, c: 104 },
    { t: "2026-10-22T03:55:00.000Z", o: 104, h: 106.2, l: 103.9, c: 106 }
  ];
  const result = analyzeCandlestickPatterns(rows);
  assert.ok(result.latestPatterns.some(p => p.name === "THREE WHITE SOLDIERS" && p.direction === "BULLISH"));
});

test("tweezer top requires similar highs with a bull-to-bear turn in an established uptrend", () => {
  const rows = risingPatternCandles(24, 100);
  const prior = rows.at(-1);
  rows.push({ t: new Date(Date.parse(prior.t) + 5 * 60_000).toISOString(),
    o: prior.c, h: prior.h + 0.01, l: prior.c - 0.7, c: prior.c - 0.5 });
  const result = analyzeCandlestickPatterns(rows);
  assert.equal(result.trend, "BULLISH");
  assert.ok(result.latestPatterns.some(p => p.name === "TWEEZER TOP" && p.direction === "BEARISH"));
});

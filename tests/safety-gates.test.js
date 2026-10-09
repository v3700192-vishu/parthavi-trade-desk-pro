import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEvents, fuse } from "../fusion.js";
import { buildPrediction } from "../prediction.js";

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

test("fusion cannot pass when event safety was not explicitly verified", () => {
  const base = { technicalScore: 80, marketOpen: true, feeds: {
    market: true, options: true, news: true, global: true
  }};
  assert.equal(fuse(base).hardGate, true);
  assert.equal(fuse({ ...base, feeds: { ...base.feeds, eventSafe: false } }).hardGate, true);
  assert.equal(fuse({ ...base, feeds: { ...base.feeds, eventSafe: true } }).hardGate, false);
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
});

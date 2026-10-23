import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrediction } from '../prediction.js';

test('signal diagnostics expose the actual NO TRADE blockers without weakening thresholds', () => {
  const prediction = buildPrediction({
    h1: { trend: 'BULLISH', ema20: 101, ema50: 100, last: 101 },
    m15: { trend: 'BULLISH', ema20: 101, ema50: 100, last: 101 },
    m5: {
      trend: 'BULLISH', candle: 'SHOOTING STAR', candleSource: 'ANGEL',
      last: 101, ema20: 101, ema50: 100, rsi: 54,
      macd: { hist: -0.2 }, adx: 7.04, atr: 2, vwap: 102,
      volumeRatio10d: 0.72, volumeSource: 'NIFTY FUTURES 5M test fixture'
    },
    rows5: [{ t: new Date(Date.now() - 5 * 60_000).toISOString(), o: 100, h: 102, l: 99, c: 101, v: 100 }],
    marketOpen: true,
    vix: 13.92,
    news: { connected: true, freshCount: 5 },
    global: { connected: true, freshInputs: 4 },
    options: { connected: true, pcr: 0.97, ceoi: 100, peoi: 100, theta: -15.3864, delta: 0.4519 },
    events: { connected: true, eventSafe: true }
  });

  assert.equal(prediction.action, 'NO TRADE');
  assert.equal(prediction.signalGates.directional.pass, false);
  assert.equal(prediction.signalGates.trendStrength.pass, false);
  assert.equal(prediction.signalGates.volume.pass, false);
  assert.equal(prediction.signalGates.greeks.pass, false);
  assert.equal(prediction.signalGates.vix.pass, true);
  assert.equal(prediction.signalGates.thresholds.adxMin, 20);
  assert.equal(prediction.signalGates.thresholds.volumeBreakout, 1.5);
  assert.equal(prediction.signalGates.thresholds.volumeContinuation, 0.9);
  assert.equal(prediction.signalGates.thresholds.contractScanConfidence, 70);
  assert.equal(prediction.signalGates.thresholds.adviserConfidence, 80);
  assert.equal(prediction.signalGates.thresholds.commandCenterConfidence, 90);
  assert.ok(prediction.noTradeReasons.some(reason => reason.includes('directional score')));
  assert.ok(prediction.noTradeReasons.some(reason => reason.includes('ADX is 7.0')));
  assert.ok(prediction.noTradeReasons.some(reason => reason.includes('futures volume is 0.72x')));
  assert.ok(prediction.noTradeReasons.some(reason => reason.includes('|Theta| 15.39')));
});
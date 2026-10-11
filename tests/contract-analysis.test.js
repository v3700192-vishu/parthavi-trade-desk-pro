import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContractMetrics } from "../contractAnalysis.js";

const liquidContract = {
  contract: "NIFTY13OCT2622500CE",
  ltp: 100,
  change: 2.5,
  bid: 99.7,
  ask: 100.3,
  oi: 9524385,
  volume: 502417630
};
const healthyGreeks = {
  delta: 0.42,
  theta: -4.2,
  gamma: 0.0021,
  vega: 0.38,
  iv: 18.7
};

test("contract analysis verifies complete quote, liquidity and Greek data without inventing values", () => {
  const result = summarizeContractMetrics(liquidContract, healthyGreeks);
  assert.equal(result.ltp, 100);
  assert.equal(result.bid, 99.7);
  assert.equal(result.ask, 100.3);
  assert.equal(result.spreadPoints, 0.6);
  assert.equal(result.spreadStatus, "PASS");
  assert.equal(result.oi, 9524385);
  assert.equal(result.volume, 502417630);
  assert.equal(result.iv, 18.7);
  assert.equal(result.delta, 0.42);
  assert.equal(result.theta, -4.2);
  assert.equal(result.greekRiskStatus, "PASS");
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
});

test("null and empty provider values stay UNVERIFIED rather than becoming numeric zero", () => {
  const result = summarizeContractMetrics({
    ltp: null, bid: "", ask: undefined, oi: null, volume: "", change: null
  }, { delta: null, theta: "", iv: null });
  assert.equal(result.ltp, null);
  assert.equal(result.change, null);
  assert.equal(result.bid, null);
  assert.equal(result.ask, null);
  assert.equal(result.oi, null);
  assert.equal(result.volume, null);
  assert.equal(result.delta, null);
  assert.equal(result.theta, null);
  assert.equal(result.iv, null);
  assert.equal(result.spreadStatus, "UNVERIFIED");
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some(x => x.includes("LTP")));
  assert.ok(result.reasons.some(x => x.includes("bid/ask")));
  assert.ok(result.reasons.some(x => x.includes("Open interest")));
  assert.ok(result.reasons.some(x => x.includes("Traded volume")));
  assert.ok(result.reasons.some(x => x.includes("Delta/Theta")));
  assert.ok(result.reasons.some(x => x.includes("volatility")));
});

test("a wide bid/ask spread blocks contract data readiness", () => {
  const result = summarizeContractMetrics({
    ...liquidContract, bid: 95, ask: 105
  }, healthyGreeks);
  assert.equal(result.spreadPct, 10);
  assert.equal(result.spreadStatus, "WIDE");
  assert.equal(result.checks.spread, false);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some(x => x.includes("wide")));
});

test("unsafe Delta/Theta cannot pass the contract buying-quality gate", () => {
  const result = summarizeContractMetrics(liquidContract, {
    ...healthyGreeks, delta: 0.12, theta: -11
  });
  assert.equal(result.greekRiskStatus, "NO TRADE");
  assert.equal(result.checks.greeks, false);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some(x => x.includes("configured buying limits")));
});

test("medium-risk Delta/Theta is marked caution and does not qualify as ready", () => {
  const result = summarizeContractMetrics(liquidContract, {
    ...healthyGreeks, delta: 0.28, theta: -7
  });
  assert.equal(result.greekRiskStatus, "CAUTION");
  assert.equal(result.checks.greeks, false);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some(x => x.includes("needs caution")));
});
import test from "node:test";
import assert from "node:assert/strict";
import { exchangeTimestampMs, exchangeTickAgeMs, isFreshExchangeTick } from "../marketFreshness.js";
import { productionReadiness } from "../phase12.js";
const NOW = 1_800_000_000_000;
test("accepts a valid recent exchange timestamp in milliseconds", () => {
  const tick = { exchange_timestamp: String(NOW - 60_000), last_traded_price: "2252000" };
  assert.equal(exchangeTimestampMs(tick), NOW - 60_000);
  assert.equal(exchangeTickAgeMs(tick, NOW), 60_000);
  assert.equal(isFreshExchangeTick(tick, NOW), true);
});
test("accepts epoch seconds and ISO timestamps", () => {
  const seconds = { exchange_timestamp: String(Math.floor((NOW - 30_000) / 1000)), ltp: 22520 };
  assert.equal(isFreshExchangeTick(seconds, NOW), true);
  const iso = { exchange_timestamp: new Date(NOW - 30_000).toISOString(), ltp: 22520 };
  assert.equal(isFreshExchangeTick(iso, NOW), true);
});
test("rejects stale exchange timestamps even if received locally now", () => {
  const stale = { exchange_timestamp: String(NOW - 26 * 60 * 60 * 1000), last_traded_price: "2252000" };
  assert.equal(isFreshExchangeTick(stale, NOW), false);
});
test("rejects missing timestamps and invalid or zero prices", () => {
  assert.equal(isFreshExchangeTick({ last_traded_price: "2252000" }, NOW), false);
  assert.equal(isFreshExchangeTick({ exchange_timestamp: String(NOW), last_traded_price: "0" }, NOW), false);
  assert.equal(isFreshExchangeTick({ exchange_timestamp: String(NOW), last_traded_price: "NaN" }, NOW), false);
});
test("rejects timestamps too far in the future", () => {
  const future = { exchange_timestamp: String(NOW + 60_000), ltp: 22520 };
  assert.equal(isFreshExchangeTick(future, NOW), false);
});
test("readiness refuses an open market without a fresh exchange tick", () => {
  const result = productionReadiness({ angelConnected: true, marketOpen: true, exchange: "NSE", marketDataFresh: false });
  const check = result.checks.find(x => x.id === "MARKET_TICK_FRESH");
  assert.equal(check.ok, false);
  assert.equal(result.liveReady, false);
});
test("readiness does not require a live tick when the market is closed", () => {
  const result = productionReadiness({ angelConnected: true, marketOpen: false, exchange: "NSE", marketDataFresh: false });
  const check = result.checks.find(x => x.id === "MARKET_TICK_FRESH");
  assert.equal(check.ok, true);
  assert.equal(result.liveReady, false);
});
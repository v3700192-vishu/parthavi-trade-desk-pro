import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchUpstoxHistoricalCandles,
  normalizeUpstoxCandles,
  resolveUpstoxInstrumentKey,
  shouldUseUpstoxFuturesFallback,
  upstoxConfigStatus
} from "../marketDataProviders.js";

function candleRows(count = 20) {
  return Array.from({ length: count }, (_, i) => [
    new Date(Date.UTC(2026, 9, 7, 3, 45 + i * 5)).toISOString(),
    100 + i, 102 + i, 99 + i, 101 + i, 500 + i, 0
  ]);
}

test("Upstox provider defaults only to documented index keys and requires a server token", () => {
  assert.equal(resolveUpstoxInstrumentKey("NIFTY", "index", {}), "NSE_INDEX|Nifty 50");
  assert.equal(resolveUpstoxInstrumentKey("BANKNIFTY", "index", {}), "NSE_INDEX|Nifty Bank");
  assert.equal(resolveUpstoxInstrumentKey("NIFTY", "futures", {}), "");
  assert.equal(upstoxConfigStatus({ symbol: "NIFTY", role: "index", env: {} }).configured, false);
  assert.deepEqual(upstoxConfigStatus({
    symbol: "NIFTY", role: "futures", env: { UPSTOX_ACCESS_TOKEN: "secret", UPSTOX_NIFTY_FUTURES_KEY: "NSE_FO|NIFTY-FUT" }
  }), { configured: true, tokenConfigured: true, instrumentKeyConfigured: true, role: "futures", symbol: "NIFTY" });
});

test("futures fallback activates after a primary-provider rate rejection", () => {
  assert.equal(shouldUseUpstoxFuturesFallback({
    rateRejected: true, rowCount: 700, benchmarkRatio10d: 1.8, sessionVwap: 22500
  }), true);
});

test("futures fallback activates when a large partial history cannot verify the 10-day benchmark", () => {
  assert.equal(shouldUseUpstoxFuturesFallback({
    rateRejected: false, rowCount: 140, benchmarkRatio10d: null, sessionVwap: 22500
  }), true);
});

test("futures fallback activates when a session VWAP cannot be verified", () => {
  assert.equal(shouldUseUpstoxFuturesFallback({
    rateRejected: false, rowCount: 700, benchmarkRatio10d: 1.6, sessionVwap: null
  }), true);
});

test("a sufficient verified primary futures history does not trigger the fallback", () => {
  assert.equal(shouldUseUpstoxFuturesFallback({
    rateRejected: false, rowCount: 700, benchmarkRatio10d: 1.6, sessionVwap: 22500
  }), false);
});

test("Upstox candle normalization sorts, de-duplicates, and preserves missing volume as unknown", () => {
  const rows = normalizeUpstoxCandles({ data: { candles: [
    ["2026-10-07T04:00:00+05:30", 102, 104, 101, 103],
    ["2026-10-07T03:55:00+05:30", 100, 103, 99, 102, 100],
    ["2026-10-07T04:00:00+05:30", 102, 104, 101, 103, 999],
    ["2026-10-07T04:05:00+05:30", 104, 106, 103, 105]
  ] } });
  assert.equal(rows.length, 3);
  assert.ok(Date.parse(rows[0].t) < Date.parse(rows[1].t));
  assert.equal(rows[1].v, 999);
  assert.equal(rows[2].v, null);
  assert.equal(rows[0].v, 100);
});

test("unconfigured Upstox fallback fails fast without calling the network", async () => {
  let calls = 0;
  const result = await fetchUpstoxHistoricalCandles({
    symbol: "NIFTY",
    role: "index",
    fromDate: "2026-10-07T00:00:00+05:30",
    toDate: "2026-10-13T00:00:00+05:30",
    env: {},
    fetchImpl: async () => { calls++; throw new Error("network must not be called"); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /UPSTOX_ACCESS_TOKEN not configured/);
  assert.equal(calls, 0);
});

test("Upstox V3 requests the configured instrument and validates normalized response rows", async () => {
  let seenUrl = "";
  let seenAuthorization = "";
  const result = await fetchUpstoxHistoricalCandles({
    symbol: "NIFTY",
    role: "index",
    fromDate: "2026-10-07T00:00:00+05:30",
    toDate: "2026-10-13T12:00:00+05:30",
    intervalMinutes: 5,
    env: { UPSTOX_ACCESS_TOKEN: "test-token", UPSTOX_NIFTY_INDEX_KEY: "NSE_INDEX|Nifty 50" },
    fetchImpl: async (url, options) => {
      seenUrl = String(url);
      seenAuthorization = options.headers.Authorization;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "success", data: { candles: candleRows() } })
      };
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.provider, "UPSTOX_HISTORICAL");
  assert.equal(result.rows.length, 20);
  assert.match(seenUrl, /api\.upstox\.com\/v3\/historical-candle\/NSE_INDEX%7CNifty%2050\/minutes\/5\/2026-10-13\/2026-10-07/);
  assert.equal(seenAuthorization, "Bearer test-token");
  assert.equal(result.instrumentKey, "NSE_INDEX|Nifty 50");
});

test("Upstox provider rejects HTTP errors and never returns unverified candle rows", async () => {
  const result = await fetchUpstoxHistoricalCandles({
    symbol: "NIFTY",
    role: "index",
    fromDate: "2026-10-07",
    toDate: "2026-10-13",
    env: { UPSTOX_ACCESS_TOKEN: "test-token" },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ status: "error", message: "token rejected" })
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.rows.length, 0);
  assert.match(result.error, /Upstox historical HTTP 403/);
});
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchUpstoxFuturesInstrument,
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
  }), {
    configured: true, tokenConfigured: true, instrumentKeyConfigured: true,
    instrumentKeyResolution: "CONFIGURED", role: "futures", symbol: "NIFTY"
  });
  assert.deepEqual(upstoxConfigStatus({
    symbol: "NIFTY", role: "futures", env: { UPSTOX_ACCESS_TOKEN: "secret" }
  }), {
    configured: true, tokenConfigured: true, instrumentKeyConfigured: false,
    instrumentKeyResolution: "DYNAMIC_UPSTOX_SEARCH", role: "futures", symbol: "NIFTY"
  });
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

test("Upstox futures search selects the nearest unexpired matching index future", async () => {
  let seenUrl = "";
  const result = await fetchUpstoxFuturesInstrument({
    symbol: "NIFTY",
    env: { UPSTOX_ACCESS_TOKEN: "test-token" },
    fetchImpl: async (url, options) => {
      seenUrl = String(url);
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ status: "success", data: [
          { instrument_key: "NSE_FO|expired", segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", underlying_type: "INDEX", expiry: "2000-01-01", trading_symbol: "NIFTY FUT OLD" },
          { instrument_key: "NSE_FO|equity", segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "RELIANCE", underlying_type: "EQUITY", expiry: "2099-10-30", trading_symbol: "RELIANCE FUT" },
          { instrument_key: "NSE_FO|far", segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", underlying_type: "INDEX", expiry: "2099-11-30", trading_symbol: "NIFTY FUT 30 NOV 2099" },
          { instrument_key: "NSE_FO|near", segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", underlying_type: "INDEX", expiry: "2099-10-30", trading_symbol: "NIFTY FUT 30 OCT 2099" }
        ] })
      };
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.instrumentKey, "NSE_FO|near");
  assert.equal(result.expiry, "2099-10-30");
  assert.match(seenUrl, /api\.upstox\.com\/v2\/instruments\/search/);
  assert.match(seenUrl, /segments=FUT/);
});

test("Upstox historical futures fetch resolves the front month dynamically if no key is configured", async () => {
  const urls = [];
  const result = await fetchUpstoxHistoricalCandles({
    symbol: "NIFTY", role: "futures",
    fromDate: "2026-10-07T00:00:00+05:30", toDate: "2026-10-13T12:00:00+05:30",
    intervalMinutes: 5, env: { UPSTOX_ACCESS_TOKEN: "test-token" },
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.headers.Authorization, "Bearer test-token");
      if (String(url).includes("/instruments/search?")) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ status: "success", data: [
            { instrument_key: "NSE_FO|future123", segment: "NSE_FO", instrument_type: "FUT", underlying_symbol: "NIFTY", underlying_type: "INDEX", expiry: "2099-10-30", trading_symbol: "NIFTY FUT 30 OCT 2099" }
          ] })
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ status: "success", data: { candles: candleRows() } })
      };
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.instrumentKey, "NSE_FO|future123");
  assert.equal(result.resolvedInstrument.tradingSymbol, "NIFTY FUT 30 OCT 2099");
  assert.match(urls[0], /instruments\/search/);
  assert.match(urls[1], /historical-candle\/NSE_FO%7Cfuture123\/minutes\/5/);
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

test("Upstox futures historical backfill merges current-session V3 intraday candles", async () => {
  const urls = [];
  const now = Date.now();
  const base = Math.floor((now - 12 * 60_000) / (5 * 60_000)) * (5 * 60_000);
  const currentRows = [0, 5].map((m, i) => [
    new Date(base + m * 60_000).toISOString(),
    23000 + i, 23002 + i, 22999 + i, 23001 + i, 1200 + i, 0
  ]);
  const result = await fetchUpstoxHistoricalCandles({
    symbol: "NIFTY", role: "futures",
    fromDate: new Date(now - 15 * 86_400_000), toDate: new Date(now),
    intervalMinutes: 5, env: { UPSTOX_ACCESS_TOKEN: "test-token" },
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("/instruments/search?")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "success", data: [
          { instrument_key: "NSE_FO|NIFTY-FUT", segment: "NSE_FO", instrument_type: "FUT",
            underlying_symbol: "NIFTY", underlying_type: "INDEX", expiry: "2099-10-30",
            trading_symbol: "NIFTY FUT 30 OCT 2099" }
        ] }) };
      }
      if (String(url).includes("/historical-candle/intraday/")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "success", data: { candles: currentRows } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "success", data: { candles: candleRows(25) } }) };
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.intradayRows, 2);
  assert.equal(result.intradayError, null);
  assert.ok(result.rows.some(row => row.t === new Date(base).toISOString()));
  assert.ok(urls.some(url => url.includes("/historical-candle/intraday/NSE_FO%7CNIFTY-FUT/minutes/5")));
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
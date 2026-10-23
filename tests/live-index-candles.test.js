import test from "node:test";
import assert from "node:assert/strict";
import { clearLiveIndexCandlesForTests, getLiveIndexCandles, recordLiveIndexTick } from "../liveIndexCandles.js";

const T = (iso) => Date.parse(iso);

test("builds completed index 5M OHLC from valid WebSocket ticks without inventing volume", () => {
  clearLiveIndexCandlesForTests();
  assert.equal(recordLiveIndexTick("99926000", 25000.25, T("2026-10-13T03:45:05.000Z")), true);
  recordLiveIndexTick("99926000", 25002.00, T("2026-10-13T03:47:10.000Z"));
  recordLiveIndexTick("99926000", 24999.50, T("2026-10-13T03:49:40.000Z"));
  recordLiveIndexTick("99926000", 25001.00, T("2026-10-13T03:50:02.000Z"));

  const rows = getLiveIndexCandles("99926000", T("2026-10-13T03:50:03.000Z"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    t: "2026-10-13T03:45:00.000Z",
    o: 25000.25,
    h: 25002,
    l: 24999.5,
    c: 24999.5,
    v: 0
  });
});

test("does not treat a candle first seen late in its interval as a complete candle", () => {
  clearLiveIndexCandlesForTests();
  recordLiveIndexTick("99926000", 25000, T("2026-10-13T04:01:00.000Z"));
  recordLiveIndexTick("99926000", 25005, T("2026-10-13T04:05:04.000Z"));
  recordLiveIndexTick("99926000", 25006, T("2026-10-13T04:10:02.000Z"));

  const rows = getLiveIndexCandles("99926000", T("2026-10-13T04:10:03.000Z"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].t, "2026-10-13T04:05:00.000Z");
  assert.equal(rows[0].o, 25005);
  assert.equal(rows[0].c, 25005);
});

test("ignores non-index tokens, invalid prices, and out-of-session timestamps", () => {
  clearLiveIndexCandlesForTests();
  assert.equal(recordLiveIndexTick("12345", 25000, T("2026-10-13T03:45:05.000Z")), false);
  assert.equal(recordLiveIndexTick("99926000", 0, T("2026-10-13T03:45:05.000Z")), false);
  assert.equal(recordLiveIndexTick("99926000", 25000, T("2026-10-13T03:30:05.000Z")), false);
  assert.deepEqual(getLiveIndexCandles("99926000", T("2026-10-13T03:50:00.000Z")), []);
});
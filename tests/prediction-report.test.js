import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPredictionReportStore } from "../predictionReport.js";

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ptd-report-"));
  try {
    let now = Date.parse("2026-10-12T04:29:00.000Z");
    const store = createPredictionReportStore(path.join(dir, "prediction-report.json"), { now: () => now });
    await fn({ store, setNow: value => { now = Date.parse(value); } });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function callSnapshot(checkedAt, candles, overrides = {}) {
  return {
    symbol: "NIFTY",
    checkedAt,
    marketOpen: true,
    referencePrice: 25000,
    health: { market: true, options: true },
    candles,
    prediction: {
      prediction: "BULLISH",
      action: "CALL",
      signalState: "CONFIRMED",
      modelConfidence: 84,
      confirmationPct: 82,
      exchangeTickVerified: true,
      feedComplete: true,
      reasoning: "Verified unit-test forecast.",
      finalPlan: { entry: 25000, sl: 24950, target1: 25100, target2: 25150 },
      optionPlan: { available: true, contract: "NIFTYTESTCE", optionType: "CE", entry: 40, stopLoss: 34, target1: 52 },
      ...overrides
    }
  };
}

test("prediction report is persisted but does not record closed-session snapshots", async () => {
  await withStore(async ({ store }) => {
    const closed = callSnapshot("2026-10-12T04:29:00.000Z", []);
    closed.marketOpen = false;
    await store.record(closed);
    assert.equal((await store.list()).length, 0);
    const candles = [{ t: "2026-10-12T04:25:00.000Z", o: 24980, h: 25010, l: 24970, c: 25000 }];
    await store.record(callSnapshot("2026-10-12T04:29:00.000Z", candles));
    const rows = await store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "PENDING");
    assert.equal(rows[0].symbol, "NIFTY");
    assert.equal(rows[0].referencePrice, 25000);
  });
});

test("only later completed candles resolve a verified CALL; target hit becomes WIN without duplicate snapshots", async () => {
  await withStore(async ({ store, setNow }) => {
    const reference = [{ t: "2026-10-12T04:25:00.000Z", o: 24980, h: 25010, l: 24970, c: 25000 }];
    await store.record(callSnapshot("2026-10-12T04:29:00.000Z", reference));
    // A range from the signal candle itself must not score the report.
    setNow("2026-10-12T04:30:00.000Z");
    await store.record(callSnapshot("2026-10-12T04:30:00.000Z", reference));
    assert.equal((await store.list())[0].status, "PENDING");

    // Entry must be established on one candle before a later candle can count an exit.
    setNow("2026-10-12T04:35:00.000Z");
    const next = [
      ...reference,
      { t: "2026-10-12T04:30:00.000Z", o: 25000, h: 25020, l: 25005, c: 25010 },
      { t: "2026-10-12T04:35:00.000Z", o: 25010, h: 25110, l: 25050, c: 25100 }
    ];
    await store.record(callSnapshot("2026-10-12T04:35:00.000Z", next));
    const rows = await store.list();
    assert.equal(rows.length, 1, "same active signal should be deduplicated");
    assert.equal(rows[0].status, "WIN");
    assert.equal(rows[0].outcome, "TARGET_1_HIT");
  });
});

test("a verified PUT stop is counted as LOSS and same-candle entry/exit remains ambiguous", async () => {
  await withStore(async ({ store, setNow }) => {
    const reference = [{ t: "2026-10-12T04:25:00.000Z", o: 25010, h: 25030, l: 24990, c: 25000 }];
    const put = callSnapshot("2026-10-12T04:29:00.000Z", reference, {
      prediction: "BEARISH", action: "PUT",
      finalPlan: { entry: 25000, sl: 25050, target1: 24900, target2: 24850 },
      optionPlan: { available: true, contract: "NIFTYTESTPE", optionType: "PE", entry: 40, stopLoss: 34, target1: 52 }
    });
    await store.record(put);
    setNow("2026-10-12T04:40:00.000Z");
    const next = [
      ...reference,
      { t: "2026-10-12T04:30:00.000Z", o: 25000, h: 25020, l: 24980, c: 25000 },
      { t: "2026-10-12T04:35:00.000Z", o: 25000, h: 25060, l: 24980, c: 25040 }
    ];
    await store.record({ ...put, checkedAt: "2026-10-12T04:40:00.000Z", candles: next });
    assert.equal((await store.list())[0].status, "LOSS");

    const otherRef = [{ t: "2026-10-12T04:35:00.000Z", o: 25000, h: 25020, l: 24980, c: 25000 }];
    const call = callSnapshot("2026-10-12T04:39:00.000Z", otherRef, { optionPlan: { contract: "NIFTYTESTCE2", optionType: "CE", entry: 40 } });
    await store.record(call);
    setNow("2026-10-12T04:45:00.000Z");
    const both = [...otherRef, { t: "2026-10-12T04:40:00.000Z", o: 25000, h: 25110, l: 24940, c: 25040 }];
    await store.record({ ...call, checkedAt: "2026-10-12T04:45:00.000Z", candles: both });
    const rows = await store.list();
    assert.equal(rows.find(x => x.contract === "NIFTYTESTCE2").status, "AMBIGUOUS");
    assert.equal(rows.find(x => x.contract === "NIFTYTESTCE2").outcome, "TARGET_AND_SL_IN_SAME_CANDLE");
  });
});
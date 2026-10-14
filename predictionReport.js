import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MAX_REPORTS = 1000;
const OUTCOME_WINDOW_MS = 90 * 60 * 1000;

function validTime(value) {
  const n = Date.parse(value ?? "");
  return Number.isFinite(n) ? n : null;
}
function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizeCandle(row) {
  if (!row || typeof row !== "object") return null;
  const time = validTime(row.t ?? row.time ?? row.timestamp);
  const high = finitePositive(row.h ?? row.high);
  const low = finitePositive(row.l ?? row.low);
  if (time == null || high == null || low == null || high < low) return null;
  return { time, high, low };
}
function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createPredictionReportStore(filePath, { now = () => Date.now() } = {}) {
  let queue = Promise.resolve();

  async function readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }
  async function saveAll(rows) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = filePath + "." + process.pid + ".tmp";
    await fs.writeFile(temp, JSON.stringify(rows, null, 2), "utf8");
    await fs.rename(temp, filePath);
  }
  function serial(work) {
    const task = queue.then(work, work);
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  function resolvePending(rows, symbol, candleInput, currentTime) {
    const candles = (Array.isArray(candleInput) ? candleInput : [])
      .map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time);
    if (!candles.length) return;
    for (const report of rows) {
      if (report.symbol !== symbol || report.status !== "PENDING") continue;
      const createdAt = validTime(report.createdAt);
      const referenceAt = validTime(report.referenceCandleAt) ?? createdAt;
      if (createdAt == null) continue;
      const action = report.action;
      const entry = finitePositive(report.levels?.entry);
      const stop = finitePositive(report.levels?.sl);
      const target = finitePositive(report.levels?.target1);
      if (!entry || !stop || !target) {
        report.status = "UNSCORABLE";
        report.outcomeNote = "Missing/invalid underlying entry, stop-loss, or target.";
        continue;
      }
      for (const candle of candles) {
        if (candle.time <= referenceAt) continue; // never score against the signal candle itself
        const entryTouched = action === "CALL" ? candle.high >= entry : candle.low <= entry;
        const stopHit = action === "CALL" ? candle.low <= stop : candle.high >= stop;
        const targetHit = action === "CALL" ? candle.high >= target : candle.low <= target;

        if (!report.entryTouched) {
          if (!entryTouched) continue;
          if (stopHit && targetHit) {
            report.status = "AMBIGUOUS";
            report.outcome = "TARGET_AND_SL_IN_SAME_CANDLE";
            report.completedAt = new Date(candle.time).toISOString();
            report.outcomeNote = "Target and stop both appeared in the entry candle; sequence cannot be verified and is excluded from accuracy.";
            break;
          }
          if (stopHit || targetHit) {
            report.status = "AMBIGUOUS";
            report.outcome = "ENTRY_AND_EXIT_IN_SAME_CANDLE";
            report.completedAt = new Date(candle.time).toISOString();
            report.outcomeNote = "Entry and an exit level appeared in the same 5-minute candle; sequence cannot be verified and is excluded from accuracy.";
            break;
          }
          report.entryTouched = true;
          continue; // require a later completed candle to verify an exit
        }

        if (stopHit && targetHit) {
          report.status = "AMBIGUOUS";
          report.outcome = "TARGET_AND_SL_IN_SAME_CANDLE";
          report.completedAt = new Date(candle.time).toISOString();
          report.outcomeNote = "Both target and stop appeared in the same 5-minute candle; excluded from accuracy.";
          break;
        }
        if (stopHit) {
          report.status = "LOSS";
          report.outcome = "STOP_LOSS_HIT";
          report.completedAt = new Date(candle.time).toISOString();
          report.outcomeNote = "Underlying stop-loss was hit after entry was established by an earlier completed 5-minute candle.";
          break;
        }
        if (targetHit) {
          report.status = "WIN";
          report.outcome = "TARGET_1_HIT";
          report.completedAt = new Date(candle.time).toISOString();
          report.outcomeNote = "Underlying target 1 was hit after entry was established by an earlier completed 5-minute candle.";
          break;
        }
      }
      if (report.status === "PENDING" && currentTime - createdAt > OUTCOME_WINDOW_MS) {
        report.status = "EXPIRED";
        report.outcome = "NO_TARGET_OR_SL_WITHIN_WINDOW";
        report.completedAt = new Date(currentTime).toISOString();
        report.outcomeNote = "No target/stop outcome was verified within 90 minutes; excluded from accuracy.";
      }
    }
  }

  async function record(snapshot = {}) {
    return serial(async () => {
      const rows = await readAll();
      const currentTime = validTime(snapshot.checkedAt) ?? now();
      if (snapshot.marketOpen !== true) return rows;

      const symbol = String(snapshot.symbol || "NIFTY").toUpperCase().slice(0, 30);
      const p = snapshot.prediction && typeof snapshot.prediction === "object" ? snapshot.prediction : {};
      const candles = Array.isArray(snapshot.candles) ? snapshot.candles : [];
      resolvePending(rows, symbol, candles, currentTime);

      const actionText = String(p.action || "NO TRADE").toUpperCase();
      const action = ["CALL", "PUT"].includes(actionText) ? actionText : "NO TRADE";
      const signalState = String(p.signalState || "NO TRADE").toUpperCase();
      const direction = String(p.prediction || "NO TRADE").toUpperCase();
      const finalPlan = p.finalPlan || {};
      const optionPlan = p.optionPlan || {};
      const entry = finitePositive(finalPlan.entry);
      const sl = finitePositive(finalPlan.sl ?? finalPlan.stopLoss);
      const target1 = finitePositive(finalPlan.target1);
      const target2 = finitePositive(finalPlan.target2);
      const scorable = signalState === "CONFIRMED" &&
        ["CALL", "PUT"].includes(action) &&
        p.exchangeTickVerified === true &&
        p.feedComplete === true &&
        entry != null && sl != null && target1 != null &&
        (action === "CALL" ? sl < entry && target1 > entry : sl > entry && target1 < entry);
      const status = scorable ? "PENDING" :
        signalState === "WATCH" ? "WATCH" :
        signalState === "CONFIRMED" ? "UNVERIFIED" : "NO TRADE";
      const contract = String(optionPlan.contract || "").slice(0, 80);
      const signature = [symbol, signalState, action, direction, contract, scorable ? "SCORABLE" : status].join("|");
      const latest = rows.at(-1);
      if (latest && latest.signature === signature) {
        latest.lastSeenAt = new Date(currentTime).toISOString();
        latest.latestReferencePrice = finitePositive(snapshot.referencePrice);
        latest.health = snapshot.health && typeof snapshot.health === "object" ? snapshot.health : latest.health;
        latest.occurrences = Math.max(1, Number(latest.occurrences || 1)) + 1;
      } else {
        const referenceCandle = candles.map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time).at(-1);
        const referenceCandleAt = referenceCandle ? new Date(referenceCandle.time).toISOString() : null;
        rows.push({
          id: crypto.randomUUID(),
          symbol,
          createdAt: new Date(currentTime).toISOString(),
          lastSeenAt: new Date(currentTime).toISOString(),
          signature,
          signalState,
          direction,
          action,
          modelConfidence: Number.isFinite(Number(p.modelConfidence)) ? Number(p.modelConfidence) : null,
          confirmationPct: Number.isFinite(Number(p.confirmationPct)) ? Number(p.confirmationPct) : null,
          referencePrice: finitePositive(snapshot.referencePrice),
          latestReferencePrice: finitePositive(snapshot.referencePrice),
          referenceCandleAt,
          exchangeTickVerified: p.exchangeTickVerified === true,
          feedComplete: p.feedComplete === true,
          health: snapshot.health && typeof snapshot.health === "object" ? snapshot.health : {},
          contract: contract || null,
          optionType: optionPlan.optionType || null,
          expiry: optionPlan.expiry || null,
          optionEntry: finitePositive(optionPlan.entry),
          optionStopLoss: finitePositive(optionPlan.stopLoss),
          optionTarget1: finitePositive(optionPlan.target1),
          levels: { entry, sl, target1, target2 },
          reasoning: String(p.reasoning || p.reason || "No detailed reason returned.").slice(0, 900),
          status,
          outcome: null,
          outcomeNote: scorable ? "Waiting for subsequent completed 5-minute candles; review is on the underlying index, not option premium P&L." :
            status === "WATCH" ? "Candidate only; not included in accuracy." :
            status === "UNVERIFIED" ? "Confirmation was reported but one or more live-data/price-level checks failed; not scored." :
            "NO TRADE state; not included in accuracy.",
          entryTouched: false,
          occurrences: 1
        });
      }

      while (rows.length > MAX_REPORTS) rows.shift();
      await saveAll(rows);
      return rows;
    });
  }

  async function list() {
    await queue;
    return readAll();
  }

  return { record, list };
}
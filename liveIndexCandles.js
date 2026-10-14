// Build conservative 5-minute index candles from authenticated Angel One WebSocket ticks.
// These bars are supplementary live data; they are not a substitute for historical backfill.
const INDEX_TOKENS = new Set(["99926000","99926009","99926037","99926074","99919000","99926017"]);
const SERIES = new Map();
const BAR_MS = 5 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const SESSION_START_MINUTE = 9 * 60 + 15;
const SESSION_END_MINUTE = 15 * 60 + 30;
const MAX_BARS_PER_TOKEN = 1200;
const VALID_START_WINDOW_MS = 45 * 1000;

function bucketStart(timestampMs) {
  const ist = new Date(timestampMs + IST_OFFSET_MS);
  const dayStartUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;
  const minuteOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minuteOfDay < SESSION_START_MINUTE || minuteOfDay >= SESSION_END_MINUTE) return null;
  const open = dayStartUtc + SESSION_START_MINUTE * 60 * 1000;
  return open + Math.floor((timestampMs - open) / BAR_MS) * BAR_MS;
}

export function recordLiveIndexTick(token, price, timestampMs) {
  const key = String(token ?? "");
  const px = Number(price);
  const ts = Number(timestampMs);
  if (!INDEX_TOKENS.has(key) || !Number.isFinite(px) || px <= 0 || !Number.isFinite(ts) || ts <= 0) return false;
  const start = bucketStart(ts);
  if (start == null) return false;
  let series = SERIES.get(key);
  if (!series) { series = new Map(); SERIES.set(key, series); }
  const lastKey = series.size ? Math.max(...series.keys()) : null;
  // Ignore late/out-of-order packets instead of altering a candle after newer bars began.
  if (lastKey != null && start < lastKey) return false;
  let bar = series.get(start);
  if (!bar) {
    const secondsIntoBar = ts - start;
    bar = {
      t: new Date(start).toISOString(), o: px, h: px, l: px, c: px, v: 0,
      _start: start, _valid: secondsIntoBar <= VALID_START_WINDOW_MS
    };
    series.set(start, bar);
  } else {
    bar.h = Math.max(bar.h, px);
    bar.l = Math.min(bar.l, px);
    bar.c = px;
  }
  while (series.size > MAX_BARS_PER_TOKEN) {
    const oldest = Math.min(...series.keys());
    series.delete(oldest);
  }
  return true;
}

export function getLiveIndexCandles(token, nowMs = Date.now()) {
  const key = String(token ?? "");
  const series = SERIES.get(key);
  if (!series) return [];
  const currentBucket = bucketStart(Number(nowMs));
  return [...series.values()]
    .filter(bar => bar._valid && (currentBucket == null || bar._start < currentBucket))
    .sort((a, b) => a._start - b._start)
    .map(({ _start, _valid, ...bar }) => ({ ...bar }));
}

export function clearLiveIndexCandlesForTests() {
  SERIES.clear();
}
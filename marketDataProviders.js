// Optional, separately authenticated historical-candle provider.
// Keeps alternate market-data access isolated from Angel One credentials and session state.
const DEFAULT_INDEX_KEYS = Object.freeze({
  NIFTY: "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  VIX: "NSE_INDEX|India VIX"
});

function envKeyName(symbol, role) {
  const key = String(symbol || "NIFTY").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return role === "futures" ? `UPSTOX_${key}_FUTURES_KEY` : `UPSTOX_${key}_INDEX_KEY`;
}

export function resolveUpstoxInstrumentKey(symbol, role = "index", env = process.env) {
  const direct = String(env[envKeyName(symbol, role)] || "").trim();
  if (direct) return direct;
  if (role === "index") return DEFAULT_INDEX_KEYS[String(symbol || "NIFTY").trim().toUpperCase()] || "";
  return "";
}

function istDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid Upstox candle date");
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const m = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

export function normalizeUpstoxCandles(payload) {
  const candles = payload?.data?.candles;
  if (!Array.isArray(candles)) throw new Error("Upstox response did not contain data.candles");
  const rows = [];
  for (const candle of candles) {
    if (!Array.isArray(candle) || candle.length < 5) continue;
    const ts = Date.parse(String(candle[0] ?? ""));
    const [o, h, l, c] = candle.slice(1, 5).map(Number);
    if (!Number.isFinite(ts) || ![o, h, l, c].every(Number.isFinite) ||
        o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) continue;
    const rawVolume = candle[5];
    const parsedVolume = rawVolume == null || rawVolume === "" ? null : Number(rawVolume);
    const rawOi = candle[6];
    const parsedOi = rawOi == null || rawOi === "" ? null : Number(rawOi);
    rows.push({
      t: new Date(ts).toISOString(), o, h, l, c,
      v: parsedVolume != null && Number.isFinite(parsedVolume) && parsedVolume >= 0 ? parsedVolume : null,
      oi: parsedOi != null && Number.isFinite(parsedOi) && parsedOi >= 0 ? parsedOi : null
    });
  }
  return [...new Map(rows.map(row => [row.t, row])).values()]
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export async function fetchUpstoxHistoricalCandles({
  symbol = "NIFTY", role = "index", instrumentKey = "", fromDate, toDate,
  intervalMinutes = 5, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 9000
} = {}) {
  const token = String(env.UPSTOX_ACCESS_TOKEN || "").trim();
  const key = String(instrumentKey || resolveUpstoxInstrumentKey(symbol, role, env)).trim();
  if (!token) return { ok: false, provider: "UPSTOX", rows: [], error: "UPSTOX_ACCESS_TOKEN not configured" };
  if (!key) return { ok: false, provider: "UPSTOX", rows: [], error: `${envKeyName(symbol, role)} not configured` };
  const interval = Number(intervalMinutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 300)
    return { ok: false, provider: "UPSTOX", rows: [], error: "Upstox minute interval must be an integer from 1 to 300" };
  if (typeof fetchImpl !== "function")
    return { ok: false, provider: "UPSTOX", rows: [], error: "Fetch is unavailable in this runtime" };

  let from, to;
  try {
    from = istDate(fromDate);
    to = istDate(toDate);
    if (from > to) throw new Error("Upstox candle start date is after end date");
  } catch (error) {
    return { ok: false, provider: "UPSTOX", rows: [], error: String(error?.message || error).slice(0, 200) };
  }

  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/${interval}/${to}/${from}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const bodyText = await response.text();
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : {}; }
    catch { throw new Error(`Upstox historical HTTP ${response.status}: non-JSON response`); }
    if (!response.ok || (payload?.status && String(payload.status).toLowerCase() !== "success")) {
      const message = String(payload?.errors?.[0]?.message || payload?.message || payload?.error || "").trim();
      throw new Error(`Upstox historical HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    const rows = normalizeUpstoxCandles(payload);
    if (rows.length < 20) throw new Error(`Upstox historical returned only ${rows.length} valid candles; at least 20 required`);
    return { ok: true, provider: "UPSTOX_HISTORICAL", instrumentKey: key, rows, error: null, fromDate: from, toDate: to };
  } catch (error) {
    return { ok: false, provider: "UPSTOX", rows: [], error: String(error?.message || error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240) };
  }
}

// Use independent futures history whenever the primary feed cannot support verified volume/VWAP checks.
export function shouldUseUpstoxFuturesFallback({
  rateRejected = false, rowCount = 0, benchmarkRatio10d = null, sessionVwap = null
} = {}) {
  const count = Number(rowCount);
  const ratioAvailable = benchmarkRatio10d !== null && benchmarkRatio10d !== undefined && Number.isFinite(Number(benchmarkRatio10d));
  const vwapAvailable = sessionVwap !== null && sessionVwap !== undefined && Number.isFinite(Number(sessionVwap));
  return Boolean(rateRejected || !Number.isFinite(count) || count < 100 || !ratioAvailable || !vwapAvailable);
}

export function upstoxConfigStatus({ symbol = "NIFTY", role = "index", env = process.env } = {}) {
  const tokenConfigured = Boolean(String(env.UPSTOX_ACCESS_TOKEN || "").trim());
  const instrumentKeyConfigured = Boolean(resolveUpstoxInstrumentKey(symbol, role, env));
  return {
    configured: tokenConfigured && instrumentKeyConfigured,
    tokenConfigured,
    instrumentKeyConfigured,
    role,
    symbol: String(symbol || "NIFTY").toUpperCase()
  };
}
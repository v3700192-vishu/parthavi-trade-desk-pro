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

export async function fetchUpstoxFuturesInstrument({
  symbol = "NIFTY", env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 7000
} = {}) {
  const token = String(env.UPSTOX_ACCESS_TOKEN || "").trim();
  const underlying = String(symbol || "NIFTY").trim().toUpperCase();
  if (!token) return { ok: false, provider: "UPSTOX", error: "UPSTOX_ACCESS_TOKEN not configured" };
  if (typeof fetchImpl !== "function") return { ok: false, provider: "UPSTOX", error: "Fetch is unavailable in this runtime" };
  const allowed = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);
  if (!allowed.has(underlying)) return { ok: false, provider: "UPSTOX", error: "Unsupported index futures underlying" };
  const exchange = underlying === "SENSEX" ? "BSE" : "NSE";
  const params = new URLSearchParams({ query: underlying, exchanges: exchange, segments: "FUT", page_number: "1", records: "30" });
  try {
    const response = await fetchImpl(`https://api.upstox.com/v2/instruments/search?${params}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const bodyText = await response.text();
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : {}; }
    catch { throw new Error(`Upstox instrument search HTTP ${response.status}: non-JSON response`); }
    if (!response.ok || (payload?.status && String(payload.status).toLowerCase() !== "success")) {
      const message = String(payload?.errors?.[0]?.message || payload?.message || payload?.error || "").trim();
      throw new Error(`Upstox instrument search HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    const today = istDate(new Date());
    const choices = (Array.isArray(payload?.data) ? payload.data : []).filter(item => {
      const expiry = String(item?.expiry || "").slice(0, 10);
      const itemUnderlying = String(item?.underlying_symbol || "").trim().toUpperCase();
      const segment = String(item?.segment || "").toUpperCase();
      return String(item?.instrument_key || "").trim() &&
        String(item?.instrument_type || "").toUpperCase() === "FUT" &&
        (exchange === "BSE" ? segment === "BSE_FO" : segment === "NSE_FO") &&
        itemUnderlying === underlying && String(item?.underlying_type || "").toUpperCase() === "INDEX" &&
        /^\d{4}-\d{2}-\d{2}$/.test(expiry) && expiry >= today;
    }).sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
    const picked = choices[0];
    if (!picked) return { ok: false, provider: "UPSTOX", error: `No unexpired ${underlying} index futures contract returned by Upstox instrument search` };
    return {
      ok: true, provider: "UPSTOX", instrumentKey: String(picked.instrument_key),
      tradingSymbol: String(picked.trading_symbol || ""), expiry: String(picked.expiry).slice(0, 10),
      underlying, exchange, instrumentType: String(picked.instrument_type || "FUT")
    };
  } catch (error) {
    return {
      ok: false, provider: "UPSTOX",
      error: String(error?.message || error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240)
    };
  }
}

export async function fetchUpstoxHistoricalCandles({
  symbol = "NIFTY", role = "index", instrumentKey = "", fromDate, toDate,
  intervalMinutes = 5, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 9000
} = {}) {
  const token = String(env.UPSTOX_ACCESS_TOKEN || "").trim();
  let key = String(instrumentKey || resolveUpstoxInstrumentKey(symbol, role, env)).trim();
  let resolvedInstrument = null;
  if (!token) return { ok: false, provider: "UPSTOX", rows: [], error: "UPSTOX_ACCESS_TOKEN not configured" };
  if (!key && role === "futures") {
    const lookup = await fetchUpstoxFuturesInstrument({ symbol, env, fetchImpl, timeoutMs: Math.min(timeoutMs, 7000) });
    if (!lookup.ok) return { ok: false, provider: "UPSTOX", rows: [], error: lookup.error };
    key = lookup.instrumentKey;
    resolvedInstrument = lookup;
  }
  if (!key) return { ok: false, provider: "UPSTOX", rows: [], error: `${envKeyName(symbol, role)} not configured` };
  const interval = Number(intervalMinutes);
  // V3 supports native hour candles (1-5 hours). The public helper keeps
  // intervalMinutes for compatibility but maps multiples of 60 to unit=hours.
  const useHours = Number.isInteger(interval) && interval >= 60 && interval % 60 === 0 && interval / 60 <= 5;
  const apiUnit = useHours ? "hours" : "minutes";
  const apiInterval = useHours ? interval / 60 : interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 300 ||
      (interval >= 60 && !useHours && interval !== 60))
    return { ok: false, provider: "UPSTOX", rows: [], error: "Upstox interval must be 1-59 minutes or 1-5 whole hours expressed as 60-300 minutes" };
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

  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/${apiUnit}/${apiInterval}/${to}/${from}`;
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
    let rows = normalizeUpstoxCandles(payload);
    if (rows.length < 20) throw new Error(`Upstox historical returned only ${rows.length} valid candles; at least 20 required`);

    // Upstox V3 separates the historical range from today's live-session bars.
    // Pull today's intraday candles for index charts as well as futures, so an
    // active index WebSocket cannot coexist with a chart stuck on the last older history bar.
    // Futures use the same current-session request for verified volume/VWAP gates.
    let intradayRows = 0;
    let intradayError = null;
    const today = istDate(new Date());
    if (to === today) {
      try {
        const intradayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(key)}/${apiUnit}/${apiInterval}`;
        const intradayResponse = await fetchImpl(intradayUrl, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const intradayText = await intradayResponse.text();
        let intradayPayload;
        try { intradayPayload = intradayText ? JSON.parse(intradayText) : {}; }
        catch { throw new Error(`Upstox intraday HTTP ${intradayResponse.status}: non-JSON response`); }
        if (!intradayResponse.ok || (intradayPayload?.status && String(intradayPayload.status).toLowerCase() !== "success")) {
          const message = String(intradayPayload?.errors?.[0]?.message || intradayPayload?.message || intradayPayload?.error || "").trim();
          throw new Error(`Upstox intraday HTTP ${intradayResponse.status}${message ? `: ${message}` : ""}`);
        }
        const currentRows = normalizeUpstoxCandles(intradayPayload).filter(row => istDate(row.t) === today);
        intradayRows = currentRows.length;
        // Prefer intraday bars when timestamps overlap a historical response.
        const merged = new Map(rows.map(row => [row.t, row]));
        for (const row of currentRows) merged.set(row.t, row);
        rows = [...merged.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
        if (!currentRows.length) intradayError = "Upstox intraday endpoint returned no candles dated today.";
      } catch (error) {
        intradayError = String(error?.message || error).replace(/Bearer\\s+\\S+/gi, "Bearer [redacted]").slice(0, 240);
      }
    }
    return {
      ok: true, provider: "UPSTOX_HISTORICAL", instrumentKey: key,
      resolvedInstrument, rows, intradayRows, intradayError, error: null, fromDate: from, toDate: to
    };
  } catch (error) {
    return { ok: false, provider: "UPSTOX", rows: [], error: String(error?.message || error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240) };
  }
}

export function shouldUseUpstoxFuturesFallback({
  rateRejected = false, rowCount = 0, benchmarkRatio10d = null, sessionVwap = null
} = {}) {
  const count = Number(rowCount);
  const ratioAvailable = benchmarkRatio10d !== null && benchmarkRatio10d !== undefined &&
    Number.isFinite(Number(benchmarkRatio10d));
  const vwapAvailable = sessionVwap !== null && sessionVwap !== undefined &&
    Number.isFinite(Number(sessionVwap));
  return Boolean(rateRejected || !Number.isFinite(count) || count < 100 ||
    !ratioAvailable || !vwapAvailable);
}
export function upstoxConfigStatus({ symbol = "NIFTY", role = "index", env = process.env } = {}) {
  const tokenConfigured = Boolean(String(env.UPSTOX_ACCESS_TOKEN || "").trim());
  const instrumentKeyConfigured = Boolean(resolveUpstoxInstrumentKey(symbol, role, env));
  const dynamicFuturesLookup = role === "futures" && !instrumentKeyConfigured;
  return {
    configured: tokenConfigured && (instrumentKeyConfigured || dynamicFuturesLookup),
    tokenConfigured,
    instrumentKeyConfigured,
    instrumentKeyResolution: instrumentKeyConfigured ? "CONFIGURED" : dynamicFuturesLookup ? "DYNAMIC_UPSTOX_SEARCH" : "MISSING",
    role,
    symbol: String(symbol || "NIFTY").toUpperCase()
  };
}
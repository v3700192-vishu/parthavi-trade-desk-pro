const TIMESTAMP_KEYS = ["exchange_timestamp","exchangeTimestamp","exchangeTimeStamp","exchFeedTime","exchange_time","timestamp"];
function exchangeTimestampMs(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of TIMESTAMP_KEYS) {
    const raw = payload[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value < 100000000000 ? value * 1000 : value;
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}
function exchangeTickAgeMs(payload, now = Date.now()) {
  const timestamp = exchangeTimestampMs(payload);
  return timestamp == null ? null : now - timestamp;
}
function isFreshExchangeTick(payload, now = Date.now(), maxAgeMs = 120000, maxFutureMs = 15000) {
  const age = exchangeTickAgeMs(payload, now);
  const rawPrice = payload?.last_traded_price ?? payload?.ltp ?? payload?.lastTradedPrice;
  const price = Number(rawPrice);
  return age != null && age <= maxAgeMs && age >= -maxFutureMs &&
    rawPrice != null && rawPrice !== "" && Number.isFinite(price) && price > 0;
}
export { exchangeTimestampMs, exchangeTickAgeMs, isFreshExchangeTick };
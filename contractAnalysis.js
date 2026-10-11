function finiteOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * Derive contract-specific quality checks without coercing absent provider values to zero.
 * "ready" means the displayed quote/greeks passed these data checks, not that a trade is approved.
 */
export function summarizeContractMetrics(contract = {}, greeks = null) {
  const ltp = positiveOrNull(contract.ltp);
  const bid = positiveOrNull(contract.bid);
  const ask = positiveOrNull(contract.ask);
  const oi = finiteOrNull(contract.oi ?? contract.openInterest);
  const volume = finiteOrNull(contract.volume ?? contract.tradeVolume);
  const change = finiteOrNull(contract.change);

  const quoteSideValid = bid !== null && ask !== null && ask >= bid;
  const spreadPoints = quoteSideValid ? Number((ask - bid).toFixed(4)) : null;
  const midpoint = quoteSideValid ? (bid + ask) / 2 : null;
  const spreadPct = midpoint !== null && midpoint > 0 ? Number((spreadPoints / midpoint * 100).toFixed(3)) : null;
  const spreadStatus = !quoteSideValid ? "UNVERIFIED" : spreadPct > 1.5 ? "WIDE" : "PASS";

  const delta = finiteOrNull(greeks?.delta);
  const theta = finiteOrNull(greeks?.theta);
  const gamma = finiteOrNull(greeks?.gamma);
  const vega = finiteOrNull(greeks?.vega);
  const iv = positiveOrNull(greeks?.iv ?? greeks?.impliedVolatility ?? contract.iv);
  const absDelta = delta === null ? null : Math.abs(delta);
  const absTheta = theta === null ? null : Math.abs(theta);
  const greeksPresent = delta !== null && theta !== null;
  const greekRiskStatus = !greeksPresent
    ? "UNVERIFIED"
    : absTheta >= 10 || absDelta < 0.2
      ? "NO TRADE"
      : absTheta >= 6 || absDelta < 0.35
        ? "CAUTION"
        : "PASS";

  const checks = {
    ltp: ltp !== null,
    spread: quoteSideValid && spreadPct <= 1.5,
    oi: oi !== null && oi > 0,
    volume: volume !== null && volume > 0,
    greeks: greeksPresent && greekRiskStatus === "PASS",
    iv: iv !== null
  };

  const reasons = [];
  if (ltp === null) reasons.push("Live option LTP is missing or invalid.");
  if (!quoteSideValid) reasons.push("Verified bid/ask quote is unavailable; spread cannot be calculated.");
  else if (spreadPct > 1.5) reasons.push(`Bid/ask spread is wide at ${spreadPct.toFixed(3)}%; do not chase this contract.`);
  if (oi === null || oi <= 0) reasons.push("Open interest is missing or zero; liquidity is unverified.");
  if (volume === null || volume <= 0) reasons.push("Traded volume is missing or zero; liquidity is unverified.");
  if (!greeksPresent) reasons.push("Live Delta/Theta Greeks are unavailable for this exact strike and expiry.");
  else if (greekRiskStatus === "NO TRADE") reasons.push("Option Greek risk is outside the configured buying limits (|Delta| below 0.20 or |Theta| at least 10).");
  else if (greekRiskStatus === "CAUTION") reasons.push("Option Greek profile needs caution (|Delta| below 0.35 or |Theta| at least 6).");
  if (iv === null) reasons.push("Implied volatility (IV) is unavailable; IV-based risk is unverified.");

  const requiredPass = checks.ltp && checks.spread && checks.oi && checks.volume && checks.greeks && checks.iv;
  const values = {
    ltp, change, bid, ask, spreadPoints, spreadPct, spreadStatus,
    oi, volume, iv, delta, theta, gamma, vega,
    greekRiskStatus,
    checks,
    ready: requiredPass,
    status: requiredPass ? "VERIFIED" : "PARTIAL / UNVERIFIED",
    reasons
  };
  return values;
}
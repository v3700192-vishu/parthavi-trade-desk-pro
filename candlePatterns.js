/*
 * Local-only OHLC candlestick + chart-structure analysis.
 * Pattern strength is a confluence score, never a probability or standalone trade instruction.
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const round = (v, d = 2) => Number(v.toFixed(d));

function cleanRows(input) {
  const rows = (Array.isArray(input) ? input : []).map(r => ({
    t: r?.t ?? null, o: num(r?.o), h: num(r?.h), l: num(r?.l), c: num(r?.c)
  })).filter(r => r.o !== null && r.h !== null && r.l !== null && r.c !== null &&
    r.o > 0 && r.c > 0 && r.h >= Math.max(r.o, r.c) && r.l <= Math.min(r.o, r.c) && r.h >= r.l);
  if (rows.length && rows.every(r => Number.isFinite(Date.parse(r.t)))) {
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const unique = [];
    for (const r of rows) {
      if (unique.length && Date.parse(unique.at(-1).t) === Date.parse(r.t)) unique[unique.length - 1] = r;
      else unique.push(r);
    }
    return unique;
  }
  return rows;
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function calcContext(rows) {
  const closes = rows.map(r => r.c);
  const e8 = ema(closes.slice(-Math.max(8, Math.min(closes.length, 80))), 8);
  const e21 = ema(closes.slice(-Math.max(21, Math.min(closes.length, 100))), 21);
  const trs = [];
  for (let i = Math.max(0, rows.length - 14); i < rows.length; i++) {
    const prev = rows[i - 1]?.c ?? rows[i].c;
    trs.push(Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - prev), Math.abs(rows[i].l - prev)));
  }
  const atr = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
  let gains = 0, losses = 0;
  if (rows.length >= 15) {
    const recent = rows.slice(-15);
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i].c - recent[i - 1].c;
      gains += Math.max(0, diff); losses += Math.max(0, -diff);
    }
  }
  const rsi = rows.length >= 15 ? (losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)) : null;
  const trend = e8 === null || e21 === null ? "UNKNOWN" : e8 > e21 ? "BULLISH" : e8 < e21 ? "BEARISH" : "NEUTRAL";
  return { ema8: e8, ema21: e21, atr, rsi, trend };
}
function barShape(r) {
  const range = r.h - r.l, body = Math.abs(r.c - r.o);
  return {
    range, body, upper: r.h - Math.max(r.o, r.c), lower: Math.min(r.o, r.c) - r.l,
    bullish: r.c > r.o, bearish: r.c < r.o,
    bodyTop: Math.max(r.o, r.c), bodyBottom: Math.min(r.o, r.c)
  };
}
function analyzeLatestCandles(rows, context) {
  if (rows.length < 2) return [];
  const i = rows.length - 1, a = rows[i], b = rows[i - 1], sa = barShape(a), sb = barShape(b);
  const c = rows[i - 2], sc = c ? barShape(c) : null;
  const out = [];
  const add = (name, direction, strength, category = "CANDLE", note = "") => {
    if (!out.some(p => p.name === name)) out.push({ name, direction, strength, category, note });
  };
  if (sa.range <= 0) return out;
  const bodyRatio = sa.body / sa.range;
  const trend = context.trend;
  if (bodyRatio <= 0.10) {
    if (sa.lower >= sa.range * 0.60 && sa.upper <= sa.range * 0.15) add("DRAGONFLY DOJI", trend === "BEARISH" ? "BULLISH" : "NEUTRAL", 2, "CANDLE", "Reversal needs follow-through.");
    else if (sa.upper >= sa.range * 0.60 && sa.lower <= sa.range * 0.15) add("GRAVESTONE DOJI", trend === "BULLISH" ? "BEARISH" : "NEUTRAL", 2, "CANDLE", "Reversal needs follow-through.");
    else add("DOJI", "NEUTRAL", 1, "CANDLE", "Indecision; wait for the next candle.");
  } else if (bodyRatio <= 0.32 && sa.upper > sa.body * 0.65 && sa.lower > sa.body * 0.65) {
    add("SPINNING TOP", "NEUTRAL", 1, "CANDLE", "Small real body; momentum is uncertain.");
  }
  if (sa.lower >= Math.max(sa.body * 2, sa.range * 0.50) && sa.upper <= sa.range * 0.25 && bodyRatio <= 0.45) {
    if (trend === "BEARISH") add("HAMMER", "BULLISH", 3, "CANDLE", "Bullish reversal shape after a downtrend; confirm above its high.");
    else if (trend === "BULLISH") add("HANGING MAN", "BEARISH", 2, "CANDLE", "Potential warning after an uptrend; needs bearish confirmation.");
    else add("HAMMER-SHAPED CANDLE", "NEUTRAL", 1, "CANDLE", "Context is unclear; no directional vote.");
  }
  if (sa.upper >= Math.max(sa.body * 2, sa.range * 0.50) && sa.lower <= sa.range * 0.25 && bodyRatio <= 0.45) {
    if (trend === "BEARISH") add("INVERTED HAMMER", "BULLISH", 2, "CANDLE", "Possible reversal; confirmation is required.");
    else if (trend === "BULLISH") add("SHOOTING STAR", "BEARISH", 3, "CANDLE", "Potential rejection after an uptrend; confirm below its low.");
    else add("SHOOTING-STAR-SHAPED CANDLE", "NEUTRAL", 1, "CANDLE", "Context is unclear; no directional vote.");
  }
  if (bodyRatio >= 0.88 && sa.upper <= sa.range * 0.08 && sa.lower <= sa.range * 0.08)
    add(sa.bullish ? "BULLISH MARUBOZU" : "BEARISH MARUBOZU", sa.bullish ? "BULLISH" : "BEARISH", 2, "CANDLE", "Strong one-candle body; check the broader trend.");
  if (sb.body > 0 && sa.body > 0) {
    const engulf = sa.bodyTop >= sb.bodyTop && sa.bodyBottom <= sb.bodyBottom;
    if (sb.bearish && sa.bullish && engulf) add("BULLISH ENGULFING", "BULLISH", 4, "CANDLE", "Bull body engulfs prior bear body; wait for follow-through.");
    if (sb.bullish && sa.bearish && engulf) add("BEARISH ENGULFING", "BEARISH", 4, "CANDLE", "Bear body engulfs prior bull body; wait for follow-through.");
    if (sb.bullish && sa.bearish && sa.bodyTop < sb.bodyTop && sa.bodyBottom > sb.bodyBottom) add("BEARISH HARAMI", "BEARISH", 2, "CANDLE", "Smaller bearish body inside prior bullish body.");
    if (sb.bearish && sa.bullish && sa.bodyTop < sb.bodyTop && sa.bodyBottom > sb.bodyBottom) add("BULLISH HARAMI", "BULLISH", 2, "CANDLE", "Smaller bullish body inside prior bearish body.");
    const mid = (b.o + b.c) / 2;
    if (sb.bearish && sa.bullish && a.o <= b.l && a.c > mid && a.c < b.o) add("PIERCING LINE", "BULLISH", 3, "CANDLE", "Bull candle recovers above prior body midpoint.");
    if (sb.bullish && sa.bearish && a.o >= b.h && a.c < mid && a.c > b.o) add("DARK CLOUD COVER", "BEARISH", 3, "CANDLE", "Bear candle falls below prior body midpoint.");
    if (context.atr && Math.abs(a.h - b.h) <= context.atr * 0.18 && sb.bullish && sa.bearish && trend === "BULLISH") add("TWEEZER TOP", "BEARISH", 2, "CANDLE", "Similar highs across bull-to-bear candles suggest possible resistance; confirmation required.");
    if (context.atr && Math.abs(a.l - b.l) <= context.atr * 0.18 && sb.bearish && sa.bullish && trend === "BEARISH") add("TWEEZER BOTTOM", "BULLISH", 2, "CANDLE", "Similar lows across bear-to-bull candles suggest possible support; confirmation required.");
    if (a.h < b.h && a.l > b.l) add("INSIDE BAR", "NEUTRAL", 1, "CANDLE", "Range compression; wait for a verified breakout.");
    if (a.h > b.h && a.l < b.l) add("OUTSIDE BAR", "NEUTRAL", 1, "CANDLE", "Wide range; direction depends on close and context.");
  }
  if (c && sc && sb.body > 0 && sc.body > 0) {
    const midC = (c.o + c.c) / 2;
    if (sc.bearish && sc.body / sc.range >= 0.45 && sb.body / sb.range <= 0.35 && sa.bullish && a.c > midC)
      add("MORNING STAR", "BULLISH", 4, "CANDLE", "Three-candle bullish reversal shape; confirm with follow-through.");
    if (sc.bullish && sc.body / sc.range >= 0.45 && sb.body / sb.range <= 0.35 && sa.bearish && a.c < midC)
      add("EVENING STAR", "BEARISH", 4, "CANDLE", "Three-candle bearish reversal shape; confirm with follow-through.");
    const three = rows.slice(-3), shapes = three.map(barShape);
    if (shapes.every(s => s.bullish) && three[1].c > three[0].c && three[2].c > three[1].c &&
        shapes.every(s => s.body / Math.max(s.range, 1e-9) >= 0.45))
      add("THREE WHITE SOLDIERS", "BULLISH", 3, "CANDLE", "Three rising bullish bodies; check for nearby resistance.");
    if (shapes.every(s => s.bearish) && three[1].c < three[0].c && three[2].c < three[1].c &&
        shapes.every(s => s.body / Math.max(s.range, 1e-9) >= 0.45))
      add("THREE BLACK CROWS", "BEARISH", 3, "CANDLE", "Three falling bearish bodies; check for nearby support.");
    if (sc.bearish && sc.body / Math.max(sc.range, 1e-9) >= 0.45 && sb.body / Math.max(sb.range, 1e-9) <= 0.35 &&
        sb.bodyTop <= sc.bodyTop && sb.bodyBottom >= sc.bodyBottom && sa.bullish && a.c > c.o)
      add("THREE INSIDE UP", "BULLISH", 3, "CANDLE", "A small inside candle followed by bullish confirmation; validate nearby resistance.");
    if (sc.bullish && sc.body / Math.max(sc.range, 1e-9) >= 0.45 && sb.body / Math.max(sb.range, 1e-9) <= 0.35 &&
        sb.bodyTop <= sc.bodyTop && sb.bodyBottom >= sc.bodyBottom && sa.bearish && a.c < c.o)
      add("THREE INSIDE DOWN", "BEARISH", 3, "CANDLE", "A small inside candle followed by bearish confirmation; validate nearby support.");
    const firstAndMiddleEngulfed = sb.bodyTop >= sc.bodyTop && sb.bodyBottom <= sc.bodyBottom;
    if (sc.bearish && sa.bullish && sb.bullish && firstAndMiddleEngulfed && a.c > b.c)
      add("THREE OUTSIDE UP", "BULLISH", 3, "CANDLE", "Bullish engulfing followed by a higher close; check follow-through.");
    if (sc.bullish && sa.bearish && sb.bearish && firstAndMiddleEngulfed && a.c < b.c)
      add("THREE OUTSIDE DOWN", "BEARISH", 3, "CANDLE", "Bearish engulfing followed by a lower close; check follow-through.");
    const five = rows.slice(-5), fiveShapes = five.map(barShape);
    if (five.length === 5) {
      const [f0, f1, f2, f3, f4] = five, [q0, q1, q2, q3, q4] = fiveShapes;
      const pullbackInside = [f1, f2, f3].every((r, j) => r.h <= f0.h && r.l >= f0.l &&
        fiveShapes[j + 1].body < q0.body && fiveShapes[j + 1].bearish);
      if (q0.bullish && q0.body / Math.max(q0.range, 1e-9) >= 0.5 && pullbackInside && q4.bullish && f4.c > f0.c)
        add("RISING THREE METHODS", "BULLISH", 3, "CANDLE", "Bull trend, contained three-candle pullback, then renewed advance.");
      const pullbackUpInside = [f1, f2, f3].every((r, j) => r.h <= f0.h && r.l >= f0.l &&
        fiveShapes[j + 1].body < q0.body && fiveShapes[j + 1].bullish);
      if (q0.bearish && q0.body / Math.max(q0.range, 1e-9) >= 0.5 && pullbackUpInside && q4.bearish && f4.c < f0.c)
        add("FALLING THREE METHODS", "BEARISH", 3, "CANDLE", "Bear trend, contained three-candle pullback, then renewed decline.");
    }
  }
  return out;
}
function analyzeStructure(rows, context) {
  if (rows.length < 20) return { patterns: [], support: null, resistance: null, note: "At least 20 completed candles are needed for chart-structure checks." };
  const recent = rows.slice(-60), last = recent.at(-1), prior = recent.slice(0, -1);
  const atr = context.atr || (last.h - last.l) || 1;
  const highs = prior.map(r => r.h), lows = prior.map(r => r.l);
  const resistance = Math.min(...highs.filter(x => x >= last.c));
  const support = Math.max(...lows.filter(x => x <= last.c));
  const prior20 = rows.slice(-21, -1);
  const high20 = Math.max(...prior20.map(r => r.h)), low20 = Math.min(...prior20.map(r => r.l));
  const patterns = [];
  if (last.c > high20 + atr * 0.03) patterns.push({ name: "20-BAR RESISTANCE BREAKOUT", direction: "BULLISH", strength: 4, category: "STRUCTURE", note: "Close cleared the previous 20-bar high; verify volume and retest." });
  if (last.c < low20 - atr * 0.03) patterns.push({ name: "20-BAR SUPPORT BREAKDOWN", direction: "BEARISH", strength: 4, category: "STRUCTURE", note: "Close broke the previous 20-bar low; verify volume and retest." });
  const pivotHighs = [], pivotLows = [];
  for (let i = Math.max(2, rows.length - 40); i < rows.length - 2; i++) {
    if (rows[i].h >= rows[i - 1].h && rows[i].h > rows[i - 2].h && rows[i].h >= rows[i + 1].h && rows[i].h > rows[i + 2].h) pivotHighs.push({ i, value: rows[i].h });
    if (rows[i].l <= rows[i - 1].l && rows[i].l < rows[i - 2].l && rows[i].l <= rows[i + 1].l && rows[i].l < rows[i + 2].l) pivotLows.push({ i, value: rows[i].l });
  }
  const h1 = pivotHighs.at(-1), h2 = pivotHighs.at(-2), l1 = pivotLows.at(-1), l2 = pivotLows.at(-2);
  if (h1 && h2 && h1.i - h2.i >= 3 && Math.abs(h1.value - h2.value) <= Math.max(atr * 0.55, last.c * 0.0012) && last.c < Math.min(h1.value, h2.value) - atr * 0.20)
    patterns.push({ name: "DOUBLE TOP / NECKLINE BREAK", direction: "BEARISH", strength: 4, category: "STRUCTURE", note: "Two similar swing highs with price below the top zone; confirm neckline and volume." });
  if (l1 && l2 && l1.i - l2.i >= 3 && Math.abs(l1.value - l2.value) <= Math.max(atr * 0.55, last.c * 0.0012) && last.c > Math.max(l1.value, l2.value) + atr * 0.20)
    patterns.push({ name: "DOUBLE BOTTOM / RECOVERY", direction: "BULLISH", strength: 4, category: "STRUCTURE", note: "Two similar swing lows with price above the base zone; confirm neckline and volume." });
  return { patterns, support: Number.isFinite(support) ? round(support) : null,
    resistance: Number.isFinite(resistance) ? round(resistance) : null,
    note: "Levels are recent candle-derived references, not guaranteed support/resistance." };
}
export function analyzeCandlestickPatterns(inputRows = []) {
  const rows = cleanRows(inputRows);
  if (!rows.length) return {
    available: false, barsAnalyzed: 0, asOf: null, direction: "NEUTRAL", score: 0, scoreAdjustment: 0,
    latestPatterns: [], chartPatterns: [], support: null, resistance: null, trend: "UNKNOWN",
    triggerBullish: false, triggerBearish: false, reason: "No valid OHLC candles are available."
  };
  const context = calcContext(rows);
  const latestPatterns = analyzeLatestCandles(rows, context);
  const structure = analyzeStructure(rows, context);
  const directional = [...latestPatterns, ...structure.patterns].filter(p => ["BULLISH", "BEARISH"].includes(p.direction));
  const bull = directional.filter(p => p.direction === "BULLISH").reduce((s, p) => s + p.strength, 0);
  const bear = directional.filter(p => p.direction === "BEARISH").reduce((s, p) => s + p.strength, 0);
  const gap = bull - bear;
  const rawScore = Math.abs(gap) < 1.5 ? 0 : gap;
  const scoreAdjustment = Math.round(clamp(rawScore * 0.8, -8, 8));
  const direction = scoreAdjustment >= 2 ? "BULLISH" : scoreAdjustment <= -2 ? "BEARISH" : "NEUTRAL";
  const triggerBullish = latestPatterns.some(p => p.direction === "BULLISH" && p.strength >= 2);
  const triggerBearish = latestPatterns.some(p => p.direction === "BEARISH" && p.strength >= 2);
  return {
    available: rows.length >= 2, barsAnalyzed: Math.min(rows.length, 60), asOf: rows.at(-1).t,
    direction, score: round(gap, 1), scoreAdjustment, trend: context.trend,
    ema8: context.ema8 === null ? null : round(context.ema8),
    ema21: context.ema21 === null ? null : round(context.ema21),
    rsi14: context.rsi === null ? null : round(context.rsi, 1),
    atr14: context.atr === null ? null : round(context.atr),
    bullishPatternWeight: bull, bearishPatternWeight: bear,
    latestPatterns, chartPatterns: structure.patterns, support: structure.support, resistance: structure.resistance,
    triggerBullish, triggerBearish,
    reason: rows.length < 20 ? "Candlestick shapes are provisional; chart-structure checks need at least 20 candles." : structure.note,
    disclaimer: "Patterns describe historical candle shapes, not calibrated win probabilities. Confirm using live-feed freshness, timeframe alignment, volume, risk and out-of-sample tests."
  };
}

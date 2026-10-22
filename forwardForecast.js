/*
 * Forward-looking historical analogue forecast for completed index candles.
 * Uses only features available at each candle close and labels from future closes.
 * Probabilities are empirical frequencies, shrunk toward the recent base rate;
 * they are estimates, not calibrated guarantees or trade-entry instructions.
 */
const LABELS = ["UP", "DOWN", "RANGE"];
const HORIZONS = [
  { minutes: 5, bars: 1, thresholdAtr: 0.14 },
  { minutes: 15, bars: 3, thresholdAtr: 0.25 }
];
const LOOKBACK_BARS = 500;
const TARGET_ANALOGS = 40;
const MIN_ANALOGS = 24;
const PRIOR_WEIGHT = 8;

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}
function avg(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
function round1(value) { return Number(value.toFixed(1)); }

function prepareRows(rows) {
  const clean = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const c=finite(row?.c), h=finite(row?.h), l=finite(row?.l), o=finite(row?.o);
    if (c===null || h===null || l===null || o===null || h<l) continue;
    clean.push({t:row.t??null,o,h,l,c});
  }
  const allTimed = clean.every(r => r.t != null && Number.isFinite(Date.parse(r.t)));
  if (allTimed) {
    clean.sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
    const deduped=[];
    for (const row of clean) {
      const previous=deduped.at(-1);
      if (previous && Date.parse(previous.t)===Date.parse(row.t)) deduped[deduped.length-1]=row;
      else deduped.push(row);
    }
    return deduped;
  }
  return clean;
}

function calculateFeatures(rows) {
  const n=rows.length, close=rows.map(r=>r.c), ema9=Array(n), ema20=Array(n), atr=Array(n), rsi=Array(n);
  const tr=Array(n);
  if (!n) return [];
  ema9[0]=close[0]; ema20[0]=close[0];
  const k9=2/10, k20=2/21;
  for(let i=1;i<n;i++){
    ema9[i]=close[i]*k9+ema9[i-1]*(1-k9);
    ema20[i]=close[i]*k20+ema20[i-1]*(1-k20);
  }
  for(let i=0;i<n;i++){
    const prev=i?close[i-1]:close[i];
    tr[i]=Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-prev),Math.abs(rows[i].l-prev));
    if(i>=13) atr[i]=avg(tr.slice(i-13,i+1));
    if(i>=14){
      let gain=0,loss=0;
      for(let j=i-13;j<=i;j++){
        const change=close[j]-close[j-1];
        gain+=Math.max(0,change); loss+=Math.max(0,-change);
      }
      const ag=gain/14, al=loss/14;
      rsi[i]=al===0?100:100-100/(1+ag/al);
    }
  }
  return rows.map((_,i)=>{
    const a=atr[i];
    if(i<20||!Number.isFinite(a)||a<=0||!Number.isFinite(rsi[i])) return null;
    return [
      (close[i]-close[i-3])/a,
      (close[i]-close[i-6])/a,
      (close[i]-ema9[i])/a,
      (close[i]-ema20[i])/a,
      (rsi[i]-50)/15
    ];
  });
}

function outcomeAt(rows, index, horizon, atr, thresholdAtr) {
  const a=atr[index];
  if(!Number.isFinite(a)||a<=0||!rows[index+horizon]) return null;
  const move=rows[index+horizon].c-rows[index].c;
  const band=a*thresholdAtr;
  return move>band?"UP":move < -band?"DOWN":"RANGE";
}

function distance(a,b) {
  const scales=[0.8,1.15,0.75,1.0,0.85];
  let sum=0;
  for(let i=0;i<a.length;i++){const d=(a[i]-b[i])/scales[i];sum+=d*d;}
  return sum/a.length;
}

function toPercentages(counts, base, sampleSize) {
  const exact=LABELS.map(label=>100*(counts[label]+PRIOR_WEIGHT*(base[label]||0))/(sampleSize+PRIOR_WEIGHT));
  const whole=exact.map(Math.floor);
  let remaining=100-whole.reduce((a,b)=>a+b,0);
  const order=exact.map((v,i)=>({i,frac:v-whole[i]})).sort((a,b)=>b.frac-a.frac);
  for(let i=0;i<remaining;i++) whole[order[i%order.length].i]++;
  return {up:whole[0],down:whole[1],sideways:whole[2]};
}

function forecastHorizon(rows, features, atr, config) {
  const n=rows.length, current=features[n-1];
  const unavailable=(reason)=>({
    available:false,horizonMinutes:config.minutes,probabilities:null,sampleSize:0,
    direction:"UNAVAILABLE",reason,asOf:rows.at(-1)?.t??null,
    method:"Nearest historical analogues, forward-labeled and base-rate-smoothed"
  });
  if(!current) return unavailable("The latest closed candle does not have enough history for indicators.");
  const start=Math.max(20,n-LOOKBACK_BARS-config.bars-1);
  const candidates=[],baseCounts={UP:0,DOWN:0,RANGE:0};
  for(let i=start;i<n-config.bars;i++){
    if(!features[i]) continue;
    const label=outcomeAt(rows,i,config.bars,atr,config.thresholdAtr);
    if(!label) continue;
    baseCounts[label]++;
    candidates.push({i,label,distance:distance(current,features[i])});
  }
  const total=candidates.length;
  if(total<MIN_ANALOGS) return unavailable("Not enough completed historical outcomes for a directional probability.");
  const base={};
  for(const label of LABELS) base[label]=(baseCounts[label]||0)/total;
  candidates.sort((a,b)=>a.distance-b.distance);
  const selected=[];
  for(const candidate of candidates){
    // Avoid counting heavily overlapping forward-return windows as separate analogues.
    if(selected.some(x=>Math.abs(x.i-candidate.i)<=config.bars)) continue;
    selected.push(candidate);
    if(selected.length>=TARGET_ANALOGS) break;
  }
  if(selected.length<MIN_ANALOGS) return unavailable("Too few non-overlapping historical analogues for a stable estimate.");
  const counts={UP:0,DOWN:0,RANGE:0};
  for(const sample of selected) counts[sample.label]++;
  const probabilities=toPercentages(counts,base,selected.length);
  const best=Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0];
  const direction=best[0]==="UP"?"UPWARD BIAS":best[0]==="DOWN"?"DOWNWARD BIAS":"RANGE / MIXED";
  return {
    available:true,horizonMinutes:config.minutes,probabilities,sampleSize:selected.length,
    rawCounts:{up:counts.UP,down:counts.DOWN,sideways:counts.RANGE},
    baseRates:{up:round1(base.UP*100),down:round1(base.DOWN*100),sideways:round1(base.RANGE*100)},
    direction,leadingProbability:best[1],
    sampleQuality:selected.length>=35?"MODERATE":"LIMITED",
    asOf:rows.at(-1)?.t??null,
    outcomeRule:"UP/DOWN means the future close crosses ±"+config.thresholdAtr+" ATR; otherwise RANGE.",
    method:"Nearest historical analogues using 3-bar/6-bar momentum, EMA9/EMA20 distance and RSI14; empirical outcome rates shrunk toward the recent base rate."
  };
}

export function buildForwardForecast(inputRows, options={}) {
  const rows=prepareRows(inputRows);
  const last=rows.at(-1)||null;
  const baseResult=(reason)=>{
    const horizons={};
    for(const config of HORIZONS)horizons[String(config.minutes)]={
      available:false,horizonMinutes:config.minutes,probabilities:null,sampleSize:0,
      direction:"UNAVAILABLE",reason,asOf:last?.t??null,
      method:"Nearest historical analogues, forward-labeled and base-rate-smoothed"
    };
    return {
      available:false,model:"HISTORICAL_ANALOGUE_V1",modelLabel:"Forward probability estimate",
      asOf:last?.t??null,horizons,
      interpretation:"Forecast is shown only when the exchange session and latest closed candle can be verified. Percentages are not guarantees or option-premium win rates.",
      calibrationStatus:"EMPIRICAL_ANALOGUE_ESTIMATE — needs ongoing walk-forward calibration before it should be treated as a calibrated probability."
    };
  };
  if(options.marketOpen===false) return baseResult("Market session is closed; no live forward estimate is active.");
  if(options.marketOpen===true){
    const start=last?.t==null?NaN:Date.parse(last.t);
    if(!Number.isFinite(start))return baseResult("Latest candle has no verifiable timestamp; live probability is withheld.");
    const closedAt=start+5*60_000, ageMs=Date.now()-closedAt;
    if(ageMs < -60_000 || ageMs > 10*60_000)return baseResult("Latest completed five-minute candle is stale or future-dated; live probability is withheld.");
  }
  const lookback=Number.isFinite(Number(options.lookbackBars))?Math.max(100,Math.floor(Number(options.lookbackBars))):LOOKBACK_BARS;
  // The default is 500 bars; smaller custom lookbacks are only for deterministic tests.
  const selectedRows=rows.length>lookback?rows.slice(-lookback):rows;
  const features=calculateFeatures(selectedRows);
  const trueRanges=selectedRows.map((row,i)=>{
    const previous=i?selectedRows[i-1].c:row.c;
    return Math.max(row.h-row.l,Math.abs(row.h-previous),Math.abs(row.l-previous));
  });
  const atr=selectedRows.map((_,i)=>i>=13?avg(trueRanges.slice(i-13,i+1)):null);
  const horizons={};
  for(const config of HORIZONS) horizons[String(config.minutes)]=forecastHorizon(selectedRows,features,atr,config);
  return {
    available:Object.values(horizons).some(h=>h.available),
    model:"HISTORICAL_ANALOGUE_V1",
    modelLabel:"Forward probability estimate",
    asOf:selectedRows.at(-1)?.t??null,
    horizons,
    interpretation:"Probabilities estimate future close direction over the stated horizon from similar past candle states. They are not a guaranteed result, not option-premium win rates, and not an entry signal.",
    calibrationStatus:"EMPIRICAL_ANALOGUE_ESTIMATE — needs ongoing walk-forward calibration before it should be treated as a calibrated probability."
  };
}

[executed on device: KiranKhoradiya (c22a64af-c32d-4918-beea-b3204b43f035)]
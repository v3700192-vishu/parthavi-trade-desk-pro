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
const MOVE_POINTS = 100;
const MOVE_HORIZONS = [
  { minutes: 30, bars: 6 },
  { minutes: 60, bars: 12 }
];
const MOVE_LABELS = ["UP_100", "DOWN_100", "BOTH_100", "NEITHER_100"];
const MIN_MOVE_ANALOGS = 15;

// Publish a directional percentage only when high-confidence forecasts also prove
// >=68% hit rate on a chronological walk-forward sample. Rule/confluence score is
// not a probability. Test cases use non-overlapping horizon steps to reduce leakage.
const REQUIRED_DIRECTIONAL_HIT_RATE = 68;
const MIN_CALIBRATION_SIGNALS = 30;
const CALIBRATION_WINDOW_BARS = 300;

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


export function capLeadingProbabilityForDisplay(rawProbabilities, leader, outOfSampleHitRate) {
  const leaderKey=leader==="UP"?"up":leader==="DOWN"?"down":null;
  const keys=["up","down","sideways"];
  if(!leaderKey||!rawProbabilities||typeof rawProbabilities!=="object")return null;
  if(keys.some(k=>rawProbabilities[k]==null||rawProbabilities[k]===""||
    !Number.isFinite(Number(rawProbabilities[k]))||Number(rawProbabilities[k])<0))return null;
  const hit=outOfSampleHitRate==null||outOfSampleHitRate===""?NaN:Number(outOfSampleHitRate);
  const values=keys.map(k=>Number(rawProbabilities[k]));
  const rawTotal=values.reduce((a,b)=>a+b,0);
  if(!Number.isFinite(hit)||hit<0||hit>100||Math.round(rawTotal)!==100)return null;

  // Never publish the analogue leader above the observed out-of-sample hit rate.
  const lead=Math.min(Math.floor(Number(rawProbabilities[leaderKey])),Math.floor(hit));
  const others=keys.filter(k=>k!==leaderKey);
  const otherMass=others.reduce((sum,k)=>sum+Number(rawProbabilities[k]),0);
  const remainder=100-lead;
  const exact=others.map(k=>otherMass>0?remainder*Number(rawProbabilities[k])/otherMass:remainder/2);
  const whole=exact.map(Math.floor);
  let left=remainder-whole.reduce((a,b)=>a+b,0);
  const fractions=exact.map((v,i)=>({i,fraction:v-whole[i]})).sort((a,b)=>b.fraction-a.fraction);
  for(let i=0;i<left;i++)whole[fractions[i%fractions.length].i]++;

  const published={up:0,down:0,sideways:0};
  published[leaderKey]=lead;
  others.forEach((k,i)=>{published[k]=whole[i];});
  return published;
}

function historicalPredictionAt(rows, features, atr, index, config) {
  const current = features[index];
  if (!current) return null;
  const start = Math.max(20, index - LOOKBACK_BARS - config.bars - 1);
  const candidates = [], baseCounts = { UP: 0, DOWN: 0, RANGE: 0 };
  // Every analogue's forward outcome must already be complete at the historical
  // forecast timestamp. This is a strict chronological walk-forward simulation.
  for (let i = start; i + config.bars <= index; i++) {
    if (!features[i]) continue;
    const label = outcomeAt(rows, i, config.bars, atr, config.thresholdAtr);
    if (!label) continue;
    baseCounts[label]++;
    candidates.push({ i, label, distance: distance(current, features[i]) });
  }
  if (candidates.length < MIN_ANALOGS) return null;
  const total = candidates.length, base = {};
  for (const label of LABELS) base[label] = (baseCounts[label] || 0) / total;
  candidates.sort((a, b) => a.distance - b.distance);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some(x => Math.abs(x.i - candidate.i) <= config.bars)) continue;
    selected.push(candidate);
    if (selected.length >= TARGET_ANALOGS) break;
  }
  if (selected.length < MIN_ANALOGS) return null;
  const counts = { UP: 0, DOWN: 0, RANGE: 0 };
  for (const sample of selected) counts[sample.label]++;
  const probabilities = toPercentages(counts, base, selected.length);
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { label: best[0], leadingProbability: best[1], probabilities, sampleSize: selected.length };
}

function calibrateDirectionalHorizon(rows, features, atr, config) {
  const evaluated = [];
  const first = Math.max(20, rows.length - CALIBRATION_WINDOW_BARS - config.bars);
  // Step by the horizon length so validation outcomes are not mostly duplicates.
  for (let index = first; index < rows.length - config.bars; index += config.bars) {
    const forecast = historicalPredictionAt(rows, features, atr, index, config);
    const actual = outcomeAt(rows, index, config.bars, atr, config.thresholdAtr);
    if (!forecast || !actual) continue;
    evaluated.push({ forecast, actual });
  }
  const qualified = evaluated.filter(x =>
    x.forecast.leadingProbability >= REQUIRED_DIRECTIONAL_HIT_RATE &&
    (x.forecast.label === "UP" || x.forecast.label === "DOWN")
  );
  const correct = qualified.filter(x => x.forecast.label === x.actual).length;
  const hitRate = qualified.length
    ? round1(100 * correct / qualified.length)
    : null;
  const eligible = qualified.length >= MIN_CALIBRATION_SIGNALS &&
    hitRate !== null && hitRate >= REQUIRED_DIRECTIONAL_HIT_RATE;
  const status = eligible ? "WALK_FORWARD_VALIDATED" :
    qualified.length < MIN_CALIBRATION_SIGNALS ? "INSUFFICIENT_OUT_OF_SAMPLE_SIGNALS" :
    "WALK_FORWARD_HIT_RATE_BELOW_68";
  return {
    eligible,
    status,
    requiredHitRate: REQUIRED_DIRECTIONAL_HIT_RATE,
    evaluatedPredictions: evaluated.length,
    highConfidenceDirectionalSignals: qualified.length,
    correctHighConfidenceSignals: correct,
    outOfSampleHitRate: hitRate,
    minimumSignals: MIN_CALIBRATION_SIGNALS,
    windowBars: CALIBRATION_WINDOW_BARS,
    method: "Chronological walk-forward test of high-confidence UP/DOWN nearest-analogue forecasts; forward labels are excluded from training until resolved; horizon-step sampling reduces overlap.",
    reason: eligible
      ? "Recent high-confidence directional forecasts passed the out-of-sample hit-rate and sample-size gates."
      : qualified.length < MIN_CALIBRATION_SIGNALS
        ? "Fewer than 30 out-of-sample high-confidence directional forecasts are resolved; do not display a directional percentage."
        : "Recent out-of-sample high-confidence directional hit rate is below 68%; suppress directional percentage and wait."
  };
}

function forecastHorizon(rows, features, atr, config) {
  const n=rows.length, current=features[n-1];
  const unavailable=(reason)=>({
    available:false,historyAvailable:false,horizonMinutes:config.minutes,
    probabilities:null,rawProbabilities:null,sampleSize:0,
    direction:"UNVERIFIED / WAIT",rawDirection:"UNAVAILABLE",leadingProbability:null,
    rawLeadingProbability:null,calibration:{eligible:false,status:"INSUFFICIENT_HISTORY",
      requiredHitRate:REQUIRED_DIRECTIONAL_HIT_RATE,highConfidenceDirectionalSignals:0,
      correctHighConfidenceSignals:0,outOfSampleHitRate:null,minimumSignals:MIN_CALIBRATION_SIGNALS,reason},
    reason,asOf:rows.at(-1)?.t??null,
    method:"Nearest historical analogues with chronological walk-forward calibration gate"
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
  const rawProbabilities=toPercentages(counts,base,selected.length);
  const best=Object.entries(rawProbabilities).sort((a,b)=>b[1]-a[1])[0];
  const rawDirection=best[0]==="UP"?"UPWARD BIAS":best[0]==="DOWN"?"DOWNWARD BIAS":"RANGE / MIXED";
  const calibration=calibrateDirectionalHorizon(rows,features,atr,config);
  const currentDirectionalGate=best[1]>=REQUIRED_DIRECTIONAL_HIT_RATE &&
    (best[0]==="UP"||best[0]==="DOWN");
  const calibrationGatePassed=calibration.eligible&&currentDirectionalGate;
  const publishedProbabilities=calibrationGatePassed
    ? capLeadingProbabilityForDisplay(rawProbabilities,best[0],calibration.outOfSampleHitRate)
    : null;
  const available=calibrationGatePassed&&publishedProbabilities!==null;
  const leaderKey=best[0]==="UP"?"up":best[0]==="DOWN"?"down":"sideways";
  const publishedLeadingProbability=available?publishedProbabilities[leaderKey]:null;
  const reason=available
    ? "Published direction is capped at the lower of the analogue estimate and recent walk-forward hit rate; at least 30 resolved high-confidence forecasts must validate."
    : !currentDirectionalGate
      ? "Current leading directional estimate is below 68% or the leading class is RANGE; suppress directional percentage."
      : calibration.reason;
  return {
    available,historyAvailable:true,horizonMinutes:config.minutes,
    probabilities:available?publishedProbabilities:null,rawProbabilities,
    sampleSize:selected.length,rawCounts:{up:counts.UP,down:counts.DOWN,sideways:counts.RANGE},
    baseRates:{up:round1(base.UP*100),down:round1(base.DOWN*100),sideways:round1(base.RANGE*100)},
    direction:available?rawDirection:"UNVERIFIED / WAIT",rawDirection,
    leadingProbability:available?publishedLeadingProbability:null,rawLeadingProbability:best[1],
    calibration,reason,
    sampleQuality:selected.length>=35?"MODERATE":"LIMITED",
    asOf:rows.at(-1)?.t??null,
    outcomeRule:"UP/DOWN means the future close crosses ±"+config.thresholdAtr+" ATR; otherwise RANGE.",
    method:"Nearest historical analogues using 3-bar/6-bar momentum, EMA9/EMA20 distance and RSI14. The leader is capped at the recent out-of-sample hit rate; remaining class shares are normalized and are not independently calibrated."
  };
}

function moveLabel(rows,index,bars){
  const origin=rows[index]?.c;
  if(!Number.isFinite(origin)||index+bars>=rows.length)return null;
  let high=-Infinity,low=Infinity;
  for(let j=index+1;j<=index+bars;j++){
    const previous=rows[j-1],current=rows[j];
    if(previous?.t&&current?.t){
      const previousMs=Date.parse(previous.t),currentMs=Date.parse(current.t);
      const day=(stamp)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
      if(!Number.isFinite(previousMs)||!Number.isFinite(currentMs)||currentMs-previousMs>7*60_000||currentMs<=previousMs||day(previousMs)!==day(currentMs))return null;
    }
    high=Math.max(high,rows[j].h);low=Math.min(low,rows[j].l);
  }
  const up=high-origin>=MOVE_POINTS,down=origin-low>=MOVE_POINTS;
  return up&&down?"BOTH_100":up?"UP_100":down?"DOWN_100":"NEITHER_100";
}
function movePercentages(counts,base,size){
  const exact=MOVE_LABELS.map(label=>100*(counts[label]+PRIOR_WEIGHT*(base[label]||0))/(size+PRIOR_WEIGHT));
  const whole=exact.map(Math.floor);let remain=100-whole.reduce((a,b)=>a+b,0);
  exact.map((v,i)=>({i,frac:v-whole[i]})).sort((a,b)=>b.frac-a.frac).slice(0,remain).forEach(x=>whole[x.i]++);
  return {up100:whole[0],down100:whole[1],both100:whole[2],neither100:whole[3]};
}
function forecastMoveHorizon(rows,features,config){
  const current=features.at(-1);
  const unavailable=(reason)=>({available:false,horizonMinutes:config.minutes,thresholdPoints:MOVE_POINTS,probabilities:null,sampleSize:0,reason,asOf:rows.at(-1)?.t??null});
  if(!current)return unavailable("Not enough verified candle history for large-move indicators.");
  const candidates=[],baseCounts={UP_100:0,DOWN_100:0,BOTH_100:0,NEITHER_100:0};
  const start=Math.max(20,rows.length-LOOKBACK_BARS-config.bars-1);
  for(let i=start;i<rows.length-config.bars;i++){
    if(!features[i])continue;
    const label=moveLabel(rows,i,config.bars);if(!label)continue;
    baseCounts[label]++;candidates.push({i,label,distance:distance(current,features[i])});
  }
  if(candidates.length<MIN_MOVE_ANALOGS)return unavailable("Not enough historical forward outcomes to estimate a 100-point move.");
  const total=candidates.length,base={};
  for(const label of MOVE_LABELS)base[label]=baseCounts[label]/total;
  candidates.sort((a,b)=>a.distance-b.distance);
  const selected=[];
  for(const candidate of candidates){
    if(selected.some(x=>Math.abs(x.i-candidate.i)<=config.bars))continue;
    selected.push(candidate);if(selected.length>=TARGET_ANALOGS)break;
  }
  if(selected.length<MIN_MOVE_ANALOGS)return unavailable("Too few non-overlapping similar historical moves for a stable estimate.");
  const counts={UP_100:0,DOWN_100:0,BOTH_100:0,NEITHER_100:0};
  for(const sample of selected)counts[sample.label]++;
  return {available:true,horizonMinutes:config.minutes,thresholdPoints:MOVE_POINTS,probabilities:movePercentages(counts,base,selected.length),sampleSize:selected.length,sampleQuality:selected.length>=30?"MODERATE":"LIMITED",baseRates:{up100:round1(base.UP_100*100),down100:round1(base.DOWN_100*100),both100:round1(base.BOTH_100*100),neither100:round1(base.NEITHER_100*100)},asOf:rows.at(-1)?.t??null,method:"Historical analogue estimate from future 5-minute candle highs/lows; reports probability of touching +/-100 NIFTY points within the next horizon. Not a guarantee."};
}
function buildObservedMoveMonitor(rows,options={}){
  const last=rows.at(-1);
  const unavailable=(reason)=>({available:false,thresholdPoints:MOVE_POINTS,reason,source:"COMPLETED_5M_CANDLES_ONLY",asOf:last?.t??null});
  if(!last||rows.length<13)return unavailable("Not enough recent completed candles to monitor 30/60-minute swings.");
  const windows={};
  for(const config of MOVE_HORIZONS){
    const slice=rows.slice(-(config.bars+1));
    if(slice.length<config.bars+1){windows[String(config.minutes)]={available:false,reason:"Insufficient candles"};continue;}
    let continuous=true;
    for(let j=1;j<slice.length;j++){
      const a=slice[j-1].t?Date.parse(slice[j-1].t):NaN,b=slice[j].t?Date.parse(slice[j].t):NaN;
      if(Number.isFinite(a)&&Number.isFinite(b)&&(b<=a||b-a>7*60_000)){continuous=false;break;}
      if(Number.isFinite(a)&&Number.isFinite(b)){
        const day=stamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
        if(day(a)!==day(b)){continuous=false;break;}
      }
    }
    if(!continuous){windows[String(config.minutes)]={available:false,reason:"History has an overnight or missing-candle gap; not counted as a 30/60-minute move."};continue;}
    const anchor=slice[0].c,high=Math.max(...slice.map(r=>r.h)),low=Math.min(...slice.map(r=>r.l)),close=slice.at(-1).c;
    windows[String(config.minutes)]={available:true,minutes:config.minutes,anchor,close,netPoints:round1(close-anchor),upSwingPoints:round1(high-anchor),downSwingPoints:round1(anchor-low),up100:high-anchor>=MOVE_POINTS,down100:anchor-low>=MOVE_POINTS};
  }
  const lastTime=last.t?Date.parse(last.t):NaN;
  const todayKey=Number.isFinite(lastTime)?new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(lastTime)):null;
  const sessionRows=todayKey?rows.filter(row=>row.t&&new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(row.t))===todayKey):[];
  let session=null;
  if(sessionRows.length){
    const open=sessionRows[0].o,high=Math.max(...sessionRows.map(r=>r.h)),low=Math.min(...sessionRows.map(r=>r.l)),close=sessionRows.at(-1).c;
    session={available:true,candleCount:sessionRows.length,open,close,netPoints:round1(close-open),highFromOpen:round1(high-open),lowFromOpen:round1(open-low),up100:high-open>=MOVE_POINTS,down100:open-low>=MOVE_POINTS};
  }
  const ageMinutes=Number.isFinite(lastTime)?round1((Date.now()-(lastTime+5*60_000))/60000):null;
  return {available:true,thresholdPoints:MOVE_POINTS,source:"COMPLETED_5M_CANDLES_ONLY",marketOpen:options.marketOpen===true,asOf:last.t??null,candleAgeMinutes:ageMinutes,stale:ageMinutes===null||ageMinutes>10||ageMinutes<-.25,windows,session,warning:"This reports observed completed-candle movement, not a live-tick reading. Stale candles cannot prove the current NIFTY price."};
}

export function buildForwardForecast(inputRows, options={}) {
  const rows=prepareRows(inputRows);
  const last=rows.at(-1)||null;
  const baseResult=(reason)=>{
    const horizons={};
    for(const config of HORIZONS)horizons[String(config.minutes)]={
      available:false,historyAvailable:false,horizonMinutes:config.minutes,probabilities:null,rawProbabilities:null,sampleSize:0,
      direction:"UNVERIFIED / WAIT",rawDirection:"UNAVAILABLE",leadingProbability:null,rawLeadingProbability:null,
      calibration:{eligible:false,status:"INSUFFICIENT_HISTORY",requiredHitRate:REQUIRED_DIRECTIONAL_HIT_RATE,highConfidenceDirectionalSignals:0,correctHighConfidenceSignals:0,outOfSampleHitRate:null,minimumSignals:MIN_CALIBRATION_SIGNALS,reason},
      reason,asOf:last?.t??null,
      method:"Nearest historical analogues with chronological walk-forward calibration gate"
    };
    const largeMoveHorizons={};
    for(const config of MOVE_HORIZONS)largeMoveHorizons[String(config.minutes)]={available:false,horizonMinutes:config.minutes,thresholdPoints:MOVE_POINTS,probabilities:null,sampleSize:0,reason,asOf:last?.t??null};
    return {
      available:false,historyAvailable:false,model:"HISTORICAL_ANALOGUE_V1",modelLabel:"Walk-forward gated directional estimate",
      asOf:last?.t??null,horizons,
      largeMoveRadar:{available:false,thresholdPoints:MOVE_POINTS,horizons:largeMoveHorizons,reason},
      moveMonitor:buildObservedMoveMonitor(rows,options),
      interpretation:"Forecast is shown only when the exchange session and latest closed candle can be verified. Percentages are not guarantees or option-premium win rates.",
      calibrationStatus:"NO LIVE DIRECTIONAL PERCENTAGE UNLESS RECENT WALK-FORWARD HIGH-CONFIDENCE HIT RATE >=68% WITH AT LEAST 30 RESOLVED PREDICTIONS."
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
  const largeMoveHorizons={};
  for(const config of MOVE_HORIZONS)largeMoveHorizons[String(config.minutes)]=forecastMoveHorizon(selectedRows,features,config);
  const largeMoveRadar={available:Object.values(largeMoveHorizons).some(h=>h.available),thresholdPoints:MOVE_POINTS,horizons:largeMoveHorizons,interpretation:'Historical analogues estimating whether the next 30/60 minutes may touch +100, -100, both, or neither. This is a probability estimate, not a trade signal.'};
  return {
    available:Object.values(horizons).some(h=>h.available),
    historyAvailable:Object.values(horizons).some(h=>h.historyAvailable),
    model:"HISTORICAL_ANALOGUE_V1",
    modelLabel:"Walk-forward gated directional estimate",
    asOf:selectedRows.at(-1)?.t??null,
    horizons, largeMoveRadar, moveMonitor:buildObservedMoveMonitor(selectedRows,options),
    interpretation:"A directional percentage is published only when the current analogue direction is >=68% AND at least 30 recent high-confidence out-of-sample directional forecasts achieve >=68% hit rate. The displayed leader is capped at the lower of its analogue estimate and recent out-of-sample hit rate; remaining UP/DOWN/RANGE shares are normalized and are not independently calibrated. Otherwise the system withholds the percentage and displays WAIT. Underlying price direction is not option-premium profit probability.",
    calibrationStatus:"GATE: current leading class >=68%, recent walk-forward hit rate >=68%, minimum 30 high-confidence resolved predictions."
  };
}
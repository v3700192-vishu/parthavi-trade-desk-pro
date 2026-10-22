/*
  PARTHAVI TRADE DESK PRO — Phase 10 Prediction Engine
  Rule-based multi-timeframe prediction + confirmation + transparent historical target-hit backtest.
  This module never claims guaranteed profit.
*/
import { buildForwardForecast } from './forwardForecast.js';

// One documented threshold map keeps signal decisions and UI diagnostics in sync.
const SIGNAL_THRESHOLDS = Object.freeze({
  directionalMinScore: 20, adxMin: 20, volumeBreakout: 1.5, volumeContinuation: 0.90,
  thetaHardMax: 10, deltaHardMin: 0.20, thetaConfirmMax: 6, deltaConfirmMin: 0.35,
  vixMin: 12, vixMax: 22, watchMinConfirmations: 6,
  contractScanConfidence: 70, adviserConfidence: 80, commandCenterConfidence: 90
});

function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function n(v,d=null){ if(v==null || (typeof v==='string' && v.trim()==='')) return d; const x=Number(v); return Number.isFinite(x)?x:d; }
function dirScore(flagBull,flagBear,weight){ return flagBull?weight:flagBear?-weight:0; }

function istSlot(ts){
  const d=new Date(ts);
  if(Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
}
function istDateKey(ts){
  const d=new Date(ts);
  if(Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function summarizeLatest(rows){
  const r=rows||[]; const last=r.at(-1), prev=r.at(-2);
  if(!last) return {};
  const c=r.map(x=>n(x.c)).filter(Number.isFinite);
  const vol=r.map(x=>n(x.v)).filter(Number.isFinite);
  const positiveVol=vol.filter(v=>v>0);
  const volumeAvailable=positiveVol.length>0;
  const avgVol=vol.length>20?vol.slice(-21,-1).reduce((a,b)=>a+b,0)/20:null;
  const volumeRatio=avgVol&&avgVol>0?n(last.v)/avgVol:null;

  // 10-trading-day same-time-slot volume benchmark.
  const slot=istSlot(last.t), day=istDateKey(last.t);
  const priorDays=[...new Set(r.slice(0,-1).map(x=>istDateKey(x.t)).filter(Boolean))].slice(-12);
  const eligibleDays=priorDays.slice(-10);
  const slotVolumes=[];
  for(const dkey of eligibleDays){
    const matches=r.filter(x=>istDateKey(x.t)===dkey && istSlot(x.t)===slot).map(x=>n(x.v)).filter(Number.isFinite);
    if(matches.length) slotVolumes.push(matches.at(-1));
  }
  const avgSlotVol=slotVolumes.length?slotVolumes.reduce((a,b)=>a+b,0)/slotVolumes.length:null;
  const volumeRatio10d=avgSlotVol&&avgSlotVol>0?n(last.v)/avgSlotVol:null;
  const volumeBreakout=volumeRatio10d!=null&&volumeRatio10d>=1.5;

  const range=n(last.h)-n(last.l), body=Math.abs(n(last.c)-n(last.o));
  return {
    last:n(last.c), prev:n(prev?.c), volumeRatio,
    volumeRatio10d,
    volumeBreakout,
    volumeBenchmarkDays:slotVolumes.length,
    volumeAvailable,
    volumeUnavailable:!volumeAvailable,
    candle:n(last.c)>n(last.o)?'BULLISH':n(last.c)<n(last.o)?'BEARISH':'DOJI',
    candleBodyRatio:range>0?body/range:null,
    range
  };
}

function summarizePriceMovement(inputRows, marketOpen=false) {
  const rows=(Array.isArray(inputRows)?inputRows:[])
    .filter(r=>Number.isFinite(n(r?.c))&&Number.isFinite(n(r?.h))&&Number.isFinite(n(r?.l))&&Number.isFinite(n(r?.o)))
    .slice()
    .sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  if(!rows.length) return {
    available:false,status:'NO CANDLE DATA',dataStatus:'UNAVAILABLE',direction:'UNKNOWN',
    latestPrice:null,lastCandleAt:null,candleAgeMinutes:null,barsAvailable:0,
    change5m:null,change15m:null,change30m:null,change60m:null,
    sessionOpen:null,sessionHigh:null,sessionLow:null,sessionChange:null,sessionRange:null,
    pointsFromHigh:null,pointsFromLow:null,atr5m:null,momentumScore:0,
    reason:'No completed NIFTY candles are loaded. Restore a verified market-data feed.'
  };
  const last=rows.at(-1), lastTime=Date.parse(last.t);
  const age=Number.isFinite(lastTime)?Math.max(0,(Date.now()-(lastTime+5*60_000))/60_000):null;
  const change=(bars)=>rows.length>bars?Number((n(last.c)-n(rows[rows.length-1-bars].c)).toFixed(2)):null;
  const trueRanges=[];
  for(let i=Math.max(1,rows.length-14);i<rows.length;i++){
    const previous=n(rows[i-1]?.c,n(rows[i].c));
    trueRanges.push(Math.max(n(rows[i].h)-n(rows[i].l),Math.abs(n(rows[i].h)-previous),Math.abs(n(rows[i].l)-previous)));
  }
  const atr5m=trueRanges.length?trueRanges.reduce((a,b)=>a+b,0)/trueRanges.length:null;
  const day=istDateKey(last.t);
  const sessionRows=rows.filter(r=>istDateKey(r.t)===day);
  const sessionOpen=sessionRows.length?n(sessionRows[0].o):null;
  const sessionHigh=sessionRows.length?Math.max(...sessionRows.map(r=>n(r.h))):null;
  const sessionLow=sessionRows.length?Math.min(...sessionRows.map(r=>n(r.l))):null;
  const sessionChange=sessionOpen==null?null:Number((n(last.c)-sessionOpen).toFixed(2));
  const sessionRange=sessionHigh==null||sessionLow==null?null:Number((sessionHigh-sessionLow).toFixed(2));
  const change15m=change(3), change60m=change(12);
  const scale=atr5m!=null&&atr5m>0?atr5m:10;
  const momentumScore=Number(clamp(
    (change15m==null?0:4*change15m/scale)+
    (change60m==null?0:6*change60m/(scale*2.5))+
    (sessionChange==null?0:4*sessionChange/(scale*4)),
    -20,20
  ).toFixed(1));
  let status='NORMAL / MIXED MOVE', direction='MIXED';
  const recent=change15m!=null&&Math.abs(change15m)>=Math.max(25,scale*1.5)?change15m:
    change60m!=null&&Math.abs(change60m)>=Math.max(50,scale*2.5)?change60m:
    sessionChange!=null&&Math.abs(sessionChange)>=Math.max(50,scale*3)?sessionChange:change(1);
  if(sessionRange!=null&&sessionRange>=100){
    status='100+ POINT SESSION SWING';
    direction=sessionChange!=null&&sessionChange>Math.max(10,scale)?'UP':sessionChange!=null&&sessionChange< -Math.max(10,scale)?'DOWN':'MIXED / REVERSAL';
  }else if(change60m!=null&&Math.abs(change60m)>=Math.max(50,scale*2.5)){
    direction=change60m>0?'UP':'DOWN'; status='STRONG '+direction+' MOVE · 60M';
  }else if(change15m!=null&&Math.abs(change15m)>=Math.max(25,scale*1.5)){
    direction=change15m>0?'UP':'DOWN'; status='FAST '+direction+' MOVE · 15M';
  }else if(sessionChange!=null&&Math.abs(sessionChange)>=Math.max(50,scale*3)){
    direction=sessionChange>0?'UP':'DOWN'; status='STRONG '+direction+' SESSION MOVE';
  }else if(recent!=null&&recent!==0){
    direction=recent>0?'UP':'DOWN';
  }
  const dataStatus=marketOpen===true
    ?(age!=null&&age<=10&&age>=-1?'FRESH CANDLE':'STALE CANDLE')
    :'HISTORICAL · MARKET CLOSED';
  return {
    available:true,status,dataStatus,direction,momentumScore,
    latestPrice:n(last.c),lastCandleAt:last.t,
    candleClosedAt:Number.isFinite(lastTime)?new Date(lastTime+5*60_000).toISOString():null,
    candleAgeMinutes:age==null?null:Number(age.toFixed(1)),barsAvailable:rows.length,
    change5m:change(1),change15m,change30m:change(6),change60m,
    sessionOpen,sessionHigh,sessionLow,sessionChange,sessionRange,
    pointsFromHigh:sessionHigh==null?null:Number((sessionHigh-n(last.c)).toFixed(2)),
    pointsFromLow:sessionLow==null?null:Number((n(last.c)-sessionLow).toFixed(2)),
    atr5m:atr5m==null?null:Number(atr5m.toFixed(2)),
    reason:dataStatus==='STALE CANDLE'?'Latest completed candle is stale; this is not a live reading.':
      dataStatus==='HISTORICAL · MARKET CLOSED'?'Shows the last available session only, not a live or forward guarantee.':
      'Observed price changes only; not a guaranteed forecast or entry signal.'
  };
}

function tfDirection(tf){
  const s=tf||{};
  const explicit=['BULLISH','BEARISH'].includes(String(s.trend||'').toUpperCase())?String(s.trend).toUpperCase():null;
  const ema20=n(s.ema20), ema50=n(s.ema50);
  const emaDirection=ema20!=null&&ema50!=null?(ema20>ema50?'BULLISH':ema20<ema50?'BEARISH':null):null;
  // A timeframe must not vote directionally when its declared trend conflicts with its EMA structure.
  if(explicit&&emaDirection&&explicit!==emaDirection) return 'NEUTRAL';
  return explicit||emaDirection||'NEUTRAL';
}

export function buildTradeTiming(p={}, {marketOpen=p.marketOpen===true,now=Date.now()}={}) {
  const stamp=Number.isFinite(Date.parse(p.signalBarTime||''))?Date.parse(p.signalBarTime):NaN;
  // Candle timestamps represent the opening time of a five-minute bar. A signal becomes
  // eligible only after that bar closes, and expires five minutes after the close.
  const entryAt=Number.isFinite(stamp)?stamp+5*60_000:null;
  const validUntil=Number.isFinite(stamp)?stamp+10*60_000:null;
  const expired=validUntil==null||now>=validUntil;
  const confidence=Number(p.modelConfidence)||0;
  const confidenceTier=confidence>=90?'90%+ • COMMAND CENTER CHECK':confidence>=80?'80%+ • ADVISER CANDIDATE':confidence>=70?'70%+ • CONTRACT SCAN ONLY':'BELOW 70% • WAIT';
  const hasAction=['CALL','PUT'].includes(String(p.action||'').toUpperCase());
  const reasons=Array.isArray(p.noTradeReasons)?p.noTradeReasons:[];
  let status='WAIT • CONFIRMATION REQUIRED';
  let reason='Wait for a confirmed 5M trigger; confidence alone is not an entry signal.';
  if(!marketOpen){
    status='NO TRADE • MARKET CLOSED';
    reason='The exchange session is closed; no entry window is active.';
  }else if(!Number.isFinite(stamp)){
    status='WAIT • VERIFY LIVE CANDLE';
    reason='A fresh, authenticated completed 5M candle is required before timing can be trusted.';
  }else if(expired){
    status='MISSED • SIGNAL EXPIRED';
    reason='The five-minute entry window has expired. Do not chase this signal; wait for a new setup.';
  }else if(p.candlesVerified!==true){
    status='WAIT • VERIFY LIVE CANDLE';
    reason='A fresh, authenticated completed 5M candle is required before timing can be trusted.';
  }else if(now<entryAt){
    status='WAIT • 5M CANDLE NOT CLOSED';
    reason='Wait for the current five-minute candle to close and for all entry checks to pass.';
  }else if(p.exchangeTickVerified!==true||p.feedComplete!==true||p.eventSafe!==true||reasons.length>0){
    status='WAIT • SAFETY GATE BLOCKED';
    reason=reasons[0]||'Live exchange tick, complete verified feeds, event safety and all risk gates must pass.';
  }else if(p.signalState!=='CONFIRMED'||!hasAction||p.commandCenterEligible!==true||
    confidence<90||Number(p.confirmationPct)!==100||
    p.optionPlan?.available!==true||p.optionPlan?.candidateOnly===true||
    p.optionPlan?.greekStatus!=='PASS'){
    status='WAIT • 90% + ALL CHECKS REQUIRED';
    reason='70% and 80% tiers are analysis candidates only. ENTRY READY needs 90%+, all 11 confirmations, a verified live tick, complete feeds and the selected contract passing Greeks.';
  }else{
    status='ENTRY READY';
    reason='All server-side gates passed. Re-check the live quote and spread immediately before any manual decision.';
  }
  return {
    status,reason,confidenceTier,confidence,
    signalGeneratedAt:new Date(now).toISOString(),
    signalBarTime:Number.isFinite(stamp)?new Date(stamp).toISOString():null,
    entryWindowStart:entryAt==null?null:new Date(entryAt).toISOString(),
    validUntil:validUntil==null?null:new Date(validUntil).toISOString(),
    remainingSeconds:validUntil==null?null:Math.max(0,Math.floor((validUntil-now)/1000)),
    timeframe:'5M',windowMinutes:5,requiresManualReview:true
  };
}

function finalTradePlan(prediction, last, atr){
  if(!['BULLISH','BEARISH'].includes(prediction) || !Number.isFinite(last) || !Number.isFinite(atr) || atr<=0){
    return {available:false,direction:'NO TRADE',entry:null,sl:null,target1:null,target2:null,riskPerUnit:null,rr1:null,rr2:null,mode:'WAIT',breakEvenTriggerR:1};
  }
  const riskPerUnit=Number(atr.toFixed(2));
  if(prediction==='BULLISH'){
    const entry=Number(last.toFixed(2)), sl=Number((last-1.0*atr).toFixed(2)), target1=Number((last+2.0*atr).toFixed(2)), target2=Number((last+2.5*atr).toFixed(2));
    return {available:true,direction:'CALL',mode:'UNDERLYING TRIGGER',entry,sl,target1,target2,riskPerUnit,rr1:2.0,rr2:2.5,breakEvenTriggerR:1.0,invalidation:`5M close below SL ${sl}`,trailingRule:'At +1R, move SL to cost-to-cost; then trail below higher 5M swing / ATR rule.'};
  }
  const entry=Number(last.toFixed(2)), sl=Number((last+1.0*atr).toFixed(2)), target1=Number((last-2.0*atr).toFixed(2)), target2=Number((last-2.5*atr).toFixed(2));
  return {available:true,direction:'PUT',mode:'UNDERLYING TRIGGER',entry,sl,target1,target2,riskPerUnit,rr1:2.0,rr2:2.5,breakEvenTriggerR:1.0,invalidation:`5M close above SL ${sl}`,trailingRule:'At +1R, move SL to cost-to-cost; then trail above lower 5M swing / ATR rule.'};
}

export function buildPrediction({h1,m15,m5,rows5=[],news={},global={},events={},options={},marketOpen=false,backtest=null,vix=null,oi=null}={}){
  const candleSummary=summarizeLatest(rows5);
  const x5={...candleSummary,...(m5||{})};
  // Only the separately verified futures-volume adapter may satisfy the volume gate.
  // Index candle volume can be zero/missing and must never be converted into a fake 0.00x ratio.
  const rawVolumeRatio=m5?.volumeRatio10d;
  const verifiedVolumeRatio=rawVolumeRatio==null||rawVolumeRatio===''?null:Number(rawVolumeRatio);
  const hasVerifiedVolume=Boolean(m5?.volumeSource && Number.isFinite(verifiedVolumeRatio) && verifiedVolumeRatio>=0);
  x5.volumeRatio10d=hasVerifiedVolume?verifiedVolumeRatio:null;
  x5.volumeRatio=hasVerifiedVolume?candleSummary.volumeRatio:null;
  x5.volumeBreakout=hasVerifiedVolume&&verifiedVolumeRatio>=1.5;
  x5.volumeUnavailable=!hasVerifiedVolume;
  x5.volumeSource=hasVerifiedVolume?String(m5.volumeSource):null;
  const h1d=tfDirection(h1), m15d=tfDirection(m15);
  const rsi=n(x5.rsi), adx=n(x5.adx), atr=n(x5.atr), vwap=x5.vwap==null||x5.vwap===''||!Number.isFinite(Number(x5.vwap))?null:Number(x5.vwap), last=n(x5.last);
  const macdHist=n(x5.macd?.hist);
  const vr=n(x5.volumeRatio);
  const vr10=hasVerifiedVolume?verifiedVolumeRatio:null;
  const latestBarTime=rows5?.at?.(-1)?.t;
  const parsedLatestBarTime=latestBarTime==null||latestBarTime===''?NaN:new Date(latestBarTime).getTime();
  const rawCandleStartAge=Number.isFinite(parsedLatestBarTime)?(Date.now()-parsedLatestBarTime)/60000:NaN;
  // Providers timestamp five-minute bars at their OPEN. Check future skew against the raw
  // timestamp, but measure staleness from the scheduled close of the completed candle.
  const futureCandleTimestamp=Number.isFinite(rawCandleStartAge)&&rawCandleStartAge < -0.25;
  const rawCandleAge=Number.isFinite(rawCandleStartAge)&&!futureCandleTimestamp?rawCandleStartAge-5:NaN;
  const candleAgeMinutes=Number.isFinite(rawCandleAge)?Number(Math.max(0,rawCandleAge).toFixed(1)):null;
  const candlesFresh=candleAgeMinutes!=null&&candleAgeMinutes<=10&&!futureCandleTimestamp;
  const candleSource=String(m5?.candleSource||'UNKNOWN').toUpperCase();
  // Angel One is primary; a separately authenticated Upstox V3 candle feed is an accepted
  // independent historical source. Stale caches and public Yahoo fallback remain unverified.
  const historicalProviderVerified=(candleSource.startsWith('ANGEL')&&!candleSource.includes('YAHOO')) || candleSource.startsWith('UPSTOX_HISTORICAL');
  const brokerCandlesVerified=historicalProviderVerified&&!candleSource.includes('YAHOO')&&!candleSource.includes('STALE CACHE');
  const candlesVerified=candlesFresh&&brokerCandlesVerified;
  const movementDiagnostics=summarizePriceMovement(rows5,marketOpen);
  movementDiagnostics.source=candleSource;
  movementDiagnostics.verified=candlesVerified;
  const hasVix=vix!==null&&vix!==undefined&&vix!==''&&Number.isFinite(Number(vix));
  const thetaRaw=options?.theta,deltaRaw=options?.delta;
  const hasGreeks=thetaRaw!==null&&thetaRaw!==undefined&&thetaRaw!==''&&deltaRaw!==null&&deltaRaw!==undefined&&deltaRaw!==''&&Number.isFinite(Number(thetaRaw))&&Number.isFinite(Number(deltaRaw));
  const newsVerified=!!news?.connected&&Number(news?.freshCount)>=1;
  const globalVerified=!!global?.connected&&Number(global?.freshInputs)>=3;
  const eventSafetyStatus=!events?.connected||events?.unverifiedTimes||events?.unverifiedHighImpact?'UNKNOWN':(events?.hardBlock||events?.eventDayBlock?'BLOCKED':events?.watch?'CAUTION':'SAFE');
  const eventSafe=eventSafetyStatus==='SAFE';

  const weights={trend:20,setup:18,trigger:18,momentum:10,volatility:8,volume:8,options:10,news:4,global:4};
  let score=0;
  score += dirScore(h1d==='BULLISH',h1d==='BEARISH',weights.trend);
  score += dirScore(m15d==='BULLISH',m15d==='BEARISH',weights.setup);
  const bullTrigger=['BULLISH ENGULFING','HAMMER','BULLISH CANDLE'].includes(String(m5?.candle||'')) || x5.candle==='BULLISH';
  const bearTrigger=['BEARISH ENGULFING','SHOOTING STAR','BEARISH CANDLE'].includes(String(m5?.candle||'')) || x5.candle==='BEARISH';
  score += dirScore(bullTrigger,bearTrigger,weights.trigger);
  score += dirScore(rsi!=null&&rsi>55, rsi!=null&&rsi<45, weights.momentum*0.55);
  score += dirScore(macdHist!=null&&macdHist>0, macdHist!=null&&macdHist<0, weights.momentum*0.45);
  if(last!=null&&vwap!=null) score += last>vwap?weights.volatility*0.75:-weights.volatility*0.75;
  if(adx!=null) score += adx>=SIGNAL_THRESHOLDS.adxMin?(score>=0?weights.volatility*0.25:-weights.volatility*0.25):0;
  if(vr10!=null&&vr10>=SIGNAL_THRESHOLDS.volumeBreakout) score += x5.candle==='BULLISH'?weights.volume:x5.candle==='BEARISH'?-weights.volume:0;

  const pcr=n(options?.pcr);
  // The live adapter returns ceoi/peoi; keep cedoi/pedoi aliases for older payloads.
  const ceDoi=n(options?.ceoi ?? options?.cedoi), peDoi=n(options?.peoi ?? options?.pedoi);
  const optionPcrVerified=pcr!=null&&pcr>0;
  const optionOiVerified=ceDoi!=null&&peDoi!=null&&ceDoi>=0&&peDoi>=0&&(ceDoi>0||peDoi>0);
  const optionFlowVerified=!!options?.connected&&(optionPcrVerified||optionOiVerified);
  // PCR and OI can disagree. Never count contradictory option-flow evidence as bullish
  // merely because dirScore gives its bullish argument precedence.
  const pcrBull=optionPcrVerified&&pcr>=1.05;
  const pcrBear=optionPcrVerified&&pcr<=0.95;
  const oiBull=optionOiVerified&&peDoi>ceDoi;
  const oiBear=optionOiVerified&&ceDoi>peDoi;
  const optionFlowConflict=(pcrBull&&oiBear)||(pcrBear&&oiBull);
  const optBull=optionFlowVerified&&!optionFlowConflict&&(pcrBull||oiBull);
  const optBear=optionFlowVerified&&!optionFlowConflict&&(pcrBear||oiBear);
  if(optionFlowVerified&&!optionFlowConflict) score += dirScore(optBull,optBear,weights.options);

  const newsBull=String(news?.bias||'')==='BULLISH', newsBear=String(news?.bias||'')==='BEARISH';
  if(news?.connected) score += dirScore(newsBull,newsBear,weights.news);
  const globalBull=String(global?.bias||'')==='RISK-ON', globalBear=String(global?.bias||'')==='RISK-OFF';
  if(global?.connected) score += dirScore(globalBull,globalBear,weights.global);

  const noTradeReasons=[];
  if(!marketOpen) noTradeReasons.push('No Trade: NSE session is closed; live entries and live probabilities are disabled.');
  if(!hasVix) noTradeReasons.push('No Trade: India VIX is not verified live.');
  else if(Number(vix)<SIGNAL_THRESHOLDS.vixMin || Number(vix)>SIGNAL_THRESHOLDS.vixMax) noTradeReasons.push('No Trade: Market is too slow or too volatile.');
  if(!candlesFresh) noTradeReasons.push('No Trade: the latest completed 5-minute candle is stale or unavailable.');
  else if(!brokerCandlesVerified) noTradeReasons.push('No Trade: technical candles are from an unverified, fallback, or stale source; fresh authenticated historical candles are required.');
  if(!newsVerified) noTradeReasons.push('No Trade: fresh market news is not verified.');
  if(!globalVerified) noTradeReasons.push('No Trade: fewer than three fresh global-risk inputs are verified.');
  if(!optionFlowVerified) noTradeReasons.push('No Trade: live option-chain PCR/OI values are unavailable or unverified.');
  else if(optionFlowConflict) noTradeReasons.push('No Trade: option-chain PCR and OI directions conflict; wait for them to align.');
  if(adx!=null && Number.isFinite(adx) && adx<SIGNAL_THRESHOLDS.adxMin)
    noTradeReasons.push("No Trade: ADX is " + adx.toFixed(1) + ", below required " + SIGNAL_THRESHOLDS.adxMin + "; market trend strength is weak.");
  if(!hasVerifiedVolume || vr10==null || !Number.isFinite(vr10)) {
    noTradeReasons.push('No Trade: verified 10-day futures-volume benchmark is unavailable.');
  }
  const theta=hasGreeks?Math.abs(Number(thetaRaw)):NaN, delta=hasGreeks?Math.abs(Number(deltaRaw)):NaN;
  if(!hasGreeks) noTradeReasons.push('No Trade: live option Theta/Delta is not verified.');
  else if(theta>=SIGNAL_THRESHOLDS.thetaHardMax || delta<SIGNAL_THRESHOLDS.deltaHardMin) noTradeReasons.push("No Trade: Greeks fail the hard risk gate (|Theta| " + theta.toFixed(2) + ", |Delta| " + delta.toFixed(3) + "). Hard stop: Theta >= " + SIGNAL_THRESHOLDS.thetaHardMax + " or Delta < " + SIGNAL_THRESHOLDS.deltaHardMin + "; preferred confirmation requires Theta < " + SIGNAL_THRESHOLDS.thetaConfirmMax + " and Delta >= " + SIGNAL_THRESHOLDS.deltaConfirmMin + ".");
  else if(theta>=SIGNAL_THRESHOLDS.thetaConfirmMax || delta<SIGNAL_THRESHOLDS.deltaConfirmMin) noTradeReasons.push("Caution: Theta/Delta needs improvement (|Theta| " + theta.toFixed(2) + "; |Delta| " + delta.toFixed(3) + "). Preferred: Theta < " + SIGNAL_THRESHOLDS.thetaConfirmMax + " and Delta >= " + SIGNAL_THRESHOLDS.deltaConfirmMin + ".");
  if(!events?.connected) noTradeReasons.push('No Trade: economic-event calendar is not verified live.');
  else if(events?.unverifiedTimes||events?.unverifiedHighImpact) noTradeReasons.push('No Trade: one or more economic-event timestamps are unverified.');
  else if(events?.eventDayBlock) noTradeReasons.push('No Trade: high-impact event day gate is active.');
  else if(events?.hardBlock) noTradeReasons.push('No Trade: high-impact event window is active.');
  else if(events?.watch) noTradeReasons.push('No Trade: high-impact event is inside the caution window; wait until the event-risk window clears.');

  // Lead with a separate early-direction estimate. It deliberately excludes the current
  // candle trigger and option-flow score so the UI can show a developing bias before
  // a completed trigger arrives. This is informational only; it never bypasses trade gates.
  let earlyScore=0;
  earlyScore += dirScore(h1d==='BULLISH',h1d==='BEARISH',22);
  earlyScore += dirScore(m15d==='BULLISH',m15d==='BEARISH',20);
  earlyScore += dirScore(rsi!=null&&rsi>=55,rsi!=null&&rsi<=45,10);
  earlyScore += dirScore(macdHist!=null&&macdHist>0,macdHist!=null&&macdHist<0,10);
  if(last!=null&&vwap!=null) earlyScore += last>vwap?8:last<vwap?-8:0;
  if(last!=null&&candleSummary.prev!=null) earlyScore += last>candleSummary.prev?5:last<candleSummary.prev?-5:0;
  // Add multi-bar price momentum to EARLY observation only; it cannot bypass trade gates.
  earlyScore += movementDiagnostics.momentumScore||0;
  earlyScore=Number(clamp(earlyScore,-75,75).toFixed(1));
  const earlyDirection=earlyScore>=20?'EARLY BULLISH':earlyScore<=-20?'EARLY BEARISH':'WAIT / MIXED';
  const earlyDirectionReason=earlyDirection==='WAIT / MIXED'
    ? 'Leading indicators are mixed; wait for direction to align.'
    : (earlyDirection==='EARLY BULLISH'
      ? 'Leading trend/momentum lean upward; this is an early bias, not an entry signal.'
      : 'Leading trend/momentum lean downward; this is an early bias, not an entry signal.');

  score=Number(clamp(score,-100,100).toFixed(1));
  const prediction=score>=SIGNAL_THRESHOLDS.directionalMinScore?'BULLISH':score<=-SIGNAL_THRESHOLDS.directionalMinScore?'BEARISH':'NEUTRAL';
  if(prediction==='NEUTRAL') noTradeReasons.push('No Trade: directional score ' + score.toFixed(1) + ' is inside the neutral band (-' + SIGNAL_THRESHOLDS.directionalMinScore + ' to +' + SIGNAL_THRESHOLDS.directionalMinScore + '); a directional score of at least +/-' + SIGNAL_THRESHOLDS.directionalMinScore + ' is required before contract scanning.');

  // Two-trade finder: allow strong trend-continuation setups even when the
  // current 5M bar is not a 1.5x breakout, provided ADX + momentum + trigger
  // still agree. True breakout volume remains the preferred path.
  const volumeContinuation =
    vr10!=null && vr10>=SIGNAL_THRESHOLDS.volumeContinuation &&
    prediction!=='NEUTRAL' &&
    adx!=null && adx>=SIGNAL_THRESHOLDS.adxMin &&
    ((prediction==='BULLISH' && bullTrigger && rsi!=null && rsi>52 && macdHist!=null && macdHist>0) ||
     (prediction==='BEARISH' && bearTrigger && rsi!=null && rsi<48 && macdHist!=null && macdHist<0));
  const volumePass=(vr10!=null && vr10>=SIGNAL_THRESHOLDS.volumeBreakout) || volumeContinuation;
  if(vr10!=null && vr10<SIGNAL_THRESHOLDS.volumeBreakout && !volumeContinuation)
    noTradeReasons.push("No Trade: futures volume is " + vr10.toFixed(2) + "x; breakout requires " + SIGNAL_THRESHOLDS.volumeBreakout.toFixed(2) + "x, while continuation needs >=" + SIGNAL_THRESHOLDS.volumeContinuation.toFixed(2) + "x plus aligned 1H/15M/5M trigger, ADX >=" + SIGNAL_THRESHOLDS.adxMin + ", RSI and MACD.");

  const confirmations={
    trend: prediction!=='NEUTRAL' && h1d===prediction,
    setup: prediction!=='NEUTRAL' && m15d===prediction,
    trigger: prediction==='BULLISH'?bullTrigger:prediction==='BEARISH'?bearTrigger:false,
    momentum: prediction==='BULLISH'?(rsi!=null&&rsi>50&&macdHist!=null&&macdHist>0):(prediction==='BEARISH'?(rsi!=null&&rsi<50&&macdHist!=null&&macdHist<0):false),
    volume: volumePass,
    strength: adx!=null&&adx>=SIGNAL_THRESHOLDS.adxMin,
    options: optionFlowVerified && ((prediction==='BULLISH'&&optBull)||(prediction==='BEARISH'&&optBear)),
    greeks: hasGreeks&&theta<SIGNAL_THRESHOLDS.thetaConfirmMax&&delta>=SIGNAL_THRESHOLDS.deltaConfirmMin,
    news: newsVerified,
    global: globalVerified,
    eventSafe
  };
  const required=['trend','setup','trigger','momentum','volume','strength','options','greeks','news','global','eventSafe'];
  const confirmedCount=required.filter(k=>confirmations[k]).length;
  const confirmationPct=Math.round(confirmedCount/required.length*100);
  // Conservative confidence: high scores are earned only when confirmations and feed quality agree.
  const backtestRate=n(backtest?.targetHitRate);
  // An index-only proxy is not evidence about CE/PE premium outcomes. Only a
  // verified option-premium backtest with costs + slippage may ever affect confidence.
  const qualifiedOptionBacktest=backtest?.kind==='OPTION_PREMIUM'
    && backtest?.verified===true
    && backtest?.feesIncluded===true
    && backtest?.slippageIncluded===true;
  const backtestBonus=qualifiedOptionBacktest&&backtest?.available&&backtestRate!=null
    ? clamp((backtestRate-55)*0.20,0,8)
    : 0;
  const modelConfidence=Math.round(clamp(
    52
    + Math.abs(score)*0.28
    + Math.max(0,confirmationPct-50)*0.34
    + (confirmedCount>=9?5:0)
    + backtestBonus,
    50,95
  ));
  const feedComplete=!!marketOpen && candlesVerified && hasVerifiedVolume && hasVix && Number(vix)>=SIGNAL_THRESHOLDS.vixMin && Number(vix)<=SIGNAL_THRESHOLDS.vixMax && newsVerified && globalVerified && optionFlowVerified && hasGreeks && eventSafe;
  const hardNoTrade=noTradeReasons.length>0;
  // Opportunity tiers: keep directional opportunities visible early, while
  // preserving hard safety blockers and the existing confirmed-entry gate.
  const opportunityConfidenceThreshold=SIGNAL_THRESHOLDS.adviserConfidence;
  const hardSafetyBlock =
    !marketOpen ||
    !candlesVerified ||
    !hasVerifiedVolume ||
    !hasVix ||
    !newsVerified ||
    !globalVerified ||
    !optionFlowVerified ||
    !hasGreeks ||
    !eventSafe ||
    !events?.connected ||
    !!events?.unverifiedTimes ||
    !!events?.unverifiedHighImpact ||
    !!events?.hardBlock ||
    !!events?.eventDayBlock ||
    (hasVix && (Number(vix)<SIGNAL_THRESHOLDS.vixMin || Number(vix)>SIGNAL_THRESHOLDS.vixMax)) ||
    (hasGreeks && (theta>=SIGNAL_THRESHOLDS.thetaHardMax || delta<SIGNAL_THRESHOLDS.deltaHardMin));
  const watchEligible=prediction!=='NEUTRAL' && confirmedCount>=SIGNAL_THRESHOLDS.watchMinConfirmations && !hardSafetyBlock;
  const eliteSetup=prediction!=='NEUTRAL' && confirmedCount===required.length && confirmationPct===100 && modelConfidence>=SIGNAL_THRESHOLDS.commandCenterConfidence && required.every(k=>confirmations[k]) && !hardNoTrade && feedComplete && !hardSafetyBlock;
  const signalState=(!marketOpen||events?.hardBlock||events?.eventDayBlock)?'NO TRADE':(eliteSetup?'CONFIRMED':(watchEligible?'WATCH':'NO TRADE'));
  const action=signalState==='CONFIRMED'?(prediction==='BULLISH'?'CALL':'PUT'):'NO TRADE';
  const watchAction=watchEligible?(prediction==='BULLISH'?'CE WATCH':'PE WATCH'):'NO TRADE';
  // Display early bias separately from strong/confirmed setup. Early is observation-only;
  // it never produces an entry plan or bypasses any safety gate.
  const earlyBiasReady=Math.abs(earlyScore)>=20;
  const earlySetup={
    status:earlyBiasReady?earlyDirection:'WAIT / MIXED',
    direction:earlyScore>=20?'BULLISH':earlyScore<=-20?'BEARISH':'NEUTRAL',
    score:earlyScore, observationOnly:true, entryAllowed:false,
    reason:earlyDirectionReason,
    dataStatus:!marketOpen?'MARKET CLOSED':(!candlesFresh?'STALE CANDLES':'OBSERVATION ONLY')
  };
  const strongSetup={
    status:signalState==='CONFIRMED'?'CONFIRMED':signalState==='WATCH'?'WATCH':'BLOCKED',
    direction:prediction, action, eligible:['CONFIRMED','WATCH'].includes(signalState),
    confirmationPct, confirmedCount, confirmationTotal:required.length,
    blockers:[...new Set(noTradeReasons)],
    safetyGatesPreserved:true
  };
  const noTradeDiagnostics={
    count:noTradeReasons.length,
    blockers:noTradeReasons.map(reason=>({
      reason,
      category:/market|candle|session|tick/i.test(reason)?'MARKET_DATA':/VIX|volatility/i.test(reason)?'VIX_RISK':/option|PCR|OI|Theta|Delta|Greek/i.test(reason)?'OPTIONS_RISK':/volume/i.test(reason)?'VOLUME':/news|global/i.test(reason)?'NEWS_GLOBAL_RISK':/event|calendar/i.test(reason)?'EVENT_RISK':/directional|neutral band|score/i.test(reason)?'DIRECTION':/ADX|trend strength/i.test(reason)?'TREND_STRENGTH':/confirmation|reward|risk/i.test(reason)?'CONFIRMATION_RISK':'OTHER'
    }))
  };
  const candidatePlan=finalTradePlan(prediction,last,atr);
  // Never expose an actionable entry/SL/target when a safety gate failed or the setup is below WATCH.
  const planGatesPassed=!!marketOpen&&feedComplete&&!hardNoTrade&&['WATCH','CONFIRMED'].includes(signalState);
  const plan=planGatesPassed&&candidatePlan.available
    ? candidatePlan
    : {...finalTradePlan('NEUTRAL',null,null),reason:'Entry plan withheld because live feeds or confirmation gates are incomplete.'};
  const opportunityEligible=prediction!=='NEUTRAL' && modelConfidence>=opportunityConfidenceThreshold && !hardSafetyBlock && !hardNoTrade && marketOpen && plan.available;
  const advisorMomentumExceptionEligible=prediction!=='NEUTRAL' && modelConfidence>=SIGNAL_THRESHOLDS.adviserConfidence && confirmationPct>=80 && required.filter(k=>k!=='momentum').every(k=>confirmations[k]) && !hardNoTrade && feedComplete && !hardSafetyBlock;
  // Option scanning must not be gated by Greeks from one arbitrary ATM contract.
  // If every non-Greek confirmation is verified, let the contract selector find a
  // specific liquid CE/PE whose own Greeks pass; re-run this model with that contract.
  // Scan candidates from the 70% directional tier. Momentum or options directional alignment
  // may be missing even while feeds are valid; the scanner checks each contract's own live quote,
  // OI, volume, premium and Greeks. This permits analysis only, never a recommendation or order.
  // At 70% directional confidence, start searching for a *candidate contract* even if
  // other safety confirmations fail. The server still requires a fresh live exchange tick,
  // a live quoted option chain and verified contract Greeks; this flag never means BUY/ready.
  const contractScanEligible=prediction!=='NEUTRAL' && modelConfidence>=SIGNAL_THRESHOLDS.contractScanConfidence && marketOpen;
  const tradeTiming=buildTradeTiming({marketOpen,signalBarTime:rows5?.at?.(-1)?.t||null,signalState,action,prediction,modelConfidence,confirmationPct,finalPlan:plan,candlesVerified,feedComplete,eventSafe,noTradeReasons,exchangeTickVerified:false,commandCenterEligible:false,optionPlan:null},{marketOpen,now:Date.now()});
  const forwardForecast=buildForwardForecast(rows5,{marketOpen});
  const reasoning = `Early direction: ${earlyDirection} (${earlyScore >= 0 ? '+' : ''}${earlyScore}). ${earlyDirectionReason} ` + (signalState==='CONFIRMED'
    ? `${prediction} structure aligns across 1H/15M/5M with ${confirmedCount}/${required.length} confirmation checks; VIX/ADX/volume/event filters passed and minimum RR is 1:2.`
    : signalState==='WATCH' && modelConfidence>=opportunityConfidenceThreshold
      ? `${watchAction} • ${prediction} opportunity detected at ${modelConfidence}% model confidence. Live contract selection is active; wait for 5M confirmation before entry.`
      : signalState==='WATCH'
        ? `${watchAction} • ${prediction} watch setup detected at ${modelConfidence}% model confidence. Wait for the 5M trigger.`
        : noTradeReasons.length
          ? noTradeReasons.join(' • ')
          : !marketOpen ? 'Exchange session is closed; live trade action is disabled.'
          : events?.hardBlock||events?.eventDayBlock ? 'High-impact event gate is active; no new trade is permitted.'
          : `${prediction==='NEUTRAL'?'Directional edge is weak.':prediction+' setup detected, but confirmation is incomplete.'} ${confirmedCount}/${required.length} checks currently pass.`);
  return {
    prediction, action, watchAction, signalState, score,
    earlyDirection, earlyScore, earlyDirectionReason,
    earlySetup, strongSetup, noTradeDiagnostics, movementDiagnostics,
    forwardForecast,
    tradeTiming,
    modelConfidence, opportunityConfidenceThreshold, opportunityEligible, contractScanEligible, advisorMomentumExceptionEligible,
    candidatePlan,
    modelConfidenceBand:eliteSetup?'COMMAND CENTER READY':advisorMomentumExceptionEligible?'AI ADVISER':contractScanEligible?'CONTRACT SCAN':watchEligible?'WATCH ONLY':'NO TRADE',
    confirmationPct, confirmedCount, confirmationTotal:required.length,
    confirmations, trend1h:h1d, setup15m:m15d, trigger5m:String(m5?.candle||'WAIT'), optionFlowConflict,
    volumeRatio:vr, volumeRatio10d:vr10, volumeBreakout:!!x5.volumeBreakout, volumeSource:x5.volumeSource||null, volumeUnavailable:!hasVerifiedVolume, candleAgeMinutes, candlesFresh, candlesVerified, candleSource, futureCandleTimestamp, optionDataVerified:optionFlowVerified, eventCalendarConnected:!!events?.connected, eventTimestampsVerified:!events?.unverifiedTimes, eventSafetyStatus, eventSafe, rsi, adx, atr, vwap, last, vix:hasVix?Number(vix):null, delta:hasGreeks?delta:null, theta:hasGreeks?theta:null, greekRisk:options?.greekRisk||null, oi:oi||null, noTradeReasons, rrGate:'1:2 MINIMUM',
    finalPlan:plan,
    signalBarTime:rows5?.at?.(-1)?.t||null,
    historical:backtest||{available:false,kind:'UNDERLYING_PRICE_ONLY',instrument:'NIFTY INDEX',reason:'Index price-only backtest unavailable.'},
    optionBacktest:{available:false,verified:false,kind:'OPTION_PREMIUM',feesIncluded:false,slippageIncluded:false,reason:'Historical CE/PE option-premium backtest is not connected to a verified historical contract dataset. Do not use index-candle statistics as option win rate or P&L.'},
    feedComplete, eventBlocked:!!events?.hardBlock, eventCalendarConnected:!!events?.connected, eventTimestampsVerified:!events?.unverifiedTimes, eventSafetyStatus,
    tradeFinder:{enabled:true,targetOpportunitiesPerSession:2,volumeMode:volumeContinuation?'CONTINUATION':'BREAKOUT',watchThreshold:SIGNAL_THRESHOLDS.contractScanConfidence,contractThreshold:SIGNAL_THRESHOLDS.contractScanConfidence,advisorThreshold:SIGNAL_THRESHOLDS.adviserConfidence,commandCenterThreshold:SIGNAL_THRESHOLDS.commandCenterConfidence},
    signalGates:{
      thresholds:{...SIGNAL_THRESHOLDS},
      directional:{score,minimumAbsoluteScore:SIGNAL_THRESHOLDS.directionalMinScore,pass:prediction!=='NEUTRAL'},
      trendStrength:{adx,minimum:SIGNAL_THRESHOLDS.adxMin,pass:adx!=null&&adx>=SIGNAL_THRESHOLDS.adxMin},
      volume:{ratio:vr10,breakoutMinimum:SIGNAL_THRESHOLDS.volumeBreakout,continuationMinimum:SIGNAL_THRESHOLDS.volumeContinuation,continuationPass:volumeContinuation,pass:volumePass},
      greeks:{theta:hasGreeks?theta:null,delta:hasGreeks?delta:null,hardThetaMax:SIGNAL_THRESHOLDS.thetaHardMax,hardDeltaMin:SIGNAL_THRESHOLDS.deltaHardMin,confirmThetaMax:SIGNAL_THRESHOLDS.thetaConfirmMax,deltaConfirmMin:SIGNAL_THRESHOLDS.deltaConfirmMin,pass:confirmations.greeks},
      confirmation:{passed:confirmedCount,total:required.length,pct:confirmationPct,watchMinimum:SIGNAL_THRESHOLDS.watchMinConfirmations,contractScanConfidence:SIGNAL_THRESHOLDS.contractScanConfidence,adviserConfidence:SIGNAL_THRESHOLDS.adviserConfidence,commandCenterConfidence:SIGNAL_THRESHOLDS.commandCenterConfidence},
      vix:{value:hasVix?Number(vix):null,min:SIGNAL_THRESHOLDS.vixMin,max:SIGNAL_THRESHOLDS.vixMax,pass:hasVix&&Number(vix)>=SIGNAL_THRESHOLDS.vixMin&&Number(vix)<=SIGNAL_THRESHOLDS.vixMax},
      feeds:{marketOpen,candlesFresh,candlesVerified,optionFlowVerified,newsVerified,globalVerified,eventSafe},
      rewardRisk:{minimum:2,pass:planGatesPassed&&!!plan?.available}
    },
    note:'Two-trade finder is active: the scanner searches continuously for up to two high-quality opportunities per NSE session. A 1.5x 10-day same-slot volume breakout is preferred; strong trend-continuation may qualify from 0.90x when 1H/15M/5M, momentum and ADX agree. India VIX 12–22, event safety, complete verified feeds and minimum 1:2 risk-to-reward remain hard protections. This is a quality filter, not a guarantee of profit. Final SL/targets are volatility-based planning levels on the underlying index; option premium SL/targets must be verified from the selected live contract and its Greeks.',
    reasoning
  };
}

function calibrateHistoricalRules(rows){
  const r=rows||[];
  const unavailable={status:'INSUFFICIENT_SAMPLE',method:'Chronological 70/30 walk-forward split; EMA20/EMA50 + RSI threshold sweep; 1:2 underlying-index R target, max 20 bars; ambiguous same-bar stop/target counts as loss.',recommended:null,reason:'Need at least 30 resolved training signals and 20 resolved out-of-sample signals before changing live thresholds.'};
  if(r.length<140)return unavailable;
  const split=Math.floor(r.length*0.7), configs=[{bullRsi:50,bearRsi:50},{bullRsi:52,bearRsi:48},{bullRsi:55,bearRsi:45}];
  const ema=(vals,n)=>{if(vals.length<n)return null;const k=2/(n+1);let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e;};
  const rsiAt=(vals,n=14)=>{if(vals.length<=n)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=vals[i]-vals[i-1];g+=Math.max(0,d);l+=Math.max(0,-d);}let ag=g/n,al=l/n;for(let i=n+1;i<vals.length;i++){const d=vals[i]-vals[i-1];ag=(ag*(n-1)+Math.max(0,d))/n;al=(al*(n-1)+Math.max(0,-d))/n;}return al===0?100:100-100/(1+ag/al);};
  const evaluate=(cfg,from,to)=>{let wins=0,losses=0,signals=0,lastSignal=-999;for(let i=Math.max(60,from);i<Math.min(to,r.length-20);i++){if(i-lastSignal<3)continue;const vals=r.slice(0,i+1).map(x=>Number(x.c));const e20=ema(vals,20),e50=ema(vals,50),rr=rsiAt(vals);const bull=e20!=null&&e50!=null&&e20>e50&&rr!=null&&rr>cfg.bullRsi;const bear=e20!=null&&e50!=null&&e20<e50&&rr!=null&&rr<cfg.bearRsi;if(!bull&&!bear)continue;const tr=[];for(let k=Math.max(1,i-13);k<=i;k++){const prev=Number(r[k-1].c);tr.push(Math.max(Number(r[k].h)-Number(r[k].l),Math.abs(Number(r[k].h)-prev),Math.abs(Number(r[k].l)-prev)));}const risk=tr.reduce((a,b)=>a+b,0)/tr.length;if(!Number.isFinite(risk)||risk<=0)continue;signals++;lastSignal=i;let result='UNRESOLVED';for(let j=i+1;j<=i+20&&j<r.length;j++){const hitStop=bull?Number(r[j].l)<=Number(r[i].c)-risk:Number(r[j].h)>=Number(r[i].c)+risk;const hitTarget=bull?Number(r[j].h)>=Number(r[i].c)+2*risk:Number(r[j].l)<=Number(r[i].c)-2*risk;if(hitStop&&hitTarget){result='LOSS';break;}if(hitTarget){result='WIN';break;}if(hitStop){result='LOSS';break;}}if(result==='WIN')wins++;else if(result==='LOSS')losses++;}const resolved=wins+losses,rate=resolved?Number((wins/resolved*100).toFixed(1)):null;return {signals,resolved,wins,losses,targetHitRate:rate,expectedR:rate==null?null:Number((rate/100*2-(1-rate/100)).toFixed(2))};};
  const train=configs.map(cfg=>({...cfg,...evaluate(cfg,60,split-20)}));
  const viable=train.filter(x=>x.resolved>=30&&x.expectedR!=null).sort((a,b)=>b.expectedR-a.expectedR);
  if(!viable.length)return {...unavailable,trainingResults:train,reason:'Historical training segment has fewer than 30 resolved signals; no threshold change is justified.'};
  const chosen=viable[0], validation=evaluate(chosen,split,r.length-20), baseline=evaluate(configs[1],split,r.length-20);
  if(validation.resolved<20||validation.expectedR==null)return {...unavailable,trainingResults:train,selectedForValidation:{bullRsi:chosen.bullRsi,bearRsi:chosen.bearRsi},validation,baseline,reason:'The out-of-sample segment has fewer than 20 resolved signals; keep current live thresholds unchanged.'};
  const validated=validation.expectedR>0&&baseline.expectedR!=null&&validation.expectedR>=baseline.expectedR;
  return {status:validated?'WALK_FORWARD_VALIDATED':'NO_IMPROVEMENT',method:'Chronological 70/30 walk-forward split; EMA20/EMA50 + RSI threshold sweep; 1:2 underlying-index R target, max 20 bars; ambiguous same-bar stop/target counts as loss.',trainingResults:train,selectedForValidation:{bullRsi:chosen.bullRsi,bearRsi:chosen.bearRsi},validation,baseline, recommended:validated?{bullRsi:chosen.bullRsi,bearRsi:chosen.bearRsi}:null,reason:validated?'Candidate threshold beat baseline on the held-out segment. Review again on fresh sessions before production promotion.':'No candidate beat the baseline out-of-sample; retain live thresholds.'};
}

export function backtestFiveMinute(rows=[]){
  // This is deliberately classified as an UNDERLYING proxy, never an option backtest.
  const r=rows||[]; if(r.length<120) return {available:false,kind:'UNDERLYING_PRICE_ONLY',instrument:'NIFTY INDEX',verified:false,optionsPremiumIncluded:false,feesIncluded:false,slippageIncluded:false,notValidForOptionPnl:true,reason:'Need at least 120 five-minute index candles for a preliminary underlying-only backtest. This does not backtest CE/PE option premiums.',sample:0,calibration:{status:'INSUFFICIENT_SAMPLE',recommended:null,reason:'Not enough candles for walk-forward calibration.'}};
  const wins=[]; const outcomes=[]; let candidates=0, resolved=0, hits=0;
  const closes=[]; const trs=r.slice(1,60).map((row,offset)=>{const prev=Number(r[offset].c);return Math.max(Number(row.h)-Number(row.l),Math.abs(Number(row.h)-prev),Math.abs(Number(row.l)-prev));});
  const ema=(vals,n)=>{if(vals.length<n)return null;const k=2/(n+1);let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e;};
  const rsiAt=(vals,n=14)=>{if(vals.length<=n)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=vals[i]-vals[i-1];g+=Math.max(0,d);l+=Math.max(0,-d);}let ag=g/n,al=l/n;for(let i=n+1;i<vals.length;i++){const d=vals[i]-vals[i-1],gg=Math.max(0,d),ll=Math.max(0,-d);ag=(ag*(n-1)+gg)/n;al=(al*(n-1)+ll)/n;}return al===0?100:100-100/(1+ag/al);};
  for(let i=60;i<r.length-25;i++){
    closes.push(r[i].c); const prev=r[i-1]?.c??r[i].c; trs.push(Math.max(r[i].h-r[i].l,Math.abs(r[i].h-prev),Math.abs(r[i].l-prev)));
    const e20=ema(r.slice(0,i+1).map(x=>x.c),20), e50=ema(r.slice(0,i+1).map(x=>x.c),50); const rr=rsiAt(r.slice(0,i+1).map(x=>x.c));
    // Historical test is explicitly price/technical-only: index candle volume
    // is not a reliable futures-volume proxy, so never let missing volume pass a fake filter.
    const bull=e20!=null&&e50!=null&&e20>e50&&rr!=null&&rr>52;
    const bear=e20!=null&&e50!=null&&e20<e50&&rr!=null&&rr<48;
    if(!bull&&!bear) continue;
    candidates++;
    const trAvg=trs.slice(Math.max(0,trs.length-14)).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(14,trs.length)); if(!Number.isFinite(trAvg)||trAvg<=0) continue;
    const entry=r[i].c, stop=trAvg, target=trAvg*2.0; let outcome='UNRESOLVED';
    for(let j=i+1;j<=i+20&&j<r.length;j++){
      if(bull){
        const hitStop=r[j].l<=entry-stop, hitTarget=r[j].h>=entry+target;
        if(hitStop&&hitTarget){ outcome='LOSS'; break; } if(hitTarget){outcome='WIN';break;} if(hitStop){outcome='LOSS';break;}
      } else {
        const hitStop=r[j].h>=entry+stop, hitTarget=r[j].l<=entry-target;
        if(hitStop&&hitTarget){outcome='LOSS';break;} if(hitTarget){outcome='WIN';break;} if(hitStop){outcome='LOSS';break;}
      }
    }
    outcomes.push(outcome);
    if(outcome==='WIN'){hits++;resolved++;} else if(outcome==='LOSS'){resolved++;}
  }
  const rate=resolved?Number((hits/resolved*100).toFixed(1)):null;
  const expectedR=rate!=null?Number((rate/100*2.0-(1-rate/100)).toFixed(2)):null;
  const calibration=calibrateHistoricalRules(r);
  return {available:resolved>=30,kind:'UNDERLYING_PRICE_ONLY',instrument:'NIFTY INDEX',verified:false,optionsPremiumIncluded:false,feesIncluded:false,slippageIncluded:false,notValidForOptionPnl:true,signals:candidates,resolved,wins:hits,losses:resolved-hits,targetHitRate:rate,expectedR,sample:resolved,minSample:30,calibration,method:'5M rolling EMA20/EMA50 + RSI on NIFTY index candles; 1.0 index-point ATR-risk unit vs 2.0R target; max 20 bars forward. NOT an option-premium test; excludes contract selection, CE/PE premium, spread, fees and slippage.',disclaimer:'Underlying index-only proxy. targetHitRate/expectedR must never be presented as CE/PE win rate, option returns or evidence of profitability.'};
}

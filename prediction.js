/*
  PARTHAVI TRADE DESK PRO — Phase 10 Prediction Engine
  Rule-based multi-timeframe prediction + confirmation + transparent historical target-hit backtest.
  This module never claims guaranteed profit.
*/

function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function n(v,d=null){ const x=Number(v); return Number.isFinite(x)?x:d; }
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

function tfDirection(tf){
  const s=tf||{};
  const bull = s.trend==='BULLISH' || (n(s.last)!=null && n(s.ema20)!=null && n(s.ema50)!=null && s.ema20>s.ema50);
  const bear = s.trend==='BEARISH' || (n(s.last)!=null && n(s.ema20)!=null && n(s.ema50)!=null && s.ema20<s.ema50);
  return bull?'BULLISH':bear?'BEARISH':'NEUTRAL';
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
  const rawCandleAge=latestBarTime?((Date.now()-new Date(latestBarTime).getTime())/60000):NaN;
  const candleAgeMinutes=Number.isFinite(rawCandleAge)?Number(Math.max(0,rawCandleAge).toFixed(1)):null;
  const candlesFresh=candleAgeMinutes!=null&&candleAgeMinutes<=10;
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
  if(adx!=null) score += adx>=20?(score>=0?weights.volatility*0.25:-weights.volatility*0.25):0;
  if(vr10!=null&&vr10>=1.5) score += x5.candle==='BULLISH'?weights.volume:x5.candle==='BEARISH'?-weights.volume:0;

  const pcr=n(options?.pcr); const ceDoi=n(options?.cedoi), peDoi=n(options?.pedoi);
  const optBull=options?.connected && (pcr>=1.05 || (peDoi!=null&&ceDoi!=null&&peDoi>ceDoi));
  const optBear=options?.connected && (pcr<=0.95 || (peDoi!=null&&ceDoi!=null&&ceDoi>peDoi));
  if(options?.connected) score += dirScore(optBull,optBear,weights.options);

  const newsBull=String(news?.bias||'')==='BULLISH', newsBear=String(news?.bias||'')==='BEARISH';
  if(news?.connected) score += dirScore(newsBull,newsBear,weights.news);
  const globalBull=String(global?.bias||'')==='RISK-ON', globalBear=String(global?.bias||'')==='RISK-OFF';
  if(global?.connected) score += dirScore(globalBull,globalBear,weights.global);

  const noTradeReasons=[];
  if(!hasVix) noTradeReasons.push('No Trade: India VIX is not verified live.');
  else if(Number(vix)<12 || Number(vix)>22) noTradeReasons.push('No Trade: Market is too slow or too volatile.');
  if(!candlesFresh) noTradeReasons.push('No Trade: the latest completed 5-minute candle is stale or unavailable.');
  if(!newsVerified) noTradeReasons.push('No Trade: fresh market news is not verified.');
  if(!globalVerified) noTradeReasons.push('No Trade: fewer than three fresh global-risk inputs are verified.');
  if(!options?.connected) noTradeReasons.push('No Trade: live option-chain/OI data is not verified.');
  if(adx!=null && Number.isFinite(adx) && adx<20)
    noTradeReasons.push('No Trade: ADX below 20 — market is choppy/sideways.');
  if(!hasVerifiedVolume || vr10==null || !Number.isFinite(vr10)) {
    noTradeReasons.push('No Trade: verified 10-day futures-volume benchmark is unavailable.');
  }
  const theta=hasGreeks?Math.abs(Number(thetaRaw)):NaN, delta=hasGreeks?Math.abs(Number(deltaRaw)):NaN;
  if(!hasGreeks) noTradeReasons.push('No Trade: live option Theta/Delta is not verified.');
  else if(theta>=10 || delta<0.20) noTradeReasons.push('No Trade: Theta Decay is too high or Delta is too low. Option buying is risky today.');
  else if(theta>=6 || delta<0.35) noTradeReasons.push('Caution: Theta/Delta profile is unfavorable for option buying.');
  if(!events?.connected) noTradeReasons.push('No Trade: economic-event calendar is not verified live.');
  else if(events?.unverifiedTimes||events?.unverifiedHighImpact) noTradeReasons.push('No Trade: one or more economic-event timestamps are unverified.');
  else if(events?.eventDayBlock) noTradeReasons.push('No Trade: high-impact event day gate is active.');
  else if(events?.hardBlock) noTradeReasons.push('No Trade: high-impact event window is active.');

  score=Number(clamp(score,-100,100).toFixed(1));
  const prediction=score>=20?'BULLISH':score<=-20?'BEARISH':'NEUTRAL';

  // Two-trade finder: allow strong trend-continuation setups even when the
  // current 5M bar is not a 1.5x breakout, provided ADX + momentum + trigger
  // still agree. True breakout volume remains the preferred path.
  const volumeContinuation =
    vr10!=null && vr10>=0.90 &&
    prediction!=='NEUTRAL' &&
    adx!=null && adx>=20 &&
    ((prediction==='BULLISH' && bullTrigger && rsi!=null && rsi>52 && macdHist!=null && macdHist>0) ||
     (prediction==='BEARISH' && bearTrigger && rsi!=null && rsi<48 && macdHist!=null && macdHist<0));
  const volumePass=(vr10!=null && vr10>=1.5) || volumeContinuation;
  if(vr10!=null && vr10<1.5 && !volumeContinuation)
    noTradeReasons.push(`No Trade: volume is only ${vr10.toFixed(2)}x the 10-day same-slot average and the continuation-volume conditions are not met.`);

  const confirmations={
    trend: prediction!=='NEUTRAL' && h1d===prediction,
    setup: prediction!=='NEUTRAL' && m15d===prediction,
    trigger: prediction==='BULLISH'?bullTrigger:prediction==='BEARISH'?bearTrigger:false,
    momentum: prediction==='BULLISH'?(rsi!=null&&rsi>50&&macdHist!=null&&macdHist>0):(prediction==='BEARISH'?(rsi!=null&&rsi<50&&macdHist!=null&&macdHist<0):false),
    volume: volumePass,
    strength: adx!=null&&adx>=20,
    options: !!options?.connected && ((prediction==='BULLISH'&&optBull)||(prediction==='BEARISH'&&optBear)),
    greeks: hasGreeks&&theta<6&&delta>=0.35,
    news: newsVerified,
    global: globalVerified,
    eventSafe
  };
  const required=['trend','setup','trigger','momentum','volume','strength','options','greeks','news','global','eventSafe'];
  const confirmedCount=required.filter(k=>confirmations[k]).length;
  const confirmationPct=Math.round(confirmedCount/required.length*100);
  // Conservative confidence: high scores are earned only when confirmations and feed quality agree.
  const backtestRate=n(backtest?.targetHitRate);
  const backtestBonus=backtest?.available&&backtestRate!=null
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
  const feedComplete=!!marketOpen && candlesFresh && hasVerifiedVolume && hasVix && Number(vix)>=12 && Number(vix)<=22 && newsVerified && globalVerified && !!options?.connected && hasGreeks && eventSafe;
  const hardNoTrade=noTradeReasons.length>0;
  // Opportunity tiers: keep directional opportunities visible early, while
  // preserving hard safety blockers and the existing confirmed-entry gate.
  const opportunityConfidenceThreshold=78;
  const hardSafetyBlock =
    !marketOpen ||
    !candlesFresh ||
    !hasVerifiedVolume ||
    !hasVix ||
    !newsVerified ||
    !globalVerified ||
    !options?.connected ||
    !hasGreeks ||
    !eventSafe ||
    !events?.connected ||
    !!events?.unverifiedTimes ||
    !!events?.unverifiedHighImpact ||
    !!events?.hardBlock ||
    !!events?.eventDayBlock ||
    (hasVix && (Number(vix)<12 || Number(vix)>22)) ||
    (hasGreeks && (theta>=10 || delta<0.20));
  const watchEligible=prediction!=='NEUTRAL' && confirmedCount>=6 && !hardSafetyBlock;
  const eliteSetup=prediction!=='NEUTRAL' && confirmedCount>=9 && confirmationPct>=80 && modelConfidence>=80 && !hardNoTrade && feedComplete && !hardSafetyBlock;
  const signalState=(!marketOpen||events?.hardBlock||events?.eventDayBlock)?'NO TRADE':(eliteSetup?'CONFIRMED':(watchEligible?'WATCH':'NO TRADE'));
  const action=signalState==='CONFIRMED'?(prediction==='BULLISH'?'CALL':'PUT'):'NO TRADE';
  const watchAction=watchEligible?(prediction==='BULLISH'?'CE WATCH':'PE WATCH'):'NO TRADE';
  const plan=finalTradePlan(prediction,last,atr);
  const opportunityEligible=prediction!=='NEUTRAL' && modelConfidence>=opportunityConfidenceThreshold && !hardSafetyBlock && marketOpen && plan.available;
  const reasoning = signalState==='CONFIRMED'
    ? `${prediction} structure aligns across 1H/15M/5M with ${confirmedCount}/${required.length} confirmation checks; VIX/ADX/volume/event filters passed and minimum RR is 1:2.`
    : signalState==='WATCH' && modelConfidence>=opportunityConfidenceThreshold
      ? `${watchAction} • ${prediction} opportunity detected at ${modelConfidence}% model confidence. Live contract selection is active; wait for 5M confirmation before entry.`
      : signalState==='WATCH'
        ? `${watchAction} • ${prediction} watch setup detected at ${modelConfidence}% model confidence. Wait for the 5M trigger.`
        : noTradeReasons.length
          ? noTradeReasons.join(' • ')
          : !marketOpen ? 'Exchange session is closed; live trade action is disabled.'
          : events?.hardBlock||events?.eventDayBlock ? 'High-impact event gate is active; no new trade is permitted.'
          : `${prediction==='NEUTRAL'?'Directional edge is weak.':prediction+' setup detected, but confirmation is incomplete.'} ${confirmedCount}/${required.length} checks currently pass.`;
  return {
    prediction, action, watchAction, signalState, score,
    modelConfidence, opportunityConfidenceThreshold, opportunityEligible,
    modelConfidenceBand:modelConfidence>=78?'OPTION OPPORTUNITY':modelConfidence>=70?'WATCH':'WEAK',
    confirmationPct, confirmedCount, confirmationTotal:required.length,
    confirmations, trend1h:h1d, setup15m:m15d, trigger5m:String(m5?.candle||'WAIT'),
    volumeRatio:vr, volumeRatio10d:vr10, volumeBreakout:!!x5.volumeBreakout, volumeSource:x5.volumeSource||null, volumeUnavailable:!hasVerifiedVolume, candleAgeMinutes, candlesFresh, eventCalendarConnected:!!events?.connected, eventTimestampsVerified:!events?.unverifiedTimes, eventSafetyStatus, eventSafe, rsi, adx, atr, vwap, last, vix:hasVix?Number(vix):null, delta:hasGreeks?delta:null, theta:hasGreeks?theta:null, greekRisk:options?.greekRisk||null, oi:oi||null, noTradeReasons, rrGate:'1:2 MINIMUM',
    finalPlan:plan,
    signalBarTime:rows5?.at?.(-1)?.t||null,
    historical:backtest||{available:false,reason:'Historical backtest not available.'},
    feedComplete, eventBlocked:!!events?.hardBlock, eventCalendarConnected:!!events?.connected, eventTimestampsVerified:!events?.unverifiedTimes, eventSafetyStatus,
    tradeFinder:{enabled:true,targetOpportunitiesPerSession:2,volumeMode:volumeContinuation?'CONTINUATION':'BREAKOUT',watchThreshold:70,contractThreshold:78},
    note:'Two-trade finder is active: the scanner searches continuously for up to two high-quality opportunities per NSE session. A 1.5x 10-day same-slot volume breakout is preferred; strong trend-continuation may qualify from 0.90x when 1H/15M/5M, momentum and ADX agree. India VIX 12–22, event safety, complete verified feeds and minimum 1:2 risk-to-reward remain hard protections. This is a quality filter, not a guarantee of profit. Final SL/targets are volatility-based planning levels on the underlying index; option premium SL/targets must be verified from the selected live contract and its Greeks.',
    reasoning
  };
}

export function backtestFiveMinute(rows=[]){
  const r=rows||[]; if(r.length<260) return {available:false,reason:'Need at least 260 five-minute candles for a meaningful rolling test.',sample:0};
  const wins=[]; const outcomes=[]; let candidates=0, resolved=0, hits=0;
  const closes=[]; const trs=[];
  const ema=(vals,n)=>{if(vals.length<n)return null;const k=2/(n+1);let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e;};
  const rsiAt=(vals,n=14)=>{if(vals.length<=n)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=vals[i]-vals[i-1];g+=Math.max(0,d);l+=Math.max(0,-d);}let ag=g/n,al=l/n;for(let i=n+1;i<vals.length;i++){const d=vals[i]-vals[i-1],gg=Math.max(0,d),ll=Math.max(0,-d);ag=(ag*(n-1)+gg)/n;al=(al*(n-1)+ll)/n;}return al===0?100:100-100/(1+ag/al);};
  for(let i=220;i<r.length-25;i++){
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
  const expectedR=rate!=null?Number((rate/100*2.0-(1-rate/100)).toFixed(2)):null; return {available:resolved>=30,signals:candidates,resolved,wins:hits,losses:resolved-hits,targetHitRate:rate,expectedR,sample:resolved,minSample:30,method:'5M rolling EMA20/EMA50 + RSI price-only trigger; 1.0R stop vs 2.0R target; max 20 bars forward; no volume/news/event/option-premium model, fees or slippage.'};
}
/*
  PARTHAVI TRADE DESK PRO — Phase 10 Prediction Engine
  Rule-based multi-timeframe prediction + confirmation + transparent historical target-hit backtest.
  This module never claims guaranteed profit.
*/

function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function n(v,d=null){ const x=Number(v); return Number.isFinite(x)?x:d; }
function dirScore(flagBull,flagBear,weight){ return flagBull?weight:flagBear?-weight:0; }

function summarizeLatest(rows){
  const r=rows||[]; const last=r.at(-1), prev=r.at(-2);
  if(!last) return {};
  const c=r.map(x=>n(x.c)).filter(Number.isFinite);
  const vol=r.map(x=>n(x.v)).filter(Number.isFinite);
  const avgVol=vol.length>20?vol.slice(-21,-1).reduce((a,b)=>a+b,0)/20:null;
  const volumeRatio=avgVol&&avgVol>0?n(last.v)/avgVol:null;
  const range=n(last.h)-n(last.l), body=Math.abs(n(last.c)-n(last.o));
  return {
    last:n(last.c), prev:n(prev?.c), volumeRatio,
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
    return {available:false,direction:'NO TRADE',entry:null,sl:null,target1:null,target2:null,riskPerUnit:null,rr1:null,rr2:null,mode:'WAIT'};
  }
  const riskPerUnit=Number(atr.toFixed(2));
  if(prediction==='BULLISH'){
    const entry=Number(last.toFixed(2)), sl=Number((last-1.0*atr).toFixed(2)), target1=Number((last+1.5*atr).toFixed(2)), target2=Number((last+2.25*atr).toFixed(2));
    return {available:true,direction:'CALL',mode:'UNDERLYING TRIGGER',entry,sl,target1,target2,riskPerUnit,rr1:1.5,rr2:2.25,invalidation:`5M close below SL ${sl}`};
  }
  const entry=Number(last.toFixed(2)), sl=Number((last+1.0*atr).toFixed(2)), target1=Number((last-1.5*atr).toFixed(2)), target2=Number((last-2.25*atr).toFixed(2));
  return {available:true,direction:'PUT',mode:'UNDERLYING TRIGGER',entry,sl,target1,target2,riskPerUnit,rr1:1.5,rr2:2.25,invalidation:`5M close above SL ${sl}`};
}

export function buildPrediction({h1,m15,m5,rows5=[],news={},global={},events={},options={},marketOpen=false,backtest=null}={}){
  const x5={...(m5||{}),...summarizeLatest(rows5)};
  const h1d=tfDirection(h1), m15d=tfDirection(m15);
  const rsi=n(x5.rsi), adx=n(x5.adx), atr=n(x5.atr), vwap=n(x5.vwap), last=n(x5.last);
  const macdHist=n(x5.macd?.hist);
  const vr=n(x5.volumeRatio);

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
  if(vr!=null&&vr>=1.2) score += x5.candle==='BULLISH'?weights.volume:x5.candle==='BEARISH'?-weights.volume:0;

  const pcr=n(options?.pcr); const ceDoi=n(options?.cedoi), peDoi=n(options?.pedoi);
  const optBull=options?.connected && (pcr>=1.05 || (peDoi!=null&&ceDoi!=null&&peDoi>ceDoi));
  const optBear=options?.connected && (pcr<=0.95 || (peDoi!=null&&ceDoi!=null&&ceDoi>peDoi));
  if(options?.connected) score += dirScore(optBull,optBear,weights.options);

  const newsBull=String(news?.bias||'')==='BULLISH', newsBear=String(news?.bias||'')==='BEARISH';
  if(news?.connected) score += dirScore(newsBull,newsBear,weights.news);
  const globalBull=String(global?.bias||'')==='RISK-ON', globalBear=String(global?.bias||'')==='RISK-OFF';
  if(global?.connected) score += dirScore(globalBull,globalBear,weights.global);

  score=Number(clamp(score,-100,100).toFixed(1));
  const prediction=score>=20?'BULLISH':score<=-20?'BEARISH':'NEUTRAL';

  const confirmations={
    trend: prediction!=='NEUTRAL' && h1d===prediction,
    setup: prediction!=='NEUTRAL' && m15d===prediction,
    trigger: prediction==='BULLISH'?bullTrigger:prediction==='BEARISH'?bearTrigger:false,
    momentum: prediction==='BULLISH'?(rsi!=null&&rsi>50&&macdHist!=null&&macdHist>0):(prediction==='BEARISH'?(rsi!=null&&rsi<50&&macdHist!=null&&macdHist<0):false),
    volume: vr!=null&&vr>=1.2,
    strength: adx!=null&&adx>=20,
    options: !!options?.connected && ((prediction==='BULLISH'&&optBull)||(prediction==='BEARISH'&&optBear)),
    news: !!news?.connected,
    global: !!global?.connected,
    eventSafe: !events?.hardBlock
  };
  const required=['trend','setup','trigger','momentum','volume','strength','options','news','global','eventSafe'];
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
  const feedComplete=!!marketOpen && !!news?.connected && !!global?.connected && !!options?.connected && !events?.hardBlock;
  // 85% is a strict QUALITY THRESHOLD, not a hard-coded profit probability.
  const eliteSetup=prediction!=='NEUTRAL' && confirmedCount>=9 && confirmationPct>=90 && modelConfidence>=85;
  const signalState=(!marketOpen||events?.hardBlock)?'NO TRADE':(eliteSetup&&feedComplete)?'CONFIRMED':(prediction!=='NEUTRAL'&&confirmedCount>=6)?'WATCH':'NO TRADE';
  const action=signalState==='CONFIRMED'?(prediction==='BULLISH'?'CALL':'PUT'):'NO TRADE';
  const reasoning = signalState==='CONFIRMED'
    ? `${prediction} structure aligns across 1H/15M/5M with ${confirmedCount}/${required.length} confirmation checks.`
    : !marketOpen ? 'Exchange session is closed; live trade action is disabled.'
    : events?.hardBlock ? 'High-impact event gate is active; no new trade is permitted.'
    : `${prediction==='NEUTRAL'?'Directional edge is weak.':prediction+' setup detected, but confirmation is incomplete.'} ${confirmedCount}/${required.length} checks currently pass.`;

  const plan=action!=='NO TRADE'?finalTradePlan(prediction,last,atr):finalTradePlan('NEUTRAL',last,atr);
  return {
    prediction, action, signalState, score,
    modelConfidence, confirmationPct, confirmedCount, confirmationTotal:required.length,
    confirmations, trend1h:h1d, setup15m:m15d, trigger5m:String(m5?.candle||'WAIT'),
    volumeRatio:vr, rsi, adx, atr, vwap, last,
    finalPlan:plan,
    signalBarTime:rows5?.at?.(-1)?.t||null,
    historical:backtest||{available:false,reason:'Historical backtest not available.'},
    feedComplete, eventBlocked:!!events?.hardBlock,
    note:'85% is a strict model-quality gate earned only by strong multi-timeframe, options, news, global and event confirmation. It is not a guaranteed or calibrated probability of profit. Final SL/targets are volatility-based planning levels on the underlying index; option premium SL/targets must be verified from the selected live contract and its Greeks.',
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
    const volSlice=r.slice(Math.max(0,i-20),i).map(x=>x.v).filter(Number.isFinite); const av=volSlice.length?volSlice.reduce((a,b)=>a+b,0)/volSlice.length:0; const vr=av?Number(r[i].v)/av:null;
    const bull=e20!=null&&e50!=null&&e20>e50&&rr!=null&&rr>52&&vr!=null&&vr>=1.0;
    const bear=e20!=null&&e50!=null&&e20<e50&&rr!=null&&rr<48&&vr!=null&&vr>=1.0;
    if(!bull&&!bear) continue;
    candidates++;
    const trAvg=trs.slice(Math.max(0,trs.length-14)).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(14,trs.length)); if(!Number.isFinite(trAvg)||trAvg<=0) continue;
    const entry=r[i].c, stop=trAvg, target=trAvg*1.25; let outcome='UNRESOLVED';
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
  const expectedR=rate!=null?Number((rate/100*1.25-(1-rate/100)).toFixed(2)):null; return {available:resolved>=30,signals:candidates,resolved,wins:hits,losses:resolved-hits,targetHitRate:rate,expectedR,sample:resolved,minSample:30,method:'5M rolling EMA20/EMA50 + RSI + volume trigger; 1.0R stop vs 1.25R target; max 20 bars forward; no fees/slippage.'};
}
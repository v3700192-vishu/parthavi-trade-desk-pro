/*
  PARTHAVI TRADE DESK PRO — Phase 11 Capital Shield
  Safety-first execution quality gate. This module does NOT guarantee profit.
  It filters low-quality setups and caps exposure before any live order reaches Angel One.
*/

function num(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}
function bool(v,d=false){if(v==null)return d;return ['1','true','yes','on'].includes(String(v).trim().toLowerCase())}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function istDate(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const o=Object.fromEntries(p.map(x=>[x.type,x.value])); return `${o.year}-${o.month}-${o.day}`;
}

const cfg={
  enabled:bool(process.env.PHASE11_PROTECTION_ENABLED,true),
  maxDailyLoss:num(process.env.MAX_DAILY_LOSS_RUPEES,1000),
  maxConsecutiveLosses:Math.max(1,Math.floor(num(process.env.MAX_CONSECUTIVE_LOSSES,2))),
  maxTradesPerDay:Math.max(1,Math.floor(num(process.env.MAX_TRADES_PER_DAY,8))),
  cooldownMinutes:Math.max(0,Math.floor(num(process.env.COOLDOWN_MINUTES,15))),
  minRR:Math.max(1,num(process.env.MIN_RR,2.0)),
  maxOpenPositions:Math.max(1,Math.floor(num(process.env.MAX_OPEN_POSITIONS,3))),
  minModelConfidence:Math.max(0,Math.floor(num(process.env.MIN_MODEL_CONFIDENCE,70))),
  minConfirmationPct:Math.max(0,Math.floor(num(process.env.MIN_CONFIRMATION_PCT,80))),
  maxSpreadPct:Math.max(0,num(process.env.MAX_SPREAD_PCT,1.25)),
  requireSignalToken:bool(process.env.REQUIRE_SIGNAL_TOKEN,true),
  requireStopLoss:bool(process.env.REQUIRE_STOP_LOSS,true),
  noAveraging:bool(process.env.NO_AVERAGING,true),
  noMartingale:bool(process.env.NO_MARTINGALE,true)
};

const state={date:istDate(),dailyLoss:0,consecutiveLosses:0,trades:0,lastTradeAt:0,lockedUntil:0,breachReasons:[]};
function rollDay(){const d=istDate(); if(d!==state.date){Object.assign(state,{date:d,dailyLoss:0,consecutiveLosses:0,trades:0,lastTradeAt:0,lockedUntil:0,breachReasons:[]});}}
function status(){
  rollDay();
  const now=Date.now();
  const cooldownLeft=Math.max(0,Math.ceil((state.lockedUntil-now)/60000));
  const dailyLeft=Math.max(0,cfg.maxDailyLoss-state.dailyLoss);
  const locked=cooldownLeft>0 || state.dailyLoss>=cfg.maxDailyLoss || state.consecutiveLosses>=cfg.maxConsecutiveLosses || state.trades>=cfg.maxTradesPerDay;
  return {
    enabled:cfg.enabled,mode:'CAPITAL SHIELD',locked,
    dailyLoss:Number(state.dailyLoss.toFixed(2)),dailyLossCap:cfg.maxDailyLoss,dailyLossRemaining:Number(dailyLeft.toFixed(2)),
    consecutiveLosses:state.consecutiveLosses,maxConsecutiveLosses:cfg.maxConsecutiveLosses,
    tradesToday:state.trades,maxTradesPerDay:cfg.maxTradesPerDay,
    cooldownMinutes:cfg.cooldownMinutes,cooldownRemaining:cooldownLeft,
    minRR:cfg.minRR,maxOpenPositions:cfg.maxOpenPositions,minModelConfidence:cfg.minModelConfidence,
    minConfirmationPct:cfg.minConfirmationPct,maxSpreadPct:cfg.maxSpreadPct,
    noAveraging:cfg.noAveraging,noMartingale:cfg.noMartingale,requireStopLoss:cfg.requireStopLoss,
    requireSignalToken:cfg.requireSignalToken,breachReasons:[...state.breachReasons],asOf:new Date().toISOString()
  };
}
function evaluate({maxLoss=0,rr=0,modelConfidence=null,confirmationPct=null,spreadPct=null,openPositions=0,side='BUY',signalAction='',isOption=false,hasStopLoss=true,vix=null,adx=null,volumeRatio10d=null,eventDayBlock=false}={}){
  rollDay(); const errors=[]; const now=Date.now();
  if(!cfg.enabled) return {ok:true,errors:[],status:status()};
  if(state.dailyLoss>=cfg.maxDailyLoss) errors.push('DAILY_LOSS_CAP_REACHED');
  if(state.consecutiveLosses>=cfg.maxConsecutiveLosses) errors.push('CONSECUTIVE_LOSS_LOCK');
  if(state.trades>=cfg.maxTradesPerDay) errors.push('MAX_TRADES_PER_DAY_REACHED');
  if(state.lockedUntil>now) errors.push(`COOLDOWN_ACTIVE_${Math.ceil((state.lockedUntil-now)/60000)}M`);
  if(openPositions>=cfg.maxOpenPositions) errors.push('MAX_OPEN_POSITIONS_REACHED');
  if(Number.isFinite(Number(vix)) && (Number(vix)<12 || Number(vix)>22)) errors.push('VIX_NO_TRADE_ZONE');
  if(Number.isFinite(Number(adx)) && Number(adx)<20) errors.push('ADX_BELOW_20');
  if(Number.isFinite(Number(volumeRatio10d)) && Number(volumeRatio10d)<1.5) errors.push('BREAKOUT_VOLUME_BELOW_1_5X_10D');
  if(eventDayBlock) errors.push('HIGH_IMPACT_EVENT_DAY');
  if(cfg.requireStopLoss&&!hasStopLoss) errors.push('STOP_LOSS_REQUIRED');
  if(maxLoss>0 && maxLoss>Math.max(0,cfg.maxDailyLoss-state.dailyLoss)) errors.push('TRADE_RISK_EXCEEDS_DAILY_PROTECTION_BUDGET');
  if(rr>0 && rr<cfg.minRR) errors.push(`MIN_RR_${cfg.minRR}_REQUIRED`);
  if(modelConfidence!=null && modelConfidence<cfg.minModelConfidence) errors.push('MODEL_CONFIDENCE_BELOW_GATE');
  if(confirmationPct!=null && confirmationPct<cfg.minConfirmationPct) errors.push('CONFIRMATION_BELOW_GATE');
  if(spreadPct!=null && spreadPct>cfg.maxSpreadPct) errors.push('BID_ASK_SPREAD_TOO_WIDE');
  if(isOption && cfg.requireSignalToken && !signalAction) errors.push('SIGNED_SIGNAL_CONFIRMATION_REQUIRED');
  if(signalAction && isOption){
    const expected=side==='BUY'?(String(signalAction).toUpperCase()==='CALL'?'CALL':'PUT'):String(signalAction).toUpperCase();
    // SELL orders are allowed as exits only; new short-option trades are not opened by this phase.
    if(side==='BUY' && !['CALL','PUT'].includes(expected)) errors.push('SIGNAL_DIRECTION_INVALID');
  }
  return {ok:errors.length===0,errors,status:status()};
}
function onOrderSubmitted(maxLoss=0){rollDay();state.trades+=1;state.lastTradeAt=Date.now();state.lockedUntil=Date.now()+cfg.cooldownMinutes*60000; if(maxLoss>0 && state.dailyLoss+maxLoss>cfg.maxDailyLoss){state.breachReasons.push('Projected loss budget exceeded');}}
function recordOutcome(pnl=0){rollDay();const x=num(pnl);if(x<0){state.dailyLoss+=Math.abs(x);state.consecutiveLosses+=1;}else if(x>0){state.consecutiveLosses=0;} if(state.dailyLoss>=cfg.maxDailyLoss) state.breachReasons.push('Daily loss cap reached');}
function resetProtection(){rollDay();state.dailyLoss=0;state.consecutiveLosses=0;state.trades=0;state.lastTradeAt=0;state.lockedUntil=0;state.breachReasons=[];return status();}

export {cfg,status,evaluate,onOrderSubmitted,recordOutcome,resetProtection};
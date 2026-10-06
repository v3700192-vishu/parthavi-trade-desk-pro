import "dotenv/config";
import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { angelStatus, loginAngel, logoutAngel, ltp as angelLtp, quote as angelQuote, candles as angelCandles, searchScrip as angelSearchScrip, loadMaster, findContracts, findInstrumentByToken, subscribe as angelSubscribe, reconnectWebSocket as angelReconnectWebSocket, quoteInstruments, optionGreeks, getLatestTicks, rms as angelRms, orderBook as angelOrderBook, placeOrder as angelPlaceOrder, cancelOrder as angelCancelOrder, holdings as angelHoldings, allHoldings as angelAllHoldings, positions as angelPositions, tradeBook as angelTradeBook, modifyOrder as angelModifyOrder } from "./angelone.js";
import { normalizeNews, analyzeNews, normalizeGlobal, analyzeGlobal, analyzeEvents, fuse } from "./fusion.js";
import { buildPrediction, backtestFiveMinute } from "./prediction.js";
import { productionReadiness } from "./phase12.js";
import { status as phase11ProtectionStatus, evaluate as phase11Evaluate, onOrderSubmitted as phase11OnOrderSubmitted, recordOutcome as phase11RecordOutcome, resetProtection as phase11ResetProtection } from "./riskGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Cross-origin access for the static GitHub Pages frontend and configured production frontend.
const allowedOrigins = new Set(String(process.env.FRONTEND_ORIGINS || "https://v3700192-vishu.github.io,https://parthavi-trade-desk-pro.onrender.com").split(",").map(x=>x.trim()).filter(Boolean));
app.use((req,res,next)=>{
  const origin=String(req.headers.origin||"");
  if(origin && allowedOrigins.has(origin)){
    res.setHeader("Access-Control-Allow-Origin",origin);
    res.setHeader("Vary","Origin");
    res.setHeader("Access-Control-Allow-Credentials","true");
    res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  }
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({limit:"64kb"}));

// Phase 11 security middleware: conservative headers + lightweight per-IP rate limiting.
const rateBuckets = new Map();
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  if(req.path.startsWith("/api/")){
    const ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").split(",")[0].trim();
    const now=Date.now(), minute=Math.floor(now/60000); const k=`${ip}:${minute}`;
    const count=(rateBuckets.get(k)||0)+1; rateBuckets.set(k,count);
    if(count>150) return res.status(429).json({ok:false,error:"RATE_LIMITED",message:"Too many requests. Please slow down."});
    for(const [key] of rateBuckets){ if(!key.endsWith(`:${minute}`)&&Math.random()<0.04) rateBuckets.delete(key); }
  }
  next();
});
app.use(express.static(path.join(__dirname, "public"), { setHeaders(res, filePath){ if(filePath.endsWith("index.html")) res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate"); } }));

const PORT = Number(process.env.PORT || 8787);
const DEMO = String(process.env.DEMO_MODE || "false").toLowerCase() === "true";

/*
  LIVE ADAPTER CONTRACT
  Replace these functions with authenticated providers:
  - market(): Angel One SmartAPI REST/WebSocket adapter
  - options(): Angel One option-chain/instrument adapter
  - news(): compliant news provider adapter
  - global(): market-data adapter for global indices, FX, rates, commodities
  - events(): economic-calendar provider adapter

  Never put API keys, OTPs or access tokens in public/index.html.
*/

const state = {
  last: {
    market: 0,
    options: 0,
    news: 0,
    global: 0
  },
  connected: {
    market: false,
    options: false,
    news: false,
    global: false
  }
};

const execution = {
  previews: new Map(),
  recentOrderIds: new Set()
};

const PHASE11_SECRET = String(process.env.PHASE11_SECRET || 'CHANGE_ME_PHASE11_SECRET');
function signedPayload(payload){
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',PHASE11_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySignedPayload(token){
  try{
    const [body,sig]=String(token||'').split('.'); if(!body||!sig) return null;
    const expected=crypto.createHmac('sha256',PHASE11_SECRET).update(body).digest('base64url');
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
    const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(Number(payload.expiresAt||0)<Date.now()) return null;
    return payload;
  }catch{return null;}
}
function isOptionSymbol(symbol){ return /(?:CE|PE)$/i.test(cleanTradingSymbol(symbol)); }
function phase11PolicyForOrder({p,instrument,signalSnapshot=null,openPositions=0}={}){
  const orderType=String(p?.transactiontype||p?.side||'BUY').toUpperCase();
  const entry=Number(p?.price||p?.entry||0);
  const sl=Number(p?.stopLoss||p?.sl||0);
  const target=Number(p?.target1||p?.target||0);
  const rr=entry>0 && sl>0 && target>0 ? (orderType==='BUY'?(target-entry)/(entry-sl):(entry-target)/(sl-entry)) : 0;
  const spreadPct=Number(p?.spreadPct);
  const isOption=isOptionSymbol(instrument?.symbol||p?.tradingsymbol||'');
  const projection=Math.abs((entry||0)-sl)*(Number(p?.quantity)||0);
  return phase11Evaluate({
    maxLoss:projection,rr:modelSafe(rr),
    modelConfidence:signalSnapshot?.modelConfidence,confirmationPct:signalSnapshot?.confirmationPct,
    spreadPct:Number.isFinite(spreadPct)?spreadPct:null,openPositions,side:orderType,
    signalAction:signalSnapshot?.action||'',isOption,hasStopLoss:sl>0,
    vix:signalSnapshot?.vix,adx:signalSnapshot?.adx,volumeRatio10d:signalSnapshot?.volumeRatio10d,eventDayBlock:!!signalSnapshot?.eventDayBlock,theta:signalSnapshot?.theta,delta:signalSnapshot?.delta
  });
}
function modelSafe(x){return Number.isFinite(x)&&x>0?x:0;}
function extractUnderlyingFromSymbol(symbol){
  const s=cleanTradingSymbol(symbol); if(s.startsWith('BANKNIFTY')) return 'BANKNIFTY'; if(s.startsWith('FINNIFTY')) return 'FINNIFTY'; if(s.startsWith('MIDCPNIFTY')) return 'MIDCPNIFTY'; if(s.startsWith('SENSEX')) return 'SENSEX'; if(s.startsWith('NIFTY')) return 'NIFTY'; return 'NIFTY';
}
function signalMatchesContract(snapshot,instrument,side){
  if(!snapshot) return false;
  const action=String(snapshot.action||'').toUpperCase();
  const symbol=cleanTradingSymbol(instrument?.symbol||'');
  if(side!=='BUY') return true; // exits/sells are not directional-entry signals.
  if(action==='CALL') return /CE$/.test(symbol);
  if(action==='PUT') return /PE$/.test(symbol);
  return false;
}

function boolEnv(name, fallback=false){
  const v=String(process.env[name]??fallback).trim().toLowerCase();
  return ['1','true','yes','on'].includes(v);
}
function numEnv(name, fallback){ const x=Number(process.env[name]); return Number.isFinite(x)?x:fallback; }
function executionStatus(exchange='NSE'){
  return {
    connected:angelStatus().connected,
    marketOpen:exchangeSessionOpen(exchange),
    exchange:String(exchange||'NSE').toUpperCase(),
    executionEnabled:boolEnv('ORDER_EXECUTION_ENABLED',false),
    staticIpVerified:boolEnv('STATIC_IP_VERIFIED',false),
    killSwitch:boolEnv('TRADING_KILL_SWITCH',true),
    maxRiskRupees:numEnv('MAX_RISK_RUPEES',null),
    maxOrderQty:numEnv('MAX_ORDER_QTY',0),
    maxEntrySlippagePct:numEnv('MAX_ENTRY_SLIPPAGE_PCT',0.75),
    ready:angelStatus().connected && exchangeSessionOpen(exchange) && boolEnv('ORDER_EXECUTION_ENABLED',false) && boolEnv('STATIC_IP_VERIFIED',false) && !boolEnv('TRADING_KILL_SWITCH',true)
  };
}
function cleanTradingSymbol(s){ return String(s||'').trim().toUpperCase(); }
function positiveNumber(v){ const x=Number(v); return Number.isFinite(x)&&x>0 ? x : null; }
function buildOrderPayload(p, instrument){
  const exchSeg=String(instrument?.exch_seg||'').toLowerCase();
  const exchange = exchSeg==='nse_cm'?'NSE':exchSeg==='nse_fo'?'NFO':exchSeg==='bse_cm'?'BSE':exchSeg==='bse_fo'?'BFO':String(p.exchange||'').toUpperCase();
  const qty=Number(p.quantity);
  const payload={
    variety:'NORMAL',
    tradingsymbol:String(instrument.symbol),
    symboltoken:String(instrument.token),
    transactiontype:String(p.transactiontype||p.side||'BUY').toUpperCase(),
    exchange,
    ordertype:String(p.ordertype||'LIMIT').toUpperCase(),
    producttype:String(p.producttype||'INTRADAY').toUpperCase(),
    duration:'DAY',
    price:String(p.price??'0'),
    squareoff:'0',
    stoploss:'0',
    quantity:String(qty),
    scripconsent:'yes'
  };
  return payload;
}
function validateOrderInput(p, instrument){
  const errors=[];
  if(!instrument) errors.push('Instrument token is not valid in the live instrument master.');
  const side=String(p.transactiontype||p.side||'').toUpperCase();
  if(!['BUY','SELL'].includes(side)) errors.push('Transaction type must be BUY or SELL.');
  const qty=Number(p.quantity); if(!Number.isInteger(qty)||qty<=0) errors.push('Quantity must be a positive integer.');
  if(qty>0 && numEnv('MAX_ORDER_QTY',0)>0 && qty>numEnv('MAX_ORDER_QTY',0)) errors.push('Quantity exceeds server MAX_ORDER_QTY.');
  const ordertype=String(p.ordertype||'LIMIT').toUpperCase();
  if(!['MARKET','LIMIT','STOPLOSS_LIMIT','STOPLOSS_MARKET'].includes(ordertype)) errors.push('Unsupported order type.');
  const price=ordertype==='MARKET'?0:positiveNumber(p.price); if(ordertype!=='MARKET'&&!price) errors.push('A positive limit/trigger price is required.');
  const sl=positiveNumber(p.stopLoss); if(!sl) errors.push('Stop loss is mandatory for Phase 5.');
  if(price && sl && side==='BUY' && sl>=price) errors.push('BUY stop loss must be below entry/limit price.');
  if(price && sl && side==='SELL' && sl<=price) errors.push('SELL stop loss must be above entry/limit price.');
  const lot=Math.max(1,Number(instrument?.lotsize||1)); if(qty%lot!==0) errors.push(`Quantity must be a multiple of lot size ${lot}.`);
  if(instrument && String(instrument.exch_seg||'').toLowerCase()==='nse_cm' && !['INTRADAY','DELIVERY','CNC'].includes(String(p.producttype||'INTRADAY').toUpperCase())) errors.push('Unsupported product type for cash equity.');
  return {errors,price,sl,qty,side,ordertype,lot};
}
function trimPreviewStore(){
  const now=Date.now(); for(const [id,v] of execution.previews){ if(v.expiresAt<now) execution.previews.delete(id); }
  while(execution.previews.size>100) execution.previews.delete(execution.previews.keys().next().value);
}


function nowISO(){ return new Date().toISOString(); }
const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26','2026-03-03','2026-03-26','2026-03-31','2026-04-03','2026-04-14','2026-05-01',
  '2026-05-28','2026-06-26','2026-09-14','2026-10-02','2026-10-20','2026-11-10','2026-11-24','2026-12-25'
]);
function istParts(){
  const p=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hour12:false}).formatToParts(new Date());
  return Object.fromEntries(p.map(z=>[z.type,z.value]));
}
function configuredHolidays(){ return new Set(String(process.env.EXTRA_HOLIDAYS_IST||'').split(',').map(x=>x.trim()).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x))); }
function exchangeSessionOpen(exchange='NSE'){
  const x=istParts(), date=`${x.year}-${x.month}-${x.day}`, day=x.weekday, mins=Number(x.hour)*60+Number(x.minute);
  if(['Sat','Sun'].includes(day) || mins<555 || mins>=940) return false;
  const ex=String(exchange||'NSE').toUpperCase();
  const extra=configuredHolidays();
  if(ex==='NSE' && (NSE_HOLIDAYS_2026.has(date)||extra.has(date))) return false;
  if(ex==='BSE'){
    const bseExtra=new Set(String(process.env.BSE_HOLIDAYS_IST||'').split(',').map(x=>x.trim()).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)));
    // BSE execution is blocked unless its calendar has been explicitly supplied/verified.
    if(!boolEnv('BSE_SESSION_VERIFIED',false)) return false;
    if(bseExtra.has(date)||extra.has(date)) return false;
  }
  return true;
}
function marketSession(){ return exchangeSessionOpen('NSE'); }

async function fetchProviderJson(url, token, params={}){
  if(!url) return null;
  const u=new URL(url);
  for(const [k,v] of Object.entries(params||{})) if(v!=null&&v!=="") u.searchParams.set(k,String(v));
  const headers={accept:"application/json"};
  if(token) headers.authorization=`Bearer ${token}`;
  const r=await fetch(u,{headers,signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error(`Provider HTTP ${r.status}`);
  return await r.json();
}
async function market(symbol){
  if(DEMO) return { [symbol]:{ltp:null,change:null}, NIFTY:{ltp:null}, BANKNIFTY:{ltp:null}, FINNIFTY:{ltp:null}, MIDCPNIFTY:{ltp:null}, VIX:{ltp:null}, GLOBAL_RISK:{label:"DEMO OFF"} };
  if(!angelStatus().connected) return null;
  const tokens={NIFTY:['NSE','Nifty 50','99926000'],BANKNIFTY:['NSE','Nifty Bank','99926009'],FINNIFTY:['NSE','Nifty Fin Service','99926037'],MIDCPNIFTY:['NSE','NIFTY MID SELECT','99926074'],VIX:['NSE','India VIX','99926017']};
  const out={};
  for(const [key,info] of Object.entries(tokens)){
    try{ const r=await angelLtp({exchange:info[0],tradingsymbol:info[1],symboltoken:info[2]}); const d=r?.data||r; out[key]={ltp:d?.ltp??null,change:d?.percentChange??d?.percentageChange??(Number.isFinite(Number(d?.ltp))&&Number.isFinite(Number(d?.close))&&Number(d?.close)!==0?((Number(d.ltp)-Number(d.close))/Number(d.close))*100:null),open:d?.open??null,high:d?.high??null,low:d?.low??null,close:d?.close??null}; }catch{ out[key]={ltp:null,change:null}; }
  }
  out[symbol]=out[symbol]||{ltp:null,change:null};
  out.GLOBAL_RISK={label:"WAIT"};
  return out;
}
async function options(symbol){
  if(DEMO) return {atm:null,ceoi:null,cedoi:null,peoi:null,pedoi:null,iv:null,pcr:null};
  if(!angelStatus().connected) return null;
  try{
    const ins=await resolveIndexToken(symbol);
    const l=await angelLtp({exchange:'NSE',tradingsymbol:ins.symbol,symboltoken:ins.token});
    const spot=Number((l?.data||l)?.ltp); if(!Number.isFinite(spot)) return null;
    const items=await loadMaster(); const now=Date.now();
    const parseExpiry=(x)=>{const m=String(x||'').match(/^(\d{2})([A-Z]{3})(\d{4})$/i); if(!m)return 0; const mo={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11}[m[2].toUpperCase()]; return mo==null?0:new Date(Number(m[3]),mo,Number(m[1]),23,59,59).getTime();};
    const strikes=items.filter(x=>String(x.exch_seg||'').toLowerCase()==='nse_fo'&&String(x.name||'').toUpperCase()===String(symbol).toUpperCase()&&/^(CE|PE)$/i.test(String(x.symbol||'').slice(-2))&&parseExpiry(x.expiry)>=now).map(x=>Number(x.strike)/100).filter(Number.isFinite);
    const expiries=[...new Set(items.filter(x=>String(x.exch_seg||'').toLowerCase()==='nse_fo'&&String(x.name||'').toUpperCase()===String(symbol).toUpperCase()&&/^(CE|PE)$/i.test(String(x.symbol||'').slice(-2))&&parseExpiry(x.expiry)>=now).map(x=>String(x.expiry||'').toUpperCase()).filter(Boolean))].sort((a,b)=>parseExpiry(a)-parseExpiry(b));
    const liveExpiry=expiries[0]||null;
    if(!strikes.length) return {atm:Math.round(spot/50)*50,ceoi:null,cedoi:null,peoi:null,pedoi:null,iv:null,pcr:null,connected:true};
    const atm=strikes.reduce((best,s)=>Math.abs(s-spot)<Math.abs(best-spot)?s:best,strikes[0]);
    const base=await findContracts({exchange:'NSE',segment:'OPTIDX',underlying:symbol,expiry:liveExpiry||'',optionType:'CE'});
    const pe=await findContracts({exchange:'NSE',segment:'OPTIDX',underlying:symbol,expiry:liveExpiry||'',optionType:'PE'});
    const near=(arr)=>arr.map(x=>({...x,_strike:Number(x.strike)/100})).filter(x=>Number.isFinite(x._strike)).sort((a,b)=>Math.abs(a._strike-atm)-Math.abs(b._strike-atm)).slice(0,25);
    const nearCe=near(base), nearPe=near(pe);
    const q=await quoteInstruments([...nearCe,...nearPe]);
    const map=new Map(q.map(x=>[String(x.symbolToken),x]));
    const enriched=[...nearCe.map(x=>({...x,side:'CE'})),...nearPe.map(x=>({...x,side:'PE'}))].map(x=>{const qq=map.get(String(x.token))||{};return {...x,oi:Number(qq.opnInterest??qq.openInterest??qq.oi)}}).filter(x=>Number.isFinite(x.oi));
    const ces=enriched.filter(x=>x.side==='CE'), pes=enriched.filter(x=>x.side==='PE');
    const maxOi=(arr)=>arr.length?arr.reduce((a,b)=>b.oi>a.oi?b:a,arr[0]):null;
    const ceMax=maxOi(ces), peMax=maxOi(pes);
    const ce=ces.reduce((a,b)=>Math.abs(b._strike-atm)<Math.abs((a?._strike??atm)-atm)?b:a,null);
    const p=pes.reduce((a,b)=>Math.abs(b._strike-atm)<Math.abs((a?._strike??atm)-atm)?b:a,null);
    const ceoi=Number(ce?.oi), peoi=Number(p?.oi),
      resistance=ceMax?Number(ceMax._strike):null, support=peMax?Number(peMax._strike):null;
    return {connected:true,atm,expiry:liveExpiry,ceoi:Number.isFinite(ceoi)?ceoi:null,cedoi:null,peoi:Number.isFinite(peoi)?peoi:null,pedoi:null,iv:null,pcr:Number.isFinite(ceoi)&&Number.isFinite(peoi)&&ceoi?Number((peoi/ceoi).toFixed(3)):null,
      ceMaxOi:ceMax?{strike:Number(ceMax._strike),oi:ceMax.oi,symbol:ceMax.symbol}:null,
      peMaxOi:peMax?{strike:Number(peMax._strike),oi:peMax.oi,symbol:peMax.symbol}:null,
      resistance,support,oiInterpretation:ceMax&&peMax?`CE OI concentration ${ceMax._strike} resistance • PE OI concentration ${peMax._strike} support`:'Partial OI chain',chainCount:enriched.length};
  }catch{return {connected:false,atm:null,ceoi:null,cedoi:null,peoi:null,pedoi:null,iv:null,pcr:null};}
}
const greekCache=new Map();
async function liveOptionGreeks(symbol,expiry){
  const key=String(symbol)+'|'+String(expiry||'');
  const cached=greekCache.get(key);
  if(cached && Date.now()-cached.at<5000) return cached.data;
  const raw=await optionGreeks({name:String(symbol).toUpperCase(),expirydate:expiry});
  const rows=Array.isArray(raw)?raw:[];
  const data=rows.map(x=>({
    name:x.name,expiry:x.expiry,strike:Number(x.strikePrice),
    optionType:String(x.optionType||'').toUpperCase(),
    delta:Number(x.delta),gamma:Number(x.gamma),theta:Number(x.theta),
    vega:Number(x.vega),iv:Number(x.impliedVolatility),tradeVolume:Number(x.tradeVolume)
  })).filter(x=>Number.isFinite(x.strike)&&Number.isFinite(x.delta)&&Number.isFinite(x.theta));
  greekCache.set(key,{at:Date.now(),data});
  return data;
}
function greekRiskWarning(g){
  if(!g) return {status:'WAIT',message:'Live option Greeks not verified.'};
  const theta=Math.abs(Number(g.theta)), delta=Math.abs(Number(g.delta));
  if(!Number.isFinite(theta)||!Number.isFinite(delta)) return {status:'WAIT',message:'Live option Greeks not verified.'};
  if(theta>=10 || delta<0.20) return {status:'NO TRADE',message:'Theta Decay is too high or Delta is too low. Option buying is risky today.'};
  if(theta>=6 || delta<0.35) return {status:'CAUTION',message:'Theta/Delta profile is unfavorable for option buying. Prefer NO TRADE unless the setup is exceptionally strong.'};
  return {status:'PASS',message:'Theta/Delta profile is acceptable for option buying.'};
}
function positionSizeFromRisk({riskBudget=1000,entry,sl,lotSize,availableBudget=null}){
  const budget=Math.max(0,Number(riskBudget)||0), e=Number(entry), s=Number(sl), lot=Math.max(1,Math.floor(Number(lotSize)||1));
  const perUnit=Math.abs(e-s), perLot=perUnit*lot;
  const cap=Number.isFinite(Number(availableBudget))?Math.min(budget,Math.max(0,Number(availableBudget))):budget;
  const lots=perLot>0?Math.floor(cap/perLot):0;
  return {riskBudget:cap,entry:e,stopLoss:s,lossPerUnit:Number.isFinite(perUnit)?perUnit:null,lotSize:lot,lossPerLot:Number.isFinite(perLot)?perLot:null,recommendedLots:lots,recommendedQuantity:lots*lot,usedRisk:Number((lots*perLot).toFixed(2)),unusedRisk:Number(Math.max(0,cap-lots*perLot).toFixed(2))};
}

const newsCache=new Map();
const globalCache={at:0,data:null};
async function news(symbol){
  const key=String(symbol||'NIFTY').toUpperCase(), now=Date.now(), cached=newsCache.get(key);
  if(cached && now-cached.at<60000) return cached.items;
  try{
    const raw=await fetchProviderJson(process.env.NEWS_PROVIDER_URL,process.env.NEWS_PROVIDER_TOKEN,{symbol,limit:30,country:"IN"});
    if(raw!=null){
      const items=normalizeNews(raw,symbol).filter(x=>x.ageMin!=null&&x.ageMin<=1440);
      newsCache.set(key,{at:now,items});
      return items;
    }
  }catch{}
  try{
    const q=encodeURIComponent(`${key} NSE India stock market`);
    const url=`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
    const rr=await fetch(url,{headers:{accept:'application/rss+xml,application/xml,text/xml','user-agent':'PARTHAVI-TRADE-DESK-PRO/1.0'},signal:AbortSignal.timeout(10000)});
    if(!rr.ok) throw new Error(`News RSS HTTP ${rr.status}`);
    const xml=await rr.text();
    const tag=(body,name)=>{const m=body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`,'i')); return m?m[1].replace(/<!\\[CDATA\\[|\\]\\]>/g,'').trim():'';};
    const rawItems=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>{const b=m[1];return {title:tag(b,'title'),source:tag(b,'source'),pubDate:tag(b,'pubDate'),link:tag(b,'link')};}).filter(x=>x.title);
    const items=normalizeNews(rawItems,symbol).filter(x=>x.ageMin!=null&&x.ageMin<=1440);
    newsCache.set(key,{at:now,items});
    return items;
  }catch{
    return [];
  }
}
async function yahooLastChange(ticker){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=2d`;
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'PARTHAVI-TRADE-DESK-PRO/1.0'},signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error(`Yahoo market HTTP ${r.status}`);
  const j=await r.json(), result=j?.chart?.result?.[0], meta=result?.meta||{}, q=result?.indicators?.quote?.[0]||{};
  const closes=(q.close||[]).map(Number).filter(Number.isFinite);
  const price=Number(meta.regularMarketPrice??closes.at(-1)); if(!Number.isFinite(price)) throw new Error('No Yahoo price');
  const prev=closes.length>1?closes.at(-2):null;
  const change=Number.isFinite(prev)&&prev!==0?((price-prev)/prev)*100:null;
  const rawTs=Number(meta.regularMarketTime||0)*1000;
  const asOf=Number.isFinite(rawTs)&&rawTs>0?new Date(rawTs).toISOString():null;
  const ageSec=asOf?Math.max(0,(Date.now()-rawTs)/1000):null;
  const status=ageSec==null?'UNVERIFIED':ageSec<=600?'LIVE':ageSec<=14400?'DELAYED':'UNVERIFIED';
  return {
    value:Number(price.toFixed(4)),
    change:change==null?null:Number(change.toFixed(3)),
    source:'YAHOO_FINANCE',
    asOf,
    ageSec:ageSec==null?null:Number(ageSec.toFixed(0)),
    status
  };
}
async function globalData(){
  const now=Date.now();
  if(globalCache.data && now-globalCache.at<60000) return globalCache.data;
  const symbols={
    US_FUTURES:'NQ=F',SPX:'^GSPC',NIKKEI:'^N225',HSI:'^HSI',USDINR:'INR=X',US10Y:'^TNX',BRENT:'BZ=F',GOLD:'GC=F',VIX:'^VIX'
  };
  const entries=await Promise.all(Object.entries(symbols).map(async([k,ticker])=>{try{return [k,await yahooLastChange(ticker)];}catch{return [k,null];}}));
  const raw={};
  for(const [k,v] of entries) if(v) raw[k]=v;
  if(raw.SPX||raw.US_FUTURES) raw.US_FUTURES=raw.US_FUTURES||raw.SPX;
  if(raw.NIKKEI||raw.HSI){
    const a=[raw.NIKKEI?.change,raw.HSI?.change].filter(Number.isFinite);
    if(a.length){
      const refs=[raw.NIKKEI,raw.HSI].filter(Boolean);
      const latestAsOf=refs.map(x=>x.asOf).filter(Boolean).sort().at(-1)||null;
      const ageSec=latestAsOf?Math.max(0,(Date.now()-Date.parse(latestAsOf))/1000):null;
      raw.ASIA={
        value:'Nikkei/HSI',
        change:Number((a.reduce((x,y)=>x+y,0)/a.length).toFixed(3)),
        source:'YAHOO_FINANCE',
        asOf:latestAsOf,
        ageSec:ageSec==null?null:Number(ageSec.toFixed(0)),
        status:ageSec==null?'UNVERIFIED':ageSec<=600?'LIVE':ageSec<=14400?'DELAYED':'UNVERIFIED'
      };
    }
  }
  // GIFT NIFTY stays explicitly UNVERIFIED until a verified provider is configured.
  if(!raw.GIFT_NIFTY){
    raw.GIFT_NIFTY={value:null,change:null,source:'NOT_CONFIGURED',asOf:null,ageSec:null,status:'UNVERIFIED',reason:'GIFT NIFTY provider not configured'};
  }
  const out=normalizeGlobal(raw);
  globalCache.at=now; globalCache.data=out;
  return out;
}
async function events(){
  const raw=await fetchProviderJson(process.env.EVENTS_PROVIDER_URL,process.env.EVENTS_PROVIDER_TOKEN,{country:"IN",region:"global",days:2});
  if(raw==null) return [];
  return (raw?.events||raw?.items||raw?.data||raw||[]);
}


// Angel One SmartAPI connection layer. Credentials/tokens never enter public/index.html.
app.get("/api/angel/status", (req,res)=>res.json(angelStatus()));
app.get("/api/angel/config-status", (req,res)=>{
  const hasApiKey=Boolean(String(process.env.ANGEL_API_KEY||process.env.ANGELONE_API_KEY||"").trim());
  const hasClientCode=Boolean(String(process.env.ANGEL_CLIENT_CODE||process.env.ANGELONE_CLIENT_CODE||"").trim());
  res.json({
    ok:true,
    configured:hasApiKey && hasClientCode,
    apiKeyConfigured:hasApiKey,
    clientCodeConfigured:hasClientCode,
    note:"PIN and TOTP are supplied only at login time and are never stored by this endpoint."
  });
});
app.post("/api/angel/reconnect", async (req,res)=>{
  try{
    const out=await angelReconnectWebSocket();
    res.json({ok:true,...out});
  }catch(e){
    res.status(502).json({ok:false,connected:angelStatus().connected,websocket:angelStatus().websocket,error:e?.message||"WebSocket reconnect failed"});
  }
});
app.post("/api/angel/login", async (req,res)=>{
  const started=Date.now();
  try {
    const {clientCode,pin,totp}=req.body||{};
    console.log(`[ANGEL_LOGIN] start client=${String(clientCode||process.env.ANGEL_CLIENT_CODE||"").slice(0,24)} pin=${pin?"present":"missing"} totp=${totp?"present":"missing"}`);
    const out=await Promise.race([
      loginAngel({clientCode,pin,totp}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error("Angel One login timed out after 15 seconds. Please retry.")),15000))
    ]);
    state.connected.market=true;
    console.log(`[ANGEL_LOGIN] success websocket=${!!out.websocket} wsError=${out.websocketError||"none"} ms=${Date.now()-started}`);
    res.json(out);
  } catch(e) {
    console.error(`[ANGEL_LOGIN] failed ms=${Date.now()-started}: ${e?.message||"Angel One login failed"}`);
    res.status(401).json({connected:false,error:e?.message||"Angel One login failed"});
  }
});
app.post("/api/angel/logout", async (req,res)=>{ try { res.json(await logoutAngel()); } catch(e){ res.status(500).json({error:e?.message||"Logout failed"}); } });
app.get("/api/angel/diagnostics", async (req,res)=>{
  const session=angelStatus();
  if(!session.connected) return res.status(401).json({ok:false,connected:false,error:"Angel One session is not connected",session});
  try{
    const symbol=String(req.query.symbol||"NIFTY").toUpperCase();
    const known={NIFTY:["Nifty 50","99926000"],BANKNIFTY:["Nifty Bank","99926009"],FINNIFTY:["Nifty Fin Service","99926037"],MIDCPNIFTY:["NIFTY MID SELECT","99926074"],VIX:["India VIX","99926017"]};
    const [tradingsymbol,symboltoken]=known[symbol]||known.NIFTY;
    const out=await angelLtp({exchange:"NSE",tradingsymbol,symboltoken});
    const d=out?.data||out;
    const latest=angelStatus();
    return res.json({ok:true,connected:true,websocket:latest.websocket,websocketError:latest.websocketError||null,symbol:tradingsymbol,token:symboltoken,data:d});
  }catch(e){
    const s=angelStatus();
    return res.status(502).json({ok:false,connected:s.connected,websocket:s.websocket,websocketError:s.websocketError||null,error:e?.message||"Angel One live quote test failed",session:s});
  }
});

app.get("/api/angel/ltp", async (req,res)=>{
  try{
    const {exchange='NSE',tradingsymbol='Nifty 50',symboltoken='99926000'}=req.query||{};
    res.json({ok:true,data:await angelLtp({exchange:String(exchange),tradingsymbol:String(tradingsymbol),symboltoken:String(symboltoken)})});
  }catch(e){res.status(401).json({ok:false,error:e?.message||"LTP failed"});}
});
app.post("/api/angel/ltp", async (req,res)=>{ try { res.json({ok:true,data:await angelLtp(req.body||{})}); } catch(e){ res.status(401).json({ok:false,error:e?.message||"LTP failed"}); } });
app.post("/api/angel/quote", async (req,res)=>{ try { res.json({ok:true,data:await angelQuote(req.body?.mode||"FULL", req.body?.exchangeTokens||{})}); } catch(e){ res.status(401).json({ok:false,error:e?.message||"Quote failed"}); } });
app.post("/api/angel/candles", async (req,res)=>{ try { res.json({ok:true,data:await angelCandles(req.body||{})}); } catch(e){ res.status(401).json({ok:false,error:e?.message||"Candle request failed"}); } });
app.post("/api/angel/search", async (req,res)=>{ try { res.json({ok:true,data:await angelSearchScrip(req.body||{})}); } catch(e){ res.status(401).json({ok:false,error:e?.message||"Search failed"}); } });
app.get("/api/angel/master", async (req,res)=>{ try { const items=await loadMaster(req.query.force==="1"); res.json({ok:true,count:items.length,loadedAt:new Date().toISOString()}); } catch(e){ res.status(502).json({ok:false,error:e?.message||"Instrument master unavailable"}); } });
app.get("/api/angel/expiries", async (req,res)=>{
  try{
    const exchange=(req.query.exchange||"NSE").toUpperCase();
    const segment=(req.query.segment||"OPTIDX").toUpperCase();
    const underlying=String(req.query.underlying||"").trim().toUpperCase();
    const items=await loadMaster();
    const q=underlying;
    const optionLike=segment==='OPTIDX'||segment==='OPTSTK';
    const normalizeSeg=(x)=>{const s=String(x||'').toLowerCase(); if(s==='nse_fo'||s==='nfo') return 'nse_fo'; if(s==='bse_fo'||s==='bfo') return 'bse_fo'; if(s==='nse_cm'||s==='nse') return 'nse_cm'; if(s==='bse_cm'||s==='bse') return 'bse_cm'; return s;};
    const target=exchange==='BSE'?'bse_fo':'nse_fo';
    const dates=[...new Set(items.filter(x=>{
      const sym=String(x.symbol||'').toUpperCase(), name=String(x.name||'').toUpperCase();
      const seg=normalizeSeg(x.exch_seg||x.exchange);
      const segOk=seg===target || (optionLike && (/(CE|PE)$/.test(sym)) && exchange==='NSE');
      if(!segOk) return false;
      if(optionLike && !/(CE|PE)$/.test(sym)) return false;
      return !q || name===q || name.startsWith(q) || sym.startsWith(q) || sym.replace(/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX)/,'').includes(q);
    }).map(x=>String(x.expiry||'').trim().toUpperCase()).filter(Boolean))].sort((a,b)=>{
      const pa=String(a).match(/^(\\d{1,2})([A-Z]{3})(\\d{4})$/), pb=String(b).match(/^(\\d{1,2})([A-Z]{3})(\\d{4})$/);
      if(pa&&pb){ const mo={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11}; return new Date(+pa[3],mo[pa[2]],+pa[1])-new Date(+pb[3],mo[pb[2]],+pb[1]); }
      return String(a).localeCompare(String(b));
    });
    res.json({ok:true,connected:angelStatus().connected,exchange,segment,underlying,expiries:dates.slice(0,24)});
  }catch(e){res.status(502).json({ok:false,error:e?.message||"Expiry lookup failed"});}
});
app.get("/api/angel/contracts", async (req,res)=>{
  try{
    if(!angelStatus().connected) return res.json({ok:true,connected:false,count:0,contracts:[],message:"Connect Angel One first."});
    const base=await findContracts(req.query);
    let rows=[];
    try{ rows=await quoteInstruments(base.slice(0,10)); }catch{}
    const qmap=new Map(rows.map(x=>[String(x.symbolToken),x]));
    const contracts=base.slice(0,50).map(x=>{
      const q=qmap.get(String(x.token))||{};
      return {contract:x.symbol, exchange:x.exchange, underlying:x.name, expiry:x.expiry, optionType:x.optionType, strike:x.strike, token:x.token, lotsize:x.lotsize,
        ltp:q.ltp??null, change:q.change??null, bid:q.bestFive?.buy?.[0]?.price??q.bestFive?.buy?.[0]?.Price??null, ask:q.bestFive?.sell?.[0]?.price??q.bestFive?.sell?.[0]?.Price??null,
        oi:q.opnInterest??null, doi:null, volume:q.tradeVolume??null, iv:null};
    });
    res.json({ok:true,connected:true,count:contracts.length,contracts});
  }catch(e){res.status(502).json({ok:false,error:e?.message||"Contract search failed"});}
});
app.post("/api/angel/option-greeks", async (req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:"Angel One is not connected"});
    const {name,expirydate}=req.body||{}; if(!name||!expirydate) return res.status(400).json({ok:false,error:"name and expirydate are required"});
    res.json({ok:true,data:await optionGreeks({name,expirydate})});
  }catch(e){res.status(502).json({ok:false,error:e?.message||"Option Greeks unavailable"});}
});
app.get("/api/angel/ticks",(req,res)=>res.json({ok:true,connected:angelStatus().connected,ticks:getLatestTicks()}));
app.get("/api/angel/connection-test",async(req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,connected:false,error:"Angel One is not connected"});
    const items=await loadMaster();
    const target=String(req.query.symbol||"NIFTY").toUpperCase();
    const known={NIFTY:["Nifty 50","99926000"],BANKNIFTY:["Nifty Bank","99926009"],FINNIFTY:["Nifty Fin Service","99926037"],MIDCPNIFTY:["NIFTY MID SELECT","99926074"],VIX:["India VIX","99926017"]};
    let match=known[target]?{symbol:known[target][0],token:known[target][1],exchange:"NSE"}:null;
    if(!match){
      const aliases={NIFTY:["NIFTY","NIFTY 50"],BANKNIFTY:["BANKNIFTY","BANK NIFTY"],FINNIFTY:["FINNIFTY","NIFTY FIN SERVICE"],MIDCPNIFTY:["MIDCPNIFTY","NIFTY MID SELECT"],SENSEX:["SENSEX"],VIX:["INDIAVIX","INDIA VIX","VIX"]};
      const aliasesFor=aliases[target]||[target];
      match=items.find(x=>String(x.exch_seg).toLowerCase()==="nse_cm" && aliasesFor.some(a=>String(x.name||"").toUpperCase()===a || String(x.symbol||"").toUpperCase().includes(a)));
      if(match) match={symbol:match.symbol,token:match.token,exchange:"NSE"};
    }
    if(!match) return res.status(404).json({ok:false,connected:true,error:`${target} instrument not found in master`});
    const q=await angelLtp({exchange:"NSE",tradingsymbol:match.symbol,symboltoken:match.token});
    res.json({ok:true,connected:true,exchange:"NSE",symbol:match.symbol,token:String(match.token),data:q?.data||q});
  }catch(e){res.status(502).json({ok:false,connected:angelStatus().connected,error:e?.message||"Live feed test failed"});}
});
app.post("/api/angel/subscribe", async (req,res)=>{ try { const out=await angelSubscribe(req.body?.tokens||[], req.body?.exchangeType||2, req.body?.mode||1); res.json({ok:true,...out}); } catch(e){ res.status(401).json({ok:false,error:e?.message||"Subscription failed"}); } });
app.get("/api/angel/stream-test", async (req,res)=>{
  if(!angelStatus().connected) return res.status(401).json({ok:false,connected:false,streamVerified:false,error:"Angel One is not connected"});
  const started=Date.now();
  const beforeTick=Number(angelStatus().lastTickAt||0);
  let reconnectError=null;
  try{
    const st=angelStatus();
    if(!st.websocket){
      try{
        await Promise.race([
          angelReconnectWebSocket(),
          new Promise((_,reject)=>setTimeout(()=>reject(new Error("WebSocket reconnect timeout after 12 seconds")),12000))
        ]);
      }catch(e){ reconnectError=e?.message||"WebSocket reconnect failed"; }
    }
    const deadline=Date.now()+7000;
    while(Date.now()<deadline){
      const s=angelStatus();
      if(s.websocket && Number(s.lastTickAt||0)>beforeTick) break;
      await new Promise(r=>setTimeout(r,250));
    }
    const final=angelStatus();
    const ticks=getLatestTicks();
    const streamFresh=!!final.websocket && !!final.lastTickAt && (Date.now()-Number(final.lastTickAt))<=15000 && Number(final.lastTickAt)>beforeTick;
    res.json({
      ok:streamFresh,
      connected:true,
      streamVerified:streamFresh,
      websocket:!!final.websocket,
      tickCount:final.tickCount||0,
      lastTickAt:final.lastTickAt||null,
      websocketError:final.websocketError||reconnectError||null,
      sampleTicks:ticks.slice(0,3),
      checkedAt:nowISO(),
      elapsedMs:Date.now()-started
    });
  }catch(e){
    const s=angelStatus();
    res.status(502).json({ok:false,connected:s.connected,streamVerified:false,websocket:!!s.websocket,tickCount:s.tickCount||0,lastTickAt:s.lastTickAt||null,websocketError:s.websocketError||reconnectError||null,error:e?.message||"Stream verification failed"});
  }
});




// RISK ENGINE — daily loss budget, live lot sizing and option Greek guard.
app.get('/api/risk/status',(req,res)=>{
  const p=phase11ProtectionStatus(), configured=numEnv('MAX_RISK_RUPEES',1000);
  res.json({ok:true,riskBudgetRupees:configured,dailyLossCapRupees:p.dailyLossCap,dailyLoss:p.dailyLoss,dailyLossRemaining:p.dailyLossRemaining});
});
app.post('/api/risk/position-size',async(req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const symbol=String(req.body?.symbol||'NIFTY').toUpperCase(), expiry=String(req.body?.expiry||'').toUpperCase();
    const strike=Number(req.body?.strike), optionType=String(req.body?.optionType||'CE').toUpperCase();
    const riskBudget=Math.max(0,Number(req.body?.riskBudget??numEnv('MAX_RISK_RUPEES',1000))), underlyingStopPoints=Math.abs(Number(req.body?.underlyingStopPoints||0));
    if(!expiry||!Number.isFinite(strike)||!['CE','PE'].includes(optionType)) return res.status(400).json({ok:false,error:'symbol, expiry, strike and optionType are required'});
    const contracts=await findContracts({exchange:'NSE',segment:'OPTIDX',underlying:symbol,expiry,optionType});
    const c0=contracts.map(x=>({...x,_strike:Number(x.strike)/100})).find(x=>Math.abs(x._strike-strike)<0.01);
    if(!c0) return res.status(404).json({ok:false,error:'LIVE_OPTION_CONTRACT_NOT_FOUND'});
    const q=(await quoteInstruments([c0]))[0]||{}, entry=Number(q.ltp);
    if(!Number.isFinite(entry)||entry<=0) return res.status(502).json({ok:false,error:'LIVE_OPTION_LTP_UNAVAILABLE'});
    let greeks=[]; try{greeks=await liveOptionGreeks(symbol,expiry)}catch{}
    const g=greeks.find(x=>x.optionType===optionType&&Math.abs(x.strike-strike)<0.01)||null, delta=Math.abs(Number(g?.delta));
    const premiumStop=req.body?.optionStopLoss!=null?Number(req.body.optionStopLoss):(Number.isFinite(delta)&&delta>0&&underlyingStopPoints>0?Math.max(0.05,delta*underlyingStopPoints):null);
    if(!Number.isFinite(premiumStop)||premiumStop<=0) return res.status(400).json({ok:false,error:'Provide optionStopLoss or underlyingStopPoints so option risk can be calculated'});
    const stop=Math.max(0.01,entry-premiumStop), lotSize=Math.max(1,Number(c0.lotsize)||1), protection=phase11ProtectionStatus();
    const sized=positionSizeFromRisk({riskBudget,entry,sl:stop,lotSize,availableBudget:protection.dailyLossRemaining}), greekRisk=greekRiskWarning(g);
    res.json({ok:true,symbol,expiry,strike,optionType,contract:c0.symbol,token:String(c0.token),lotSize,entry,optionStopLoss:stop,premiumRiskPerUnit:Math.abs(entry-stop),delta:Number.isFinite(delta)?delta:null,theta:Number.isFinite(Number(g?.theta))?Number(g.theta):null,iv:Number.isFinite(Number(g?.iv))?Number(g.iv):null,greeks:g,greekRisk,sizing:sized,protection});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Risk sizing unavailable'});}
});
// PHASE 5 — controlled execution & server-side pre-trade risk gate.

app.get('/api/phase11/protection',(req,res)=>res.json({ok:true,phase:11,protection:phase11ProtectionStatus()}));
app.post('/api/phase11/reset',(req,res)=>res.json({ok:true,phase:11,protection:phase11ResetProtection()}));
app.post('/api/phase11/record-outcome',(req,res)=>{ phase11RecordOutcome(Number(req.body?.pnl||0)); res.json({ok:true,phase:11,protection:phase11ProtectionStatus()}); });
app.get('/api/phase11/signal-token',async(req,res)=>{
  const symbol=String(req.query.symbol||'NIFTY').toUpperCase();
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(!marketSession()) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED'});
    const [h1,m15,m5,ni,gd,ev,md]=await Promise.all([
      loadTfSummary(symbol,'ONE_HOUR',45),loadTfSummary(symbol,'FIFTEEN_MINUTE',30),loadTfSummary(symbol,'FIVE_MINUTE',15),news(symbol),globalData(),events(),market(symbol)
    ]);
    const ns=analyzeNews(ni),gs=analyzeGlobal(gd),es=analyzeEvents(ev); let opt={connected:false};
    try{ const od=await options(symbol); if(od) opt={connected:true,...od}; }catch{}
    const historical=backtestFiveMinute(m5.rows||[]);
    const vix=Number(md?.VIX?.ltp);
    const prediction=buildPrediction({h1:h1.summary,m15:m15.summary,m5:m5.summary,rows5:m5.rows,news:ns,global:gs,events:es,options:opt,marketOpen:true,backtest:historical,vix:Number.isFinite(vix)?vix:null,oi:opt});
    if(prediction.signalState!=='CONFIRMED') return res.status(409).json({ok:false,error:'SIGNAL_NOT_CONFIRMED',prediction});
    const payload={version:2,symbol,prediction:prediction.prediction,action:prediction.action,modelConfidence:prediction.modelConfidence,confirmationPct:prediction.confirmationPct,vix:prediction.vix,adx:prediction.adx,volumeRatio10d:prediction.volumeRatio10d,eventDayBlock:prediction.eventBlocked||prediction.noTradeReasons?.some(x=>String(x).includes('event')),theta:prediction.theta,delta:prediction.delta,rrGate:'1:2+',createdAt:Date.now(),expiresAt:Date.now()+60000};
    res.json({ok:true,phase:11,token:signedPayload(payload),snapshot:payload,prediction});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Phase 11 signal unavailable'});}
});

app.get('/api/execution/status',(req,res)=>res.json({ok:true,phase:5,status:executionStatus()}));
app.get('/api/execution/rms',async(req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const out=await angelRms(); res.json({ok:true,data:out?.data||out});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'RMS unavailable'});}
});
app.get('/api/execution/orders',async(req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const out=await angelOrderBook(); res.json({ok:true,data:out?.data||out});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Order book unavailable'});}
});

// PHASE 9 — Broker Account Center: funds, holdings, positions, trades, order modification and controlled exits.
app.get('/api/broker/account',async(req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const [rms,orders,positions,holdings,allHoldings,trades]=await Promise.allSettled([angelRms(),angelOrderBook(),angelPositions(),angelHoldings(),angelAllHoldings(),angelTradeBook()]);
    const unwrap=x=>x.status==='fulfilled'?(x.value?.data??x.value):null;
    res.json({ok:true,phase:9,
      rms:unwrap(rms),orders:unwrap(orders)||[],positions:unwrap(positions)||[],holdings:unwrap(holdings)||[],allHoldings:unwrap(allHoldings)||{},trades:unwrap(trades)||[],
      errors:{rms:rms.status==='rejected'?rms.reason?.message:null,orders:orders.status==='rejected'?orders.reason?.message:null,positions:positions.status==='rejected'?positions.reason?.message:null,holdings:holdings.status==='rejected'?holdings.reason?.message:null,allHoldings:allHoldings.status==='rejected'?allHoldings.reason?.message:null,trades:trades.status==='rejected'?trades.reason?.message:null},
      checkedAt:nowISO()});
  }catch(e){res.status(502).json({ok:false,phase:9,error:e?.message||'Broker account data unavailable'});}
});

app.post('/api/order/modify',async(req,res)=>{
  try{
    const gate=executionStatus(req.body?.exchange||'NSE');
    if(!gate.marketOpen) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED',exchange:gate.exchange});
    if(!gate.connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(gate.killSwitch) return res.status(423).json({ok:false,error:'TRADING_KILL_SWITCH_ON'});
    if(!gate.executionEnabled||!gate.staticIpVerified) return res.status(423).json({ok:false,error:'ORDER_EXECUTION_GATE_BLOCKED'});
    if(String(req.body?.confirmation||'').trim().toUpperCase()!=='MODIFY LIVE ORDER') return res.status(400).json({ok:false,error:'EXPLICIT_CONFIRMATION_REQUIRED'});
    const p=req.body||{}; const orderid=String(p.orderid||''); if(!orderid) return res.status(400).json({ok:false,error:'ORDER_ID_REQUIRED'});
    const instrument=await findInstrumentByToken(p.symboltoken); if(!instrument) return res.status(400).json({ok:false,error:'INVALID_INSTRUMENT'});
    const ordertype=String(p.ordertype||'LIMIT').toUpperCase();
    const quantity=Number(p.quantity); if(!Number.isInteger(quantity)||quantity<=0) return res.status(400).json({ok:false,error:'INVALID_QUANTITY'});
    const price=ordertype==='MARKET'?0:positiveNumber(p.price); if(ordertype!=='MARKET'&&!price) return res.status(400).json({ok:false,error:'PRICE_REQUIRED'});
    const payload={variety:String(p.variety||'NORMAL'),orderid,ordertype,producttype:String(p.producttype||'INTRADAY').toUpperCase(),duration:'DAY',price:String(price||0),quantity:String(quantity),tradingsymbol:String(instrument.symbol),symboltoken:String(instrument.token),exchange:String(p.exchange||executionStatus().exchange),ordertag:p.ordertag?String(p.ordertag):undefined};
    const out=await angelModifyOrder(payload); res.json({ok:true,data:out?.data||out,message:out?.message||'Modify request submitted.'});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Order modification failed'});}
});

app.post('/api/position/exit/preview',async(req,res)=>{
  try{
    const p=req.body||{}; if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const positions=await angelPositions(); const rows=Array.isArray(positions?.data)?positions.data:[];
    const token=String(p.symboltoken||''); const row=rows.find(x=>String(x.symboltoken||'')===token && Number(x.netqty??((Number(x.buyqty)||0)-(Number(x.sellqty)||0)))!==0);
    if(!row) return res.status(404).json({ok:false,error:'OPEN_POSITION_NOT_FOUND'});
    const netQty=Number(row.netqty??((Number(row.buyqty)||0)-(Number(row.sellqty)||0)));
    const side=netQty>0?'SELL':'BUY'; const qty=Math.abs(netQty);
    const instrument=await findInstrumentByToken(token); if(!instrument) return res.status(400).json({ok:false,error:'INVALID_INSTRUMENT'});
    const id=`PTD9-EXIT-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    execution.previews.set(id,{id,createdAt:Date.now(),expiresAt:Date.now()+60000,order:{variety:'NORMAL',tradingsymbol:String(instrument.symbol),symboltoken:String(instrument.token),transactiontype:side,exchange:String(row.exchange||executionStatus().exchange),ordertype:'MARKET',producttype:String(row.producttype||'INTRADAY').toUpperCase(),duration:'DAY',price:'0',squareoff:'0',stoploss:'0',quantity:String(qty),scripconsent:'yes'},maxLoss:null,allowedRisk:null,instrument:{symbol:instrument.symbol,token:String(instrument.token),exchange:row.exchange,lotSize:Number(instrument.lotsize||1)}});
    res.json({ok:true,previewId:id,expiresInSec:60,position:{symbol:row.tradingsymbol,netQty,avgPrice:row.avgnetprice||row.buyavgprice||row.sellavgprice||0,pnl:row.pnl||row.m2m||0},order:execution.previews.get(id).order,message:'Exit preview ready. No broker order has been placed.'});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Exit preview failed'});}
});

app.post('/api/position/exit/execute',async(req,res)=>{
  try{
    trimPreviewStore(); const id=String(req.body?.previewId||''); const pv=execution.previews.get(id);
    if(!pv) return res.status(404).json({ok:false,error:'EXIT_PREVIEW_NOT_FOUND_OR_EXPIRED'});
    const gate=executionStatus(pv.order.exchange||'NSE'); if(!gate.marketOpen) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED',exchange:gate.exchange});
    if(!gate.connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(gate.killSwitch && !boolEnv('ALLOW_EXIT_WHEN_KILL_SWITCH',true)) return res.status(423).json({ok:false,error:'TRADING_KILL_SWITCH_ON'});
    if(!gate.executionEnabled||!gate.staticIpVerified) return res.status(423).json({ok:false,error:'ORDER_EXECUTION_GATE_BLOCKED'});
    if(String(req.body?.confirmation||'').trim().toUpperCase()!=='EXIT LIVE POSITION') return res.status(400).json({ok:false,error:'EXPLICIT_CONFIRMATION_REQUIRED'});
    const current=await angelPositions(); const rows=Array.isArray(current?.data)?current.data:[]; const row=rows.find(x=>String(x.symboltoken||'')===String(pv.order.symboltoken));
    if(!row) return res.status(409).json({ok:false,error:'POSITION_CHANGED_OR_CLOSED'}); const netQty=Number(row.netqty??((Number(row.buyqty)||0)-(Number(row.sellqty)||0)));
    if(!netQty) return res.status(409).json({ok:false,error:'POSITION_ALREADY_FLAT'}); pv.order.transactiontype=netQty>0?'SELL':'BUY'; pv.order.quantity=String(Math.abs(netQty));
    const out=await angelPlaceOrder(pv.order); const orderId=out?.data?.orderid||out?.data?.order_id||null; if(orderId) execution.recentOrderIds.add(String(orderId)); execution.previews.delete(id);
    res.json({ok:!!out?.status,placed:true,broker:out,message:out?.message||'Exit order request submitted.'});
  }catch(e){res.status(502).json({ok:false,placed:false,error:e?.message||'Exit execution failed'});}
});
app.post('/api/order/preview',async(req,res)=>{
  try{
    trimPreviewStore();
    const exchangeHint=String(req.body?.exchange||'NSE').toUpperCase();
    const gate=executionStatus(exchangeHint);
    if(!gate.marketOpen) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED',exchange:exchangeHint});
    if(!gate.connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(gate.killSwitch) return res.status(423).json({ok:false,error:'TRADING_KILL_SWITCH_ON'});
    if(!gate.executionEnabled) return res.status(423).json({ok:false,error:'ORDER_EXECUTION_DISABLED'});
    if(!gate.staticIpVerified) return res.status(423).json({ok:false,error:'STATIC_IP_NOT_VERIFIED'});
    const p=req.body||{};
    const instrument=await findInstrumentByToken(p.symboltoken||p.token);
    const v=validateOrderInput(p,instrument);
    if(v.errors.length) return res.status(400).json({ok:false,error:'ORDER_VALIDATION_FAILED',errors:v.errors});
    let openPositions=0;
    try{ const pr=await angelPositions(); const rows=Array.isArray(pr?.data)?pr.data:[]; openPositions=rows.filter(x=>Number(x.netqty??((Number(x.buyqty)||0)-(Number(x.sellqty)||0)))!==0).length; }catch{ if(!boolEnv('ALLOW_UNKNOWN_POSITION_STATE',false)) return res.status(503).json({ok:false,error:'POSITION_STATE_UNAVAILABLE'}); }
    const signalToken=String(p.signalToken||''); const signalSnapshot=signalToken?verifySignedPayload(signalToken):null;
    if(phase11ProtectionStatus().requireSignalToken && isOptionSymbol(instrument.symbol) && !signalSnapshot) return res.status(423).json({ok:false,error:'PHASE11_SIGNED_SIGNAL_REQUIRED'});
    if(signalSnapshot && String(signalSnapshot.symbol).toUpperCase()!==extractUnderlyingFromSymbol(instrument.symbol)) return res.status(409).json({ok:false,error:'SIGNAL_SYMBOL_MISMATCH'});
    if(signalSnapshot && !signalMatchesContract(signalSnapshot,instrument,v.side)) return res.status(409).json({ok:false,error:'SIGNAL_DIRECTION_MISMATCH'});
    const capital=positiveNumber(p.capital), riskPct=positiveNumber(p.riskPct);
    if(!capital||!riskPct) return res.status(400).json({ok:false,error:'CAPITAL_AND_RISK_REQUIRED'});
    const protection=phase11PolicyForOrder({p,instrument,signalSnapshot,openPositions});
    if(!protection.ok && v.side==='BUY') return res.status(423).json({ok:false,error:'PHASE11_CAPITAL_SHIELD_BLOCKED',errors:protection.errors,protection:protection.status});
    const maxLoss=Math.abs((v.price||positiveNumber(p.entry)||0)-v.sl)*v.qty;
    const allowedRisk=capital*riskPct/100;
    if(!Number.isFinite(maxLoss)||maxLoss<=0) return res.status(400).json({ok:false,error:'RISK_CANNOT_BE_COMPUTED'});
    if(maxLoss>allowedRisk) return res.status(400).json({ok:false,error:'RISK_LIMIT_EXCEEDED',maxLoss,allowedRisk});
    if(gate.maxRiskRupees!=null && maxLoss>gate.maxRiskRupees) return res.status(400).json({ok:false,error:'SERVER_RISK_LIMIT_EXCEEDED',maxLoss,serverLimit:gate.maxRiskRupees});
    const order=buildOrderPayload(p,instrument);
    const id=`PTD5-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    execution.previews.set(id,{id,createdAt:Date.now(),expiresAt:Date.now()+60000,order,maxLoss,allowedRisk,phase11:{signalSnapshot,protection:phase11ProtectionStatus(),riskMeta:{sl:Number(p.stopLoss||0),target1:Number(p.target1||0),side:v.side},rr:modelSafe((Number(p.target1||0)-Number(p.price||0))/(Number(p.price||0)-Number(p.stopLoss||0)))},instrument:{symbol:instrument.symbol,token:String(instrument.token),exchange:order.exchange,lotSize:v.lot},sourceIPVerified:gate.staticIpVerified});
    res.json({ok:true,previewId:id,expiresInSec:60,order,maxLoss:Number(maxLoss.toFixed(2)),allowedRisk:Number(allowedRisk.toFixed(2)),instrument:{symbol:instrument.symbol,token:String(instrument.token),exchange:order.exchange,lotSize:v.lot},message:'Preview ready. No broker order has been placed.'});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Order preview failed'});}
});
app.post('/api/order/execute',async(req,res)=>{
  try{
    trimPreviewStore();
    const previewPeek=execution.previews.get(String(req.body?.previewId||''));
    const gate=executionStatus(previewPeek?.order?.exchange||'NSE');
    if(!gate.marketOpen) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED',exchange:gate.exchange});
    if(!gate.connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(gate.killSwitch) return res.status(423).json({ok:false,error:'TRADING_KILL_SWITCH_ON'});
    if(!gate.executionEnabled) return res.status(423).json({ok:false,error:'ORDER_EXECUTION_DISABLED'});
    if(!gate.staticIpVerified) return res.status(423).json({ok:false,error:'STATIC_IP_NOT_VERIFIED'});
    if(String(req.body?.confirmation||'').trim().toUpperCase()!=='PLACE LIVE ORDER') return res.status(400).json({ok:false,error:'EXPLICIT_CONFIRMATION_REQUIRED'});
    const id=String(req.body?.previewId||''); const pv=execution.previews.get(id);
    if(!pv) return res.status(404).json({ok:false,error:'PREVIEW_NOT_FOUND_OR_EXPIRED'});
    const fresh=await findInstrumentByToken(pv.order.symboltoken);
    if(!fresh || String(fresh.symbol)!==String(pv.order.tradingsymbol)) return res.status(409).json({ok:false,error:'INSTRUMENT_CHANGED'});
    if(pv.order.transactiontype==='BUY' && isOptionSymbol(fresh.symbol)){
      const snap=pv.phase11?.signalSnapshot||null;
      if(phase11ProtectionStatus().requireSignalToken && !snap) return res.status(423).json({ok:false,error:'PHASE11_SIGNED_SIGNAL_REQUIRED'});
      const guard=phase11PolicyForOrder({p:{...pv.order,stopLoss:pv.phase11?.riskMeta?.sl||0,target1:pv.phase11?.riskMeta?.target1||0},instrument:fresh,signalSnapshot:snap,openPositions:0});
      if(!guard.ok) return res.status(423).json({ok:false,error:'PHASE11_FINAL_GUARD_BLOCKED',errors:guard.errors,protection:guard.status});
    }
    const out=await angelPlaceOrder(pv.order);
    const orderId=out?.data?.orderid||out?.data?.order_id||null;
    if(orderId) execution.recentOrderIds.add(String(orderId));
    phase11OnOrderSubmitted(pv.maxLoss||0);
    execution.previews.delete(id);
    res.json({ok:!!out?.status,placed:true,broker:out,protection:phase11ProtectionStatus(),message:out?.message||'Order request submitted. Broker fill status may update separately.'});
  }catch(e){res.status(502).json({ok:false,placed:false,error:e?.message||'Order execution failed'});}
});
app.post('/api/order/cancel',async(req,res)=>{
  try{
    const gate=executionStatus(req.body?.exchange||'NSE');
    if(!gate.marketOpen) return res.status(409).json({ok:false,error:'EXCHANGE_CLOSED',exchange:gate.exchange});
    if(!gate.connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    if(gate.killSwitch && !boolEnv('ALLOW_CANCEL_WHEN_KILL_SWITCH',true)) return res.status(423).json({ok:false,error:'TRADING_KILL_SWITCH_ON'});
    if(!gate.executionEnabled || !gate.staticIpVerified) return res.status(423).json({ok:false,error:'ORDER_EXECUTION_GATE_BLOCKED'});
    const orderid=String(req.body?.orderid||''); if(!orderid) return res.status(400).json({ok:false,error:'ORDER_ID_REQUIRED'});
    const out=await angelCancelOrder(orderid); res.json({ok:true,data:out?.data||out,message:out?.message||'Cancel request submitted.'});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Cancel request failed'});}
});

// PHASE 6 — live position/order monitoring and alert feed.
const phase6State = { lastOrders: new Map(), lastMonitorAt: 0 };
function normalizeOrderEvents(rows){
  const arr=Array.isArray(rows)?rows:[];
  return arr.map(o=>({
    orderId:String(o.orderid||o.orderId||''), symbol:String(o.tradingsymbol||''), exchange:String(o.exchange||''),
    side:String(o.transactiontype||''), status:String(o.orderstatus||o.status||''), price:Number(o.averageprice||o.price||0)||0,
    qty:Number(o.quantity||0)||0, filled:Number(o.filledshares||0)||0, unfilled:Number(o.unfilledshares||0)||0,
    trigger:Number(o.triggerprice||0)||0, stoploss:Number(o.stoploss||0)||0, ltp:Number(o.ltp||0)||0,
    updated:o.updatetime||o.exchorderupdatetime||o.exchtime||null, text:String(o.text||'')
  }));
}
app.get('/api/phase6/status', async (req,res)=>{
  try{
    const connected=angelStatus().connected;
    if(!connected) return res.json({ok:true,phase:6,connected:false,orders:[],events:[],monitoring:'LOCKED',message:'Connect Angel One first.'});
    const out=await angelOrderBook();
    const orders=normalizeOrderEvents(out?.data||out);
    const events=[];
    for(const o of orders){
      const prev=phase6State.lastOrders.get(o.orderId);
      if(prev && prev.status!==o.status){ events.push({type:'ORDER_STATUS',orderId:o.orderId,symbol:o.symbol,from:prev.status,to:o.status,text:o.text}); }
      phase6State.lastOrders.set(o.orderId,o);
    }
    phase6State.lastMonitorAt=Date.now();
    res.json({ok:true,phase:6,connected:true,monitoring:'LIVE',orders,events,checkedAt:nowISO()});
  }catch(e){res.status(502).json({ok:false,phase:6,connected:angelStatus().connected,orders:[],events:[],monitoring:'ERROR',error:e?.message||'Phase 6 monitor unavailable'});}
});
app.get('/api/phase6/order-events', async (req,res)=>{
  try{
    if(!angelStatus().connected) return res.status(401).json({ok:false,error:'ANGEL_NOT_CONNECTED'});
    const out=await angelOrderBook();
    const orders=normalizeOrderEvents(out?.data||out);
    const events=[];
    for(const o of orders){
      const prev=phase6State.lastOrders.get(o.orderId);
      if(prev && prev.status!==o.status) events.push({type:'ORDER_STATUS',orderId:o.orderId,symbol:o.symbol,from:prev.status,to:o.status,text:o.text});
      phase6State.lastOrders.set(o.orderId,o);
    }
    res.json({ok:true,events,orders,checkedAt:nowISO()});
  }catch(e){res.status(502).json({ok:false,error:e?.message||'Order events unavailable'});}
});

app.get("/api/health",(req,res)=>res.json({ok:true,service:"PARTHAVI TRADE DESK PRO",phase:12,demo:DEMO,time:nowISO(),pid:process.pid,uptimeSec:Math.round(process.uptime())}));
app.get("/api/phase12/readiness",(req,res)=>{
  const exchange=String(req.query.exchange||"NSE").toUpperCase()==="BSE"?"BSE":"NSE";
  const gate=executionStatus(exchange);
  const result=productionReadiness({angelConnected:angelStatus().connected,marketOpen:gate.marketOpen,exchange});
  res.status(result.liveReady?200:423).json({ok:true,...result});
});

app.get("/api/status",(req,res)=>{
  res.json({open:marketSession(),asof:nowISO(),timezone:"Asia/Kolkata",session:"NSE normal derivatives"});
});

app.get("/api/market",async(req,res)=>{
  const data=await market(req.query.symbol||"NIFTY");
  if(data===null){state.connected.market=false;return res.json({connected:false,data:{}});}
  state.connected.market=true;state.last.market=Date.now();res.json({connected:true,data});
});
app.get("/api/options",async(req,res)=>{
  const data=await options(req.query.symbol||"NIFTY");
  if(data===null){state.connected.options=false;return res.json({connected:false,data:{}});}
  state.connected.options=true;state.last.options=Date.now();res.json({connected:true,data});
});
app.get("/api/news",async(req,res)=>{
  try{ const items=await news(req.query.symbol||"NIFTY"); const strategy=analyzeNews(items); state.connected.news=strategy.connected; if(strategy.connected) state.last.news=Date.now(); res.json({connected:strategy.connected,items,strategy}); }
  catch(e){ state.connected.news=false; res.json({connected:false,items:[],strategy:analyzeNews([]),error:e?.message||"News provider unavailable"}); }
});
app.get("/api/global",async(req,res)=>{
  try{
    const data=await globalData();
    const strategy=analyzeGlobal(data);
    state.connected.global=strategy.connected;
    if(strategy.connected) state.last.global=Date.now();
    res.json({connected:strategy.connected,data,strategy,checkedAt:nowISO()});
  }catch(e){
    state.connected.global=false;
    res.json({connected:false,data:{},strategy:analyzeGlobal({}),checkedAt:nowISO(),error:e?.message||"Global provider unavailable"});
  }
});
app.get("/api/events",async(req,res)=>{ try{ const raw=await events(); const strategy=analyzeEvents(raw); res.json({connected:strategy.connected,items:strategy.events,strategy}); }catch(e){res.json({connected:false,items:[],strategy:analyzeEvents([]),error:e?.message||"Event provider unavailable"});} });
app.get("/api/fusion",async(req,res)=>{
  try{
    const symbol=String(req.query.symbol||"NIFTY").toUpperCase();
    const [ni,gd,ev]=await Promise.all([news(symbol),globalData(),events()]);
    const ns=analyzeNews(ni), gs=analyzeGlobal(gd), es=analyzeEvents(ev);
    const out=fuse({technicalScore:0,newsScore:ns.score,globalScore:gs.score,eventRisk:es.hardBlock,marketOpen:marketSession(),feeds:{market:angelStatus().connected,options:false,news:ns.connected,global:gs.connected}});
    res.json({ok:true,news:ns,global:gs,events:es,fusion:out});
  }catch(e){res.status(502).json({ok:false,error:e?.message||"Fusion unavailable"});}
});


// Contract Finder API (live-ready scaffold). Values stay empty until the secure broker/exchange adapter is connected.
app.get("/api/instruments", async (req,res)=>{
  const exchange=(req.query.exchange||"NSE").toUpperCase();
  const segment=(req.query.segment||"OPTIDX").toUpperCase();
  const query=String(req.query.query||"").trim().toUpperCase();
  // Production adapter should search the broker/exchange instrument master server-side.
  const demoIndex=["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX"];
  const names=demoIndex.filter(x=>!query||x.includes(query));
  res.json({connected:false,exchange,segment,query,instruments:names.map(symbol=>({symbol,exchange,segment,status:"CONNECT FEED"}))});
});
app.get("/api/expiries", async (req,res)=>{
  res.json({connected:false,exchange:(req.query.exchange||"NSE").toUpperCase(),underlying:String(req.query.underlying||"").toUpperCase(),expiries:[],message:"Live expiry list will load from the connected instrument master."});
});
app.get("/api/contracts", async (req,res)=>{
  try{
    const r=await fetch(`http://127.0.0.1:${PORT}/api/angel/contracts?${new URLSearchParams(req.query)}`);
    const d=await r.json(); res.status(r.status).json(d);
  }catch(e){res.status(502).json({connected:false,error:"Backend contract bridge unavailable"});}
});
app.get("/api/contract/analyze", async (req,res)=>{
  try{
    if(!angelStatus().connected) return res.json({connected:false,decision:{action:"NO TRADE",reason:"Connect Angel One before analysing a live contract."}});
    const q=new URLSearchParams({exchange:req.query.exchange||"NSE",segment:req.query.segment||"OPTIDX",underlying:req.query.underlying||"",expiry:req.query.expiry||"",optionType:req.query.optionType||"",strike:req.query.strike||""});
    const cr=await fetch(`http://127.0.0.1:${PORT}/api/angel/contracts?${q}`); const cd=await cr.json();
    const contract=(cd.contracts||[])[0]||null;
    if(!contract) return res.status(404).json({connected:true,decision:{action:"NO TRADE",reason:"Contract not found in the connected instrument master."}});
    let greeks=null;
    if(String(contract.exchange||'').toUpperCase()==='NSE' && contract.expiry && contract.underlying){
      try{
        const gr=await optionGreeks({name:contract.underlying,expirydate:contract.expiry});
        greeks=(Array.isArray(gr)?gr:[]).find(x=>String(x.optionType||'').toUpperCase()===String(contract.optionType||'').toUpperCase() && Math.abs(Number(x.strikePrice)-Number(contract.strike||0))<0.01)||null;
      }catch{}
    }
    res.json({connected:true,contract,greeks,decision:{action:"NO TRADE",reason:"Live contract loaded. Direction/entry/SL/targets remain locked until the multi-timeframe fusion engine validates fresh candles, options positioning, news, global risk and event risk."}});
  }catch(e){res.status(502).json({connected:false,error:e?.message||"Contract analysis failed"});}
});

function sma(vals, n){ if(vals.length<n) return null; const a=vals.slice(-n); return a.reduce((x,y)=>x+y,0)/n; }
function emaSeries(vals,n){ if(vals.length<n) return []; const k=2/(n+1); let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n; const out=new Array(n-1).fill(null); out.push(e); for(let i=n;i<vals.length;i++){ e=vals[i]*k+e*(1-k); out.push(e); } return out; }
function rsiSeries(vals,n=14){ if(vals.length<=n) return []; let gains=0,losses=0; for(let i=1;i<=n;i++){const d=vals[i]-vals[i-1]; if(d>=0) gains+=d; else losses-=d;} let ag=gains/n, al=losses/n; const out=new Array(n).fill(null); out.push(al===0?100:100-100/(1+ag/al)); for(let i=n+1;i<vals.length;i++){const d=vals[i]-vals[i-1],g=Math.max(d,0),l=Math.max(-d,0); ag=(ag*(n-1)+g)/n; al=(al*(n-1)+l)/n; out.push(al===0?100:100-100/(1+ag/al));} return out; }
function atrSeries(rows,n=14){ if(rows.length<=n) return []; const tr=[]; for(let i=0;i<rows.length;i++){const prev=i?rows[i-1].c:rows[i].c; tr.push(Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-prev),Math.abs(rows[i].l-prev)));} let a=tr.slice(0,n).reduce((x,y)=>x+y,0)/n; const out=new Array(n-1).fill(null); out.push(a); for(let i=n;i<tr.length;i++){a=(a*(n-1)+tr[i])/n;out.push(a);} return out; }
function macd(vals){const e12=emaSeries(vals,12),e26=emaSeries(vals,26); const m=vals.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null); const clean=m.filter(x=>x!=null); const sigClean=emaSeries(clean,9); const signal=new Array(m.length-clean.length).fill(null).concat(sigClean); const hist=m.map((x,i)=>x!=null&&signal[i]!=null?x-signal[i]:null); return {macd:m.at(-1),signal:signal.at(-1),hist:hist.at(-1)}; }
function adx(rows,n=14){ if(rows.length<2*n+1) return null; const tr=[],plus=[],minus=[]; for(let i=1;i<rows.length;i++){const up=rows[i].h-rows[i-1].h,down=rows[i-1].l-rows[i].l;tr.push(Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-rows[i-1].c),Math.abs(rows[i].l-rows[i-1].c)));plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);} let atr=tr.slice(0,n).reduce((a,b)=>a+b,0)/n,p=plus.slice(0,n).reduce((a,b)=>a+b,0)/n,m=minus.slice(0,n).reduce((a,b)=>a+b,0)/n; const dx=[]; for(let i=n;i<tr.length;i++){if(i>n){atr=(atr*(n-1)+tr[i])/n;p=(p*(n-1)+plus[i])/n;m=(m*(n-1)+minus[i])/n;} const diP=100*p/(atr||1),diM=100*m/(atr||1);dx.push(100*Math.abs(diP-diM)/(diP+diM||1));} return dx.length>=n?sma(dx.slice(-n),n):sma(dx,dx.length); }
function vwap(rows){let pv=0,v=0; for(const r of rows){const vol=Number(r.v||0);pv+=((r.h+r.l+r.c)/3)*vol;v+=vol;} return v?pv/v:null; }
function candleSignal(rows){const a=rows.at(-1),b=rows.at(-2); if(!a||!b)return 'WAIT'; const body=Math.abs(a.c-a.o),range=Math.max(a.h-a.l,1e-9),upper=a.h-Math.max(a.o,a.c),lower=Math.min(a.o,a.c)-a.l; if(a.c>b.h&&a.o<b.c) return 'BULLISH ENGULFING'; if(a.c<b.l&&a.o>b.c) return 'BEARISH ENGULFING'; if(lower>body*2&&upper<body) return 'HAMMER'; if(upper>body*2&&lower<body) return 'SHOOTING STAR'; if(body/range<0.12) return 'DOJI'; return a.c>a.o?'BULLISH CANDLE':'BEARISH CANDLE'; }
function summarize(rows){
 const c=rows.map(x=>x.c), e20=emaSeries(c,20).at(-1),e50=emaSeries(c,50).at(-1),e200=emaSeries(c,200).at(-1),r=rsiSeries(c,14).at(-1),m=macd(c),a=adx(rows,14),at=atrSeries(rows,14).at(-1),vw=vwap(rows),cs=candleSignal(rows),last=rows.at(-1)?.c;
 const trend=last!=null&&e20!=null&&e50!=null?(e20>e50?'BULLISH':'BEARISH'):'WAIT';
 return {last,ema20:e20,ema50:e50,ema200:e200,rsi:r,macd:m,adx:a,atr:at,vwap:vw,candle:cs,trend};
}
async function resolveIndexToken(symbol){
 const s=String(symbol||'NIFTY').toUpperCase();
 const known={NIFTY:['99926000','Nifty 50'],BANKNIFTY:['99926009','Nifty Bank'],FINNIFTY:['99926037','Nifty Fin Service'],MIDCPNIFTY:['99926074','NIFTY MID SELECT'],VIX:['99926017','India VIX']};
 if(known[s]) return {token:known[s][0],symbol:known[s][1],exchange:'NSE'};
 const items=await loadMaster();
 const aliases={NIFTY:['NIFTY','NIFTY 50'],BANKNIFTY:['BANKNIFTY','BANK NIFTY'],FINNIFTY:['FINNIFTY','NIFTY FIN SERVICE'],MIDCPNIFTY:['MIDCPNIFTY','NIFTY MID SELECT'],SENSEX:['SENSEX'],VIX:['INDIAVIX','INDIA VIX','VIX']};
 const arr=aliases[s]||[s];
 let x=items.find(z=>arr.includes(String(z.name||'').toUpperCase())&&(String(z.exch_seg||'').toLowerCase()==='nse_cm'||String(z.exch_seg||'').toUpperCase()==='NSE'));
 if(!x) x=items.find(z=>arr.includes(String(z.symbol||'').toUpperCase())&&(String(z.exch_seg||'').toLowerCase()==='nse_cm'||String(z.exch_seg||'').toUpperCase()==='NSE'));
 if(!x) throw new Error('Index instrument not found');
 return {token:String(x.token),symbol:x.symbol,exchange:String(x.exch_seg||'NSE').toUpperCase()};
}
const candleCache=new Map();
const candleInflight=new Map();
function candleRows(raw){
  return (raw?.data||[]).map(x=>({t:x[0],o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5]||0)}))
    .filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
}
function bucketStart(ts, minutes){ return Math.floor(new Date(ts).getTime()/(minutes*60000))*minutes*60000; }
function aggregateCandles(rows, minutes){
  if(!Array.isArray(rows)||!rows.length) return [];
  const out=[]; let cur=null, key=null;
  for(const r of rows){
    const k=bucketStart(r.t,minutes);
    if(k!==key){
      if(cur) out.push(cur);
      key=k;
      cur={t:new Date(k).toISOString(),o:r.o,h:r.h,l:r.l,c:r.c,v:r.v||0};
    }else{
      cur.h=Math.max(cur.h,r.h); cur.l=Math.min(cur.l,r.l); cur.c=r.c; cur.v+=r.v||0;
    }
  }
  if(cur) out.push(cur);
  return out;
}
function dropIncompleteCandle(rows, minutes){
  if(!Array.isArray(rows)||!rows.length) return [];
  const boundary=bucketStart(new Date(),minutes);
  return rows.filter(r=>Date.parse(r.t)<boundary);
}
function yahooTicker(symbol){
  const map={NIFTY:'^NSEI',BANKNIFTY:'^NSEBANK',FINNIFTY:'NIFTY_FIN_SERVICE.NS',MIDCPNIFTY:'NIFTY_MID_SELECT.NS',VIX:'^INDIAVIX',SENSEX:'^BSESN'};
  return map[String(symbol||'NIFTY').toUpperCase()]||'^NSEI';
}
async function loadYahoo5m(symbol){
  const ticker=encodeURIComponent(yahooTicker(symbol));
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=5d`;
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'PARTHAVI-TRADE-DESK-PRO/1.0'},signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error(`Yahoo candle HTTP ${r.status}`);
  const j=await r.json();
  const result=j?.chart?.result?.[0], ts=result?.timestamp||[], q=result?.indicators?.quote?.[0]||{};
  const rows=ts.map((t,i)=>({t:new Date(Number(t)*1000).toISOString(),o:Number(q.open?.[i]),h:Number(q.high?.[i]),l:Number(q.low?.[i]),c:Number(q.close?.[i]),v:Number(q.volume?.[i]||0)}))
    .filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
  if(!rows.length) throw new Error('Yahoo returned no usable 5M candles');
  return rows;
}
async function loadBase5m(symbol){
  const key=String(symbol||'NIFTY').toUpperCase(), now=Date.now(), cached=candleCache.get(key);
  if(cached && now-cached.at<15000) return cached.rows;
  if(candleInflight.has(key)) return await candleInflight.get(key);
  const job=(async()=>{
    const ins=await resolveIndexToken(key), end=new Date(), from=new Date(end.getTime()-7*86400000);
    const f=x=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
      .format(new Date(x)).replace(', ',' ').replace(/\\//g,'-');
    try{
      const raw=await angelCandles({exchange:'NSE',symboltoken:ins.token,interval:'FIVE_MINUTE',fromdate:f(from),todate:f(end)});
      const rows=candleRows(raw);
      if(rows.length){ candleCache.set(key,{at:Date.now(),rows,source:'ANGEL'}); return rows; }
    }catch{}
    const fallback=await loadYahoo5m(key);
    candleCache.set(key,{at:Date.now(),rows:fallback,source:'YAHOO_FALLBACK'});
    return fallback;
  })();
  candleInflight.set(key,job);
  try{return await job;}finally{candleInflight.delete(key);}
}
async function loadTfSummary(symbol, interval, days){
  const ins=await resolveIndexToken(symbol); let rows=[];
  if(interval==='FIVE_MINUTE') rows=dropIncompleteCandle(await loadBase5m(symbol),5);
  else if(interval==='FIFTEEN_MINUTE') rows=dropIncompleteCandle(aggregateCandles(await loadBase5m(symbol),15),15);
  else if(interval==='ONE_HOUR') rows=dropIncompleteCandle(aggregateCandles(await loadBase5m(symbol),60),60);
  else {
    const end=new Date(), from=new Date(end.getTime()-Math.min(days||1,1)*86400000);
    const f=x=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
      .format(new Date(x)).replace(', ',' ').replace(/\\//g,'-');
    rows=candleRows(await angelCandles({exchange:'NSE',symboltoken:ins.token,interval,fromdate:f(from),todate:f(end)}));
    if(interval!=='ONE_DAY') rows=dropIncompleteCandle(rows,5);
  }
  const wanted=interval==='ONE_HOUR'?Math.max(30,Math.ceil((days||10)*5))
    :interval==='FIFTEEN_MINUTE'?Math.max(20,Math.ceil((days||10)*26))
    :Math.max(60,Math.ceil((days||10)*75));
  const trimmed=rows.slice(-wanted);
  return {ins,rows:trimmed,summary:summarize(trimmed),closed:true};
}

// PHASE 10 — advanced prediction, confirmation and transparent historical target-hit analysis.
app.get('/api/phase10/prediction',async(req,res)=>{
  const symbol=String(req.query.symbol||'NIFTY').toUpperCase();
  try{
    if(!angelStatus().connected) return res.json({ok:true,phase:10,locked:true,prediction:buildPrediction({marketOpen:false}),message:'Connect Angel One before running live prediction.'});
    const [h1,m15,m5,ni,gd,ev,md]=await Promise.all([
      loadTfSummary(symbol,'ONE_HOUR',45),
      loadTfSummary(symbol,'FIFTEEN_MINUTE',30),
      loadTfSummary(symbol,'FIVE_MINUTE',15),
      news(symbol),globalData(),events(),market(symbol)
    ]);
    const ns=analyzeNews(ni), gs=analyzeGlobal(gd), es=analyzeEvents(ev);
    let opt={connected:false}, greeks=[];
    try{
      const od=await options(symbol); if(od) opt={connected:true,...od};
      if(opt.expiry) greeks=await liveOptionGreeks(symbol,opt.expiry);
      const pickStrike=Number(opt.atm);
      const pickType=Number(opt.pcr)>=1?'CE':'PE';
      const candidates=greeks.filter(x=>x.strike===pickStrike);
      const g=candidates.find(x=>x.optionType===pickType)||candidates[0];
      if(g){opt.greeks=g;opt.theta=g.theta;opt.delta=g.delta;opt.iv=g.iv;opt.greekRisk=greekRiskWarning(g);}
    }catch{}
    const historical=backtestFiveMinute(m5.rows||[]);
    const vix=Number(md?.VIX?.ltp);
    const prediction=buildPrediction({h1:h1.summary,m15:m15.summary,m5:m5.summary,rows5:m5.rows,news:ns,global:gs,events:es,options:opt,marketOpen:marketSession(),backtest:historical,vix:Number.isFinite(vix)?vix:null,oi:opt});
    res.json({ok:true,phase:10,symbol,prediction,health:{market:true,options:opt.connected,news:ns.connected,global:gs.connected,eventBlocked:es.hardBlock,eventDayBlock:es.eventDayBlock,vix:Number.isFinite(vix)?vix:null},greeks:opt.greeks||null,greekRisk:opt.greekRisk||{status:'WAIT',message:'Live option Greeks not verified.'},backtest:historical,checkedAt:nowISO()});
  }catch(e){res.status(502).json({ok:false,phase:10,error:e?.message||'Phase 10 prediction unavailable'});}
});

app.get("/api/analyze",async(req,res)=>{
  const symbol=String(req.query.symbol||'NIFTY').toUpperCase();
  let h={market:false,options:false,news:false,global:false}, packs={};
  try{
    if(angelStatus().connected){
      const [h1,m15,m5,opt]=await Promise.all([
        loadTfSummary(symbol,'ONE_HOUR',10),
        loadTfSummary(symbol,'FIFTEEN_MINUTE',10),
        loadTfSummary(symbol,'FIVE_MINUTE',10),
        options(symbol)
      ]);
      packs={h1,m15,m5,opt}; h.market=!!(m5?.rows?.length); h.options=!!opt?.connected;
    }
  }catch(e){ packs.error=e.message; }
  const s1=packs.h1?.summary,s15=packs.m15?.summary,s5=packs.m5?.summary;
  const opt=packs.opt||{connected:false};
  let newsItems=[], global={}, eventItems=[], md=null;
  try{ [newsItems,global,eventItems,md]=await Promise.all([news(symbol),globalData(),events(),market(symbol)]); packs.md=md||{}; }catch(e){ packs.fusionError=e.message; }
  const newsStrat=analyzeNews(newsItems),globalStrat=analyzeGlobal(global),eventStrat=analyzeEvents(eventItems);
  const vix=Number(md?.VIX?.ltp);
  const volumeRatio10d=Number(s15?.volumeRatio10d||s5?.volumeRatio10d);
  const noTradeReasons=[];
  if(!Number.isFinite(vix)) noTradeReasons.push('No Trade: India VIX is not verified live.'); else if(vix<12||vix>22) noTradeReasons.push('No Trade: Market is too slow or too volatile.');
  if(Number.isFinite(s5?.adx) && s5.adx<20) noTradeReasons.push('No Trade: ADX below 20 — market is choppy/sideways.');
  if(!Number.isFinite(volumeRatio10d)) noTradeReasons.push('No Trade: 10-day breakout volume benchmark is not verified.'); else if(volumeRatio10d<1.5) noTradeReasons.push(`No Trade: breakout volume ${volumeRatio10d.toFixed(2)}x is below the 1.5x 10-day requirement.`);
  if(!eventStrat.connected) noTradeReasons.push('No Trade: economic-event calendar is not verified live.'); else if(eventStrat.eventDayBlock||eventStrat.hardBlock) noTradeReasons.push(eventStrat.reason);
  let action='NO TRADE',reason='Live Angel One connection is required before indicator analysis can run.',score=0,confidence='LOCKED';
  let trend=s1?.trend||'WAIT',setup=s15?.trend||'WAIT',trigger=s5?.candle||'WAIT';
  const bullishVotes=[trend==='BULLISH',setup==='BULLISH',s5?.rsi>50,s5?.macd?.hist>0,s5?.last>s5?.vwap,s5?.adx>=20].filter(Boolean).length;
  const bearishVotes=[trend==='BEARISH',setup==='BEARISH',s5?.rsi<50,s5?.macd?.hist<0,s5?.last<s5?.vwap,s5?.adx>=20].filter(Boolean).length;
  const techSigned = h.market ? ((bullishVotes-bearishVotes)/6)*100 : 0;
  const fused=fuse({technicalScore:techSigned,newsScore:newsStrat.score,globalScore:globalStrat.score,eventRisk:eventStrat.hardBlock,marketOpen:marketSession(),feeds:{market:h.market,options:h.options,news:newsStrat.connected,global:globalStrat.connected}});
  score=Math.round(Math.abs(fused.score)); confidence=h.market?(score>=67?'SETUP':score>=45?'WATCH':'WAIT'):'LOCKED';
  if(h.market) reason=`Technical confluence ${Math.round(Math.abs(techSigned))} • News ${newsStrat.bias} • Global ${globalStrat.bias}. ${eventStrat.reason}`;
  const complete=marketSession()&&h.market&&h.options&&newsStrat.connected&&globalStrat.connected&&!eventStrat.hardBlock;
  if(complete && score>=67 && noTradeReasons.length===0){action=fused.direction==='BULLISH'?'CALL':fused.direction==='BEARISH'?'PUT':'NO TRADE';}
  else {action='NO TRADE'; if(noTradeReasons.length) reason=noTradeReasons.join(' • '); else if(!marketSession()) reason='Exchange session is closed. No live trade is permitted.'; else if(!newsStrat.connected||!globalStrat.connected) reason='News/global feeds are not verified fresh. Final decision stays locked.'; else if(!h.options) reason='Option positioning feed is not verified. Final options decision stays locked.';}
  const last=s5?.last||s15?.last||s1?.last; const atr=s5?.atr; const levels={r2:s15?.last&&s15?.atr?(s15.last+s15.atr*2).toFixed(2):'—',r1:s15?.last&&s15?.atr?(s15.last+s15.atr).toFixed(2):'—',vwap:s15?.vwap?.toFixed?.(2)||'—',s1:s15?.last&&s15?.atr?(s15.last-s15.atr).toFixed(2):'—',s2:s15?.last&&s15?.atr?(s15.last-s15.atr*2).toFixed(2):'—'};
  const bp=action==='CALL'?{direction:'CALL',strike:'',entry:last||'',sl:atr&&last?(last-atr*1.2).toFixed(2):'',t1:atr&&last?(last+atr*1.5).toFixed(2):'',t2:atr&&last?(last+atr*2.5).toFixed(2):''}:action==='PUT'?{direction:'PUT',strike:'',entry:last||'',sl:atr&&last?(last+atr*1.2).toFixed(2):'',t1:atr&&last?(last-atr*1.5).toFixed(2):'',t2:atr&&last?(last-atr*2.5).toFixed(2):''}:{direction:'CALL',strike:'',entry:'',sl:'',t1:'',t2:''};
  res.json({health:{...h,news:newsStrat.connected,global:globalStrat.connected},marketData:md||{},decision:{action,score,confidence,rr:action==='CALL'||action==='PUT'?'1:2+':'—',reason,trend1h:trend,setup15m:setup,trigger5m:trigger,ema:s5?`20 ${s5.ema20?.toFixed(2)||'—'} / 50 ${s5.ema50?.toFixed(2)||'—'} / 200 ${s5.ema200?.toFixed(2)||'—'}`:'WAIT',rsi:s5?.rsi?.toFixed?.(1)||'—',macd:s5?`${s5.macd?.hist>0?'BULLISH':'BEARISH'} ${s5.macd?.hist?.toFixed?.(2)||'—'}`:'WAIT',adx:s5?.adx?.toFixed?.(1)||'—',vwap:s5?.vwap?.toFixed?.(2)||'—',priceAction:s5?.candle||'WAIT',volume:s5?'LIVE':'WAIT',atr:s5?.atr?.toFixed?.(2)||'—',momentum:s5?.rsi>50?'BULLISH':s5?.rsi<50?'BEARISH':'WAIT',options:h.options?((opt.resistance&&opt.support)?`LIVE • R ${opt.resistance} / S ${opt.support}`:'LIVE'):'WAIT',news:newsStrat.bias,global:globalStrat.bias,event:(eventStrat.eventDayBlock||eventStrat.hardBlock)?'HIGH RISK':'WATCH',levels,blueprint:bp,newsStrategy:newsStrat,globalStrategy:globalStrat,eventStrategy:eventStrat,vix:Number.isFinite(vix)?vix:null,volumeRatio10d:Number.isFinite(volumeRatio10d)?volumeRatio10d:null,noTradeReasons,oi:{resistance:opt?.resistance??null,support:opt?.support??null,ceMaxOi:opt?.ceMaxOi??null,peMaxOi:opt?.peMaxOi??null,pcr:opt?.pcr??null},fusion:{score:fused.score,direction:fused.direction,hardGate:fused.hardGate}},candles:s5?.rows||null,multiTf:{h1:s1||null,m15:s15||null,m5:s5||null}});
});

app.post("/api/order",(req,res)=>res.status(423).json({ok:false,error:"USE_PHASE5_PREVIEW",message:"Phase 5 uses /api/order/preview then explicit /api/order/execute confirmation."}));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const server=app.listen(PORT,()=>console.log(`PARTHAVI TRADE DESK PRO on http://localhost:${PORT}`));
server.requestTimeout=30000;
server.headersTimeout=35000;
server.keepAliveTimeout=5000;
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
process.on("SIGINT",()=>server.close(()=>process.exit(0)));
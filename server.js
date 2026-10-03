import express from "express";
import os from "os";
import crypto from "crypto";
import path from "path";
import {fileURLToPath} from "url";
import {createServer} from "http";
import WebSocket, {WebSocketServer} from "ws";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT||3000);
const ANGEL_ROOT="https://apiconnect.angelone.in";
const ANGEL_WS="wss://smartapisocket.angelone.in/smart-stream";
const INSTRUMENT_URL="https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

let session=null;
let instrumentCache={loadedAt:0,data:[]};
const streams=new Map();
const subscribedSockets=new Set();
let analysisCache={key:"",at:0,data:null};
let intelligenceCache={at:0,data:null};
let optionCache={key:"",at:0,data:null};
let runtimeStaticIpMatch=false;
let runtimeStaticIpLastChecked=0;
const connectAttempts=new Map();

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(express.json({limit:"64kb"}));
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Permissions-Policy","camera=(),microphone=(),geolocation=()");
  res.setHeader("Cache-Control","no-store");
  next();
});

function brokerConfigured(){
  return !!(process.env.ANGELONE_API_KEY&&process.env.ANGELONE_CLIENT_CODE&&process.env.ANGELONE_PIN);
}
function istClock(){
  const d=new Date(Date.now()+330*60000);
  const day=d.getUTCDay(),mins=d.getUTCHours()*60+d.getUTCMinutes();
  return {day,mins,weekday:day>=1&&day<=5};
}
function marketWindow(){
  const x=istClock();
  return {open:x.weekday&&x.mins>=555&&x.mins<=930,weekday:x.weekday,session:"09:15-15:30 IST"};
}
async function refreshRuntimeStaticIp(force=false){
  if(!force&&runtimeStaticIpLastChecked&&Date.now()-runtimeStaticIpLastChecked<60000)return runtimeStaticIpMatch;
  runtimeStaticIpLastChecked=Date.now();
  try{
    const r=await fetch("https://api.ipify.org?format=json",{signal:AbortSignal.timeout(4000)});
    const ip=r.ok?(await r.json()).ip:null;
    const registered=String(process.env.ANGELONE_REGISTERED_STATIC_IPS||"").split(",").map(x=>x.trim()).filter(Boolean);
    runtimeStaticIpMatch=!!ip&&registered.includes(ip);
  }catch(e){runtimeStaticIpMatch=false;}
  return runtimeStaticIpMatch;
}
function gates(){
  return {
    orderExecutionEnabled:process.env.ORDER_EXECUTION_ENABLED==="true",
    staticIpVerified:process.env.STATIC_IP_VERIFIED==="true"&&runtimeStaticIpMatch,
    protectiveSlVerified:process.env.PROTECTIVE_SL_VERIFIED==="true",
    firewallVerified:process.env.EXECUTION_FIREWALL_VERIFIED==="true",
    killSwitch:process.env.TRADING_KILL_SWITCH!=="false"
  };
}
function orderGate(){
  const g=gates(),m=marketWindow();
  return {
    unlocked:g.orderExecutionEnabled&&g.staticIpVerified&&g.protectiveSlVerified&&g.firewallVerified&&!g.killSwitch&&m.open,
    marketOpen:m.open,
    marketSession:m.session,
    ...g
  };
}
function connectRateLimit(req,res,next){
  const key=req.ip||"unknown",now=Date.now(),win=5*60000,max=8;
  const arr=(connectAttempts.get(key)||[]).filter(t=>now-t<win);
  if(arr.length>=max)return res.status(429).json({connected:false,error:"Too many broker login attempts. Try again later."});
  arr.push(now);connectAttempts.set(key,arr);next();
}
function localIp(){
  for(const list of Object.values(os.networkInterfaces())){
    for(const item of list||[]) if(!item.internal&&(item.family==="IPv4"||item.family===4)) return item.address;
  }
  return "127.0.0.1";
}
function b32(s){
  const clean=String(s||"").toUpperCase().replace(/[^A-Z2-7]/g,"");
  let bits="",out=[];
  for(const ch of clean){const v="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);if(v>=0)bits+=v.toString(2).padStart(5,"0");}
  for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(out);
}
function totp(secret,at=Date.now()){
  const key=b32(secret),counter=Math.floor(at/30000),buf=Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h=crypto.createHmac("sha1",key).update(buf).digest(),off=h[h.length-1]&15;
  return String((h.readUInt32BE(off)&0x7fffffff)%1000000).padStart(6,"0");
}
function safeError(e){return {connected:false,error:e?.message||"Broker request failed",errorCode:e?.code||null};}

async function angelRequest(method,route,body=null,tokenOverride=null){
  const token=tokenOverride||session?.jwtToken;
  if(route.includes("/secure/")&&!token) throw new Error("ANGELONE_SESSION_REQUIRED");
  const headers={
    "Content-Type":"application/json",
    "Accept":"application/json",
    "X-UserType":"USER",
    "X-SourceID":"WEB",
    "X-ClientLocalIP":process.env.ANGELONE_CLIENT_LOCAL_IP||localIp(),
    "X-ClientPublicIP":process.env.ANGELONE_PUBLIC_IP||"0.0.0.0",
    "X-MACAddress":process.env.ANGELONE_MAC_ADDRESS||"00:00:00:00:00:00",
    "X-PrivateKey":process.env.ANGELONE_API_KEY||""
  };
  if(token)headers.Authorization="Bearer "+token;
  const resp=await fetch(ANGEL_ROOT+route,{method,headers,body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const txt=await resp.text();
  let data;try{data=JSON.parse(txt);}catch{data={status:false,message:"Invalid JSON from Angel One"};}
  if(!resp.ok||data?.status===false){const e=new Error(data?.message||("Angel One HTTP "+resp.status));e.code=data?.errorcode||String(resp.status);e.data=data;throw e;}
  return data;
}
async function ensureSession(){
  if(session?.jwtToken)return session;
  if(!brokerConfigured())throw new Error("ANGELONE_CREDENTIALS_NOT_CONFIGURED");
  const code=process.env.ANGELONE_TOTP_SECRET?totp(process.env.ANGELONE_TOTP_SECRET):String(process.env.ANGELONE_TOTP_CODE||"");
  if(!/^\d{6}$/.test(code))throw new Error("ANGELONE_TOTP_REQUIRED");
  const d=await angelRequest("POST","/rest/auth/angelbroking/user/v1/loginByPassword",{
    clientcode:process.env.ANGELONE_CLIENT_CODE,password:process.env.ANGELONE_PIN,totp:code
  });
  session={jwtToken:d.data.jwtToken,refreshToken:d.data.refreshToken,feedToken:d.data.feedToken,clientCode:process.env.ANGELONE_CLIENT_CODE,connectedAt:new Date().toISOString()};
  return session;
}
function intervalName(tf){return ({"1M":"ONE_MINUTE","3M":"THREE_MINUTE","5M":"FIVE_MINUTE","10M":"TEN_MINUTE","15M":"FIFTEEN_MINUTE","30M":"THIRTY_MINUTE","1H":"ONE_HOUR","1D":"ONE_DAY"})[tf]||"FIFTEEN_MINUTE";}
function istStamp(date){
  const d=new Date(date.getTime()+330*60000),p=n=>String(n).padStart(2,"0");
  return d.getUTCFullYear()+"-"+p(d.getUTCMonth()+1)+"-"+p(d.getUTCDate())+" "+p(d.getUTCHours())+":"+p(d.getUTCMinutes());
}
async function loadInstruments(force=false){
  if(!force&&instrumentCache.data.length&&Date.now()-instrumentCache.loadedAt<30*60000)return instrumentCache.data;
  const r=await fetch(INSTRUMENT_URL,{signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error("INSTRUMENT_MASTER_HTTP_"+r.status);
  const a=await r.json();if(!Array.isArray(a))throw new Error("INSTRUMENT_MASTER_INVALID");
  instrumentCache={loadedAt:Date.now(),data:a};return a;
}
function segmentFrom(exchange){return ({NSE:"nse_cm",BSE:"bse_cm",NFO:"nse_fo",BFO:"bse_fo",MCX:"mcx_fo"})[String(exchange||"NSE").toUpperCase()]||"nse_cm";}
function findToken(data,segment,name){
  const q=String(name||"").toUpperCase();
  return data.filter(x=>String(x.exch_seg||"").toLowerCase()===segment).find(x=>String(x.symbol||"").toUpperCase()===q) ||
         data.filter(x=>String(x.exch_seg||"").toLowerCase()===segment).find(x=>String(x.name||"").toUpperCase()===q);
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
async function quoteBatch(exchange,tokens,mode="FULL"){
  await ensureSession();
  const uniq=[...new Set(tokens.map(String))].slice(0,50);
  if(!uniq.length)return [];
  const d=await angelRequest("POST","/rest/secure/angelbroking/market/v1/quote/",{mode,exchangeTokens:{[exchange]:uniq}});
  return Array.isArray(d?.data?.fetched)?d.data.fetched:[];
}
async function candlesFor(exchange,token,tf,days=5){
  await ensureSession();
  const cap=tf==="1M"?20:tf==="5M"?100:tf==="15M"?200:tf==="30M"?200:tf==="1H"?400:1000;
  const count=Math.min(Math.max(1,days),cap);
  const to=new Date(),from=new Date(Date.now()-count*86400000);
  const d=await angelRequest("POST","/rest/secure/angelbroking/historical/v1/getCandleData",{
    exchange,symboltoken:String(token),interval:intervalName(tf),fromdate:istStamp(from),todate:istStamp(to)
  });
  return (Array.isArray(d?.data)?d.data:[]).map(r=>({time:Math.floor(new Date(r[0]).getTime()/1000),open:num(r[1]),high:num(r[2]),low:num(r[3]),close:num(r[4]),volume:num(r[5])||0})).filter(x=>x.open!=null&&x.high!=null&&x.low!=null&&x.close!=null);
}

/* ---------- indicator engine ---------- */
function sma(a,n){if(a.length<n)return null;return a.slice(-n).reduce((s,x)=>s+x,0)/n;}
function emaSeries(a,n){
  if(!a.length)return [];
  const k=2/(n+1),out=new Array(a.length).fill(null);
  if(a.length<n)return out;
  let e=a.slice(0,n).reduce((s,x)=>s+x,0)/n;out[n-1]=e;
  for(let i=n;i<a.length;i++){e=a[i]*k+e*(1-k);out[i]=e;}
  return out;
}
function ema(a,n){const x=emaSeries(a,n);return x[x.length-1];}
function trSeries(c){
  const out=[];
  for(let i=0;i<c.length;i++)out.push(i===0?c[i].high-c[i].low:Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  return out;
}
function atrSeries(c,n=14){return emaSeries(trSeries(c),n);}
function atr(c,n=14){const x=atrSeries(c,n),v=x[x.length-1];return v;}
function rsiSeries(c,n=14){
  const out=new Array(c.length).fill(null);if(c.length<=n)return out;
  let gain=0,loss=0;for(let i=1;i<=n;i++){const d=c[i].close-c[i-1].close;gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  let ag=gain/n,al=loss/n;out[n]=al===0?100:100-100/(1+ag/al);
  for(let i=n+1;i<c.length;i++){const d=c[i].close-c[i-1].close;ag=(ag*(n-1)+Math.max(d,0))/n;al=(al*(n-1)+Math.max(-d,0))/n;out[i]=al===0?100:100-100/(1+ag/al);}
  return out;
}
function rsi(c,n=14){const x=rsiSeries(c,n);return x[x.length-1];}
function macd(c){
  const closes=c.map(x=>x.close),fastS=emaSeries(closes,12),slowS=emaSeries(closes,26),line=closes.map((_,i)=>fastS[i]!=null&&slowS[i]!=null?fastS[i]-slowS[i]:null);
  const valid=line.map((v,i)=>v==null?null:v).filter(v=>v!=null),sigArr=emaSeries(valid,9),signal=sigArr.length?sigArr[sigArr.length-1]:null;
  const m=line[line.length-1],prev=line[line.length-2];
  return {macd:m,signal,previous:prev,hist:m!=null&&signal!=null?m-signal:null};
}
function adx(c,n=14){
  if(c.length<n*2+1)return {adx:null,plusDI:null,minusDI:null};
  const tr=[],plus=[],minus=[];
  for(let i=1;i<c.length;i++){
    const up=c[i].high-c[i-1].high,down=c[i-1].low-c[i].low;
    tr.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
    plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
  }
  const atrs=emaSeries(tr,n),ps=emaSeries(plus,n),ms=emaSeries(minus,n),dx=[];
  let pLast=0,mLast=0;
  for(let i=0;i<tr.length;i++){if(atrs[i]>0){const p=100*ps[i]/atrs[i],m=100*ms[i]/atrs[i];pLast=p;mLast=m;dx.push((p+m)===0?0:100*Math.abs(p-m)/(p+m));}}
  const a=ema(dx,n);
  return {adx:a,plusDI:pLast,minusDI:mLast};
}
function bollinger(c,n=20,m=2){
  const a=c.map(x=>x.close),mid=sma(a,n);if(mid==null)return {mid:null,upper:null,lower:null};
  const s=Math.sqrt(a.slice(-n).reduce((s,x)=>s+(x-mid)*(x-mid),0)/n);
  return {mid,upper:mid+m*s,lower:mid-m*s};
}
function stochastic(c,n=14){
  if(c.length<n)return {k:null,d:null};
  const win=c.slice(-n),hi=Math.max(...win.map(x=>x.high)),lo=Math.min(...win.map(x=>x.low)),k=hi===lo?50:100*(c[c.length-1].close-lo)/(hi-lo);
  return {k,d:k};
}
function cci(c,n=20){
  if(c.length<n)return null;
  const tp=c.map(x=>(x.high+x.low+x.close)/3),avg=sma(tp,n),dev=tp.slice(-n).reduce((s,x)=>s+Math.abs(x-avg),0)/n;
  return dev===0?0:(tp[tp.length-1]-avg)/(0.015*dev);
}
function mfi(c,n=14){
  if(c.length<=n)return null;
  const tp=c.map(x=>(x.high+x.low+x.close)/3),pos=[],neg=[];
  for(let i=1;i<c.length;i++){const flow=tp[i]*c[i].volume;if(tp[i]>tp[i-1]){pos.push(flow);neg.push(0);}else if(tp[i]<tp[i-1]){pos.push(0);neg.push(flow);}else{pos.push(0);neg.push(0);}}
  const p=pos.slice(-n).reduce((s,x)=>s+x,0),ng=neg.slice(-n).reduce((s,x)=>s+x,0);return ng===0?100:100-100/(1+p/ng);
}
function roc(c,n=12){if(c.length<=n)return null;return 100*(c[c.length-1].close/c[c.length-1-n].close-1);}
function williams(c,n=14){if(c.length<n)return null;const w=c.slice(-n),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));return hi===lo?-50:-100*(hi-c[c.length-1].close)/(hi-lo);}
function obv(c){let v=0;for(let i=1;i<c.length;i++)v+=c[i].close>c[i-1].close?c[i].volume:c[i].close<c[i-1].close?-c[i].volume:0;return v;}
function vwap(c){let pv=0,vol=0;for(const x of c){const p=(x.high+x.low+x.close)/3;pv+=p*x.volume;vol+=x.volume;}return vol?pv/vol:null;}
function supertrend(c,n=10,m=3){
  if(c.length<n+2)return {value:null,direction:"NEUTRAL"};
  const a=atr(c,n)||0;let upper=(c[c.length-1].high+c[c.length-1].low)/2+m*a,lower=(c[c.length-1].high+c[c.length-1].low)/2-m*a;
  let dir=c[c.length-1].close>=upper?"BULLISH":c[c.length-1].close<=lower?"BEARISH":"NEUTRAL";
  return {value:dir==="BULLISH"?lower:upper,direction:dir};
}
function ichimoku(c){
  if(c.length<52)return {tenkan:null,kijun:null,senkouA:null,senkouB:null};
  const mid=(n)=>{const w=c.slice(-n),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));return (hi+lo)/2;};
  const tenkan=mid(9),kijun=mid(26),spanB=mid(52),spanA=(tenkan+kijun)/2;
  return {tenkan,kijun,senkouA:spanA,senkouB:spanB};
}
function patterns(c){
  if(c.length<3)return [];
  const a=c[c.length-1],p=c[c.length-2],body=Math.abs(a.close-a.open),range=a.high-a.low||1,up=a.high-Math.max(a.open,a.close),down=Math.min(a.open,a.close)-a.low,out=[];
  if(body/range<0.1)out.push("Doji");
  if(down>body*2&&up<body)out.push("Hammer");
  if(up>body*2&&down<body)out.push("Shooting Star");
  if(a.close> a.open && p.close<p.open && a.open<=p.close && a.close>=p.open)out.push("Bullish Engulfing");
  if(a.close<a.open && p.close>p.open && a.open>=p.close && a.close<=p.open)out.push("Bearish Engulfing");
  if(a.high<p.high&&a.low>p.low)out.push("Inside Bar");
  if(Math.abs(a.close-a.open)<range*0.05)out.push("Marubozu-like");
  return out;
}
function indicators(c){
  return {
    EMA20:ema(c.map(x=>x.close),20),EMA50:ema(c.map(x=>x.close),50),EMA200:ema(c.map(x=>x.close),200),
    RSI:rsi(c),MACD:macd(c),ADX:adx(c),ATR:atr(c),VWAP:vwap(c),Bollinger:bollinger(c),Stochastic:stochastic(c),
    CCI:cci(c),MFI:mfi(c),ROC:roc(c),WilliamsR:williams(c),OBV:obv(c),Supertrend:supertrend(c),Ichimoku:ichimoku(c),
    patterns:patterns(c)
  };
}
function frameSignal(c){
  if(c.length<60)return {state:"NEUTRAL",score:0,indicators:indicators(c)};
  const x=indicators(c),p=c[c.length-1].close;let bull=0,bear=0;
  if(x.EMA20!=null&&x.EMA50!=null){if(p>x.EMA20&&x.EMA20>x.EMA50)bull++;if(p<x.EMA20&&x.EMA20<x.EMA50)bear++;}
  if(x.EMA50!=null&&x.EMA200!=null){if(x.EMA50>x.EMA200)bull++;if(x.EMA50<x.EMA200)bear++;}
  if(x.RSI!=null){if(x.RSI>=52&&x.RSI<=72)bull++;if(x.RSI<=48&&x.RSI>=28)bear++;}
  if(x.MACD.hist!=null){if(x.MACD.hist>0)bull++;if(x.MACD.hist<0)bear++;}
  if(x.ADX.adx!=null&&x.ADX.adx>=18){if(x.ADX.plusDI>x.ADX.minusDI)bull++;if(x.ADX.minusDI>x.ADX.plusDI)bear++;}
  if(x.VWAP!=null){if(p>x.VWAP)bull++;if(p<x.VWAP)bear++;}
  if(x.Supertrend.direction==="BULLISH")bull++;if(x.Supertrend.direction==="BEARISH")bear++;
  const score=bull-bear;
  return {state:score>=4?"BULLISH":score<=-4?"BEARISH":"NEUTRAL",score,indicators:x};
}
function decision(frames,livePrice=null){
  const states=frames.map(x=>x.state),bull=states.filter(x=>x==="BULLISH").length,bear=states.filter(x=>x==="BEARISH").length;
  const fresh=frames.every(x=>x.fresh!==false);
  const last=frames[2],price=Number(livePrice)||last?.price||null,a=last?.indicators?.ATR||0;
  const adx=Number(last?.indicators?.ADX?.adx||0);
  const directional=last?.score>=5?"BULLISH":last?.score<=-5?"BEARISH":"NEUTRAL";
  const alignedBull=bull===3&&directional==="BULLISH";
  const alignedBear=bear===3&&directional==="BEARISH";
  const confirmed=fresh&&(alignedBull||alignedBear)&&adx>=18;
  let direction="NO TRADE",confluence=0;
  if(alignedBull)direction="CALL";
  else if(alignedBear)direction="PUT";
  confluence=Math.round(Math.min(100,50+
    (bull===3||bear===3?20:0)+
    (fresh?15:0)+
    (adx>=18?10:0)+
    (Math.min(7,Math.abs(last?.score||0))/7)*5
  ));
  if(!confirmed)direction="NO TRADE";
  const buffer=a?Math.max(a*0.7,price?price*0.002:0):price?price*0.002:null;
  const entry=price,sl=confirmed&&entry!=null&&buffer!=null?(direction==="CALL"?entry-buffer:direction==="PUT"?entry+buffer:null):null;
  const risk=entry!=null&&sl!=null?Math.abs(entry-sl):null;
  const t1=risk!=null?(direction==="CALL"?entry+risk*1.5:direction==="PUT"?entry-risk*1.5:null):null;
  const t2=risk!=null?(direction==="CALL"?entry+risk*2.5:direction==="PUT"?entry-risk*2.5:null):null;
  const t3=risk!=null?(direction==="CALL"?entry+risk*3.5:direction==="PUT"?entry-risk*3.5:null):null;
  const rr=risk?3.5:"—";
  const align=states.join(" / ");
  const blockers=[];
  if(!fresh)blockers.push("stale market data");
  if(!(alignedBull||alignedBear))blockers.push("1H/15M/5M not aligned");
  if(adx<18)blockers.push("trend strength below ADX 18");
  return {
    direction,
    confirmation:confirmed?"CONFIRMED":"NO TRADE",
    confidence:confirmed?confluence:Math.min(confluence,60),
    entry,sl,t1,t2,t3,rr,states,
    dataFresh:fresh,
    trendStrength:adx,
    reason:confirmed
      ?"1H / 15M / 5M aligned with trend-strength confirmation: "+align+"."
      :"Blocked: "+(blockers.join(", ")||"risk checks not satisfied")+"."
  };
}

/* ---------- API ---------- */
app.get("/api/health",(req,res)=>res.json({ok:true,service:"parthavi-trade-desk-pro",liveBrokerConfigured:brokerConfigured(),brokerSession:!!session?.jwtToken,gates:orderGate(),serverTime:new Date().toISOString()}));

app.post("/api/broker/connect",connectRateLimit,async(req,res)=>{
  try{
    if(req.body?.totp&&!process.env.ANGELONE_TOTP_SECRET)process.env.ANGELONE_TOTP_CODE=String(req.body.totp).replace(/\D/g,"").slice(0,6);
    session=null;const s=await ensureSession();analysisCache={key:"",at:0,data:null};optionCache={key:"",at:0,data:null};
    res.json({connected:true,clientCode:s.clientCode,connectedAt:s.connectedAt});
  }catch(e){res.status(503).json(safeError(e));}
});
app.post("/api/broker/autoconnect",async(req,res)=>{try{const s=await ensureSession();res.json({connected:true,clientCode:s.clientCode,connectedAt:s.connectedAt});}catch(e){res.status(503).json(safeError(e));}});
app.post("/api/broker/logout",async(req,res)=>{try{if(session?.jwtToken)await angelRequest("POST","/rest/secure/angelbroking/user/v1/logout",{clientcode:session.clientCode});}catch(e){}session=null;for(const s of streams.values()){s.closed=true;try{s.ws?.close()}catch(e){}}streams.clear();res.json({connected:false});});

app.get("/api/account",async(req,res)=>{try{await ensureSession();const d=(await angelRequest("GET","/rest/secure/angelbroking/user/v1/getRMS")).data||{};res.json({connected:true,cash:Number(d.availablecash||0),net:Number(d.net||0),usedMargin:Number(d.utiliseddebits||0),dayPnl:Number(d.m2mrealized||0)+Number(d.m2munrealized||0),raw:d});}catch(e){res.status(503).json(safeError(e));}});
app.get("/api/positions",async(req,res)=>{try{await ensureSession();res.json({connected:true,positions:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getPosition")).data||[]});}catch(e){res.status(503).json(safeError(e));}});
app.get("/api/holdings",async(req,res)=>{try{await ensureSession();const d=(await angelRequest("GET","/rest/secure/angelbroking/portfolio/v1/getAllHolding")).data||{};res.json({connected:true,...d});}catch(e){res.status(503).json(safeError(e));}});
app.get("/api/orders",async(req,res)=>{try{await ensureSession();res.json({connected:true,orders:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getOrderBook")).data||[]});}catch(e){res.status(503).json(safeError(e));}});
app.get("/api/trades",async(req,res)=>{try{await ensureSession();res.json({connected:true,trades:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getTradeBook")).data||[]});}catch(e){res.status(503).json(safeError(e));}});

app.post("/api/quote",async(req,res)=>{try{const {exchange,tradingsymbol,symboltoken}=req.body||{};if(!exchange||!tradingsymbol||!symboltoken)return res.status(400).json({error:"exchange, tradingsymbol and symboltoken are required"});await ensureSession();const d=await angelRequest("POST","/rest/secure/angelbroking/order/v1/getLtpData",{exchange,tradingsymbol,symboltoken});res.json({connected:true,data:d.data});}catch(e){res.status(503).json(safeError(e));}});

app.get("/api/instruments/search",async(req,res)=>{
  try{
    const data=await loadInstruments(),exchange=String(req.query.exchange||"NFO").toUpperCase(),seg=String(req.query.segment||segmentFrom(exchange)).toLowerCase(),q=String(req.query.q||"").trim().toUpperCase(),type=String(req.query.optionType||"").toUpperCase(),expiry=String(req.query.expiry||"").toUpperCase(),strike=req.query.strike==null?null:Number(req.query.strike),limit=Math.min(100,Math.max(1,Number(req.query.limit||40)));
    let rows=data.filter(x=>String(x.exch_seg||"").toLowerCase()===seg);
    if(q)rows=rows.filter(x=>[x.symbol,x.name,x.exch_seg].join(" ").toUpperCase().includes(q));
    if(type)rows=rows.filter(x=>String(x.symbol||"").toUpperCase().endsWith(type));
    if(Number.isFinite(strike))rows=rows.filter(x=>Math.abs(Number(x.strike||0)/100-strike)<0.001||Math.abs(Number(x.strike||0)-strike)<0.001);
    if(expiry&&expiry!=="NEAREST")rows=rows.filter(x=>String(x.expiry||"").toUpperCase()===expiry);
    rows.sort((a,b)=>String(a.expiry||"").localeCompare(String(b.expiry||""))||String(a.symbol||"").localeCompare(String(b.symbol||"")));
    res.json({connected:!!session?.jwtToken,source:"Angel One instrument master",count:Math.min(limit,rows.length),contracts:rows.slice(0,limit).map(x=>({token:String(x.token),symbol:x.symbol,name:x.name,expiry:x.expiry||"",strike:x.strike,lotsize:x.lotsize,exch_seg:x.exch_seg,optiontype:String(x.symbol||"").slice(-2)}))});
  }catch(e){res.status(503).json({connected:!!session?.jwtToken,error:e.message||"Instrument search failed"});}
});

app.get("/api/candles",async(req,res)=>{try{const exchange=String(req.query.exchange||"NSE").toUpperCase(),token=String(req.query.symboltoken||""),tf=String(req.query.tf||"15M").toUpperCase(),days=Number(req.query.days||5);if(!token)return res.status(400).json({error:"symboltoken is required"});const candles=await candlesFor(exchange,token,tf,days);res.json({connected:true,exchange,symboltoken:token,tf,count:candles.length,candles});}catch(e){res.status(503).json(safeError(e));}});

app.get("/api/analysis",async(req,res)=>{
  try{
    const underlying=String(req.query.underlying||"NIFTY").toUpperCase();
    const key=underlying;
    if(analysisCache.key===key&&Date.now()-analysisCache.at<20000)return res.json(analysisCache.data);
    const data=await loadInstruments(),idx=findToken(data,"nse_cm",underlying)||findToken(data,"nse_cm",underlying+"-EQ");
    if(!idx)throw new Error("INDEX_TOKEN_NOT_FOUND_"+underlying);
    const c1=await candlesFor("NSE",idx.token,"1H",60);
    const c2=await candlesFor("NSE",idx.token,"15M",10);
    const c3=await candlesFor("NSE",idx.token,"5M",5);
    const q=(await quoteBatch("NSE",[idx.token],"LTP"))[0]||{};
    const frames=[c1,c2,c3].map((c,i)=>{
      const tf=["1H","15M","5M"][i],f=frameSignal(c),lastTs=c[c.length-1]?.time||0,ageMin=lastTs?Math.max(0,(Date.now()/1000-lastTs)/60):9999;
      const maxAge=tf==="5M"?20:tf==="15M"?45:tf==="1H"?120:120;
      return {...f,timeframe:tf,price:c[c.length-1]?.close||null,lastCandleTime:lastTs,ageMinutes:Number(ageMin.toFixed(1)),fresh:ageMin<=maxAge};
    });
    const livePrice=Number(q.ltp||frames[2].price||0);
    const d=decision(frames,livePrice);const out={live:true,underlying,token:String(idx.token),price:livePrice,...d,frames};
    analysisCache={key,at:Date.now(),data:out};res.json(out);
  }catch(e){res.status(503).json({live:false,prediction:"NEUTRAL",confirmation:"NO TRADE",direction:"NO TRADE",confidence:null,backtestHitRate:null,reason:e.message||"Live analysis unavailable"});}
});

function expiryMs(s){
  const m=String(s||"").toUpperCase().match(/^([0-9]{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([0-9]{4})$/);if(!m)return Number.MAX_SAFE_INTEGER;
  const mm={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};return Date.UTC(Number(m[3]),mm[m[2]],Number(m[1]));
}
app.get("/api/options/chain",async(req,res)=>{
  try{
    const underlying=String(req.query.underlying||"NIFTY").toUpperCase(),width=Math.min(7,Math.max(2,Number(req.query.width||5)));
    const key=underlying+"|"+width;
    if(optionCache.key===key&&Date.now()-optionCache.at<15000)return res.json(optionCache.data);
    const data=await loadInstruments(),nfo=data.filter(x=>String(x.exch_seg||"").toLowerCase()==="nse_fo"&&String(x.name||"").toUpperCase()===underlying&&/\b(CE|PE)$/.test(String(x.symbol||"")));
    if(!nfo.length)throw new Error("OPTION_CHAIN_NOT_FOUND_"+underlying);
    const expiries=[...new Set(nfo.map(x=>String(x.expiry||"").toUpperCase()).filter(Boolean))].sort((a,b)=>expiryMs(a)-expiryMs(b));
    const expiry=expiries[0];const rows=nfo.filter(x=>String(x.expiry||"").toUpperCase()===expiry);
    const strikes=[...new Set(rows.map(x=>Number(x.strike||0)/100).filter(Number.isFinite))].sort((a,b)=>a-b);
    const spotToken=findToken(data,"nse_cm",underlying);
    const spotQuote=spotToken?(await quoteBatch("NSE",[spotToken.token],"FULL"))[0]:null;
    const spot=Number(spotQuote?.ltp||0);const nearest=strikes.length&&spot?strikes.reduce((a,b)=>Math.abs(b-spot)<Math.abs(a-spot)?b:a,strikes[Math.floor(strikes.length/2)]):strikes[Math.floor(strikes.length/2)];
    const chosen=strikes.filter(s=>Math.abs(s-nearest)<=Math.max(1,Number(process.env.OPTION_STRIKE_STEP||50))*width);
    const contracts=rows.filter(x=>chosen.includes(Number(x.strike||0)/100));
    const quotes=await quoteBatch("NFO",contracts.map(x=>x.token),"FULL");
    const byToken=new Map(quotes.map(x=>[String(x.symbolToken||x.symboltoken),x]));
    const chain=contracts.map(x=>{const q=byToken.get(String(x.token))||{};return {token:String(x.token),symbol:x.symbol,strike:Number(x.strike||0)/100,type:String(x.symbol||"").slice(-2),expiry:x.expiry,lotSize:Number(x.lotsize||0),ltp:Number(q.ltp||0),openInterest:Number(q.opnInterest||q.openInterest||0),oiChange:Number(q.oiChange||0),volume:Number(q.tradeVolume||q.volume||0),changePct:Number(q.percentChange||0)};}).sort((a,b)=>a.strike-b.strike||a.type.localeCompare(b.type));
    const totalCE=chain.filter(x=>x.type==="CE").reduce((s,x)=>s+(x.openInterest||0),0),totalPE=chain.filter(x=>x.type==="PE").reduce((s,x)=>s+(x.openInterest||0),0),pcrOI=totalCE?totalPE/totalCE:null;
    const candidateDirection=pcrOI!=null?(pcrOI<0.9?"CALL":pcrOI>1.1?"PUT":"NO TRADE"):"NO TRADE";
    const candidateRow=candidateDirection==="CALL"?chain.filter(x=>x.type==="CE"&&x.strike>nearest).sort((a,b)=>a.strike-b.strike)[0]:candidateDirection==="PUT"?chain.filter(x=>x.type==="PE"&&x.strike<nearest).sort((a,b)=>b.strike-a.strike)[0]:null;
    const premium=Number(candidateRow?.ltp||0),premiumRisk=premium>0?Math.max(premium*0.25,0.5):null;
    const indicativeCandidate=premium>0?{direction:candidateDirection,token:candidateRow.token,symbol:candidateRow.symbol,strike:candidateRow.strike,ltp:premium,sl:Math.max(0,premium-(premiumRisk||0)),t1:premium+(premiumRisk||0)*1.5,t2:premium+(premiumRisk||0)*2.5,t3:premium+(premiumRisk||0)*3.5,note:"Indicative PCR/OI candidate; confirm with 1H/15M/5M before any order."}:null;
    const out={live:true,underlying,spot,expiry,atm:nearest,chain,totalCE,totalPE,pcrOI,indicativeCandidate};optionCache={key,at:Date.now(),data:out};res.json(out);
  }catch(e){res.status(503).json({live:false,error:e.message||"Option chain unavailable",chain:[]});}
});

const PUBLIC_SOURCES=[
  {symbol:"S&P 500",ticker:"^GSPC",group:"US"},
  {symbol:"NASDAQ",ticker:"^IXIC",group:"US"},
  {symbol:"NIKKEI",ticker:"^N225",group:"ASIA"},
  {symbol:"USD/INR",ticker:"INR=X",group:"FX"},
  {symbol:"DXY",ticker:"DX-Y.NYB",group:"RATES"},
  {symbol:"US 10Y",ticker:"^TNX",group:"RATES"},
  {symbol:"BRENT",ticker:"BZ=F",group:"COMMODITY"},
  {symbol:"GOLD",ticker:"GC=F",group:"COMMODITY"}
];
function xmlDecode(s){
  let out=String(s||"");
  out=out.split("<![CDATA[").join("").split("]]>").join("");
  let clean="";
  for(let i=0;i<out.length;){
    const a=out.indexOf("<",i);
    if(a<0){clean+=out.slice(i);break;}
    clean+=out.slice(i,a);
    const b=out.indexOf(">",a+1);
    if(b<0)break;
    i=b+1;
  }
  return clean.split("&amp;").join("&").split("&quot;").join('"').split("&#39;").join("'").split("&lt;").join("<").split("&gt;").join(">").trim();
}
function extractXmlTag(block,tag){
  const open="<"+tag+">",close="</"+tag+">";
  const a=block.indexOf(open);if(a<0)return "";
  const b=block.indexOf(close,a+open.length);if(b<0)return "";
  return block.slice(a+open.length,b);
}
async function fetchNews(){
  const queries=[
    "Nifty India stock market when:1d",
    "India RBI rupee markets when:1d",
    "US Fed Treasury yields markets when:1d",
    "Brent crude gold Asia markets when:1d"
  ];
  const rows=(await Promise.all(queries.map(async q=>{
    try{
      const u="https://news.google.com/rss/search?q="+encodeURIComponent(q)+"&hl=en-IN&gl=IN&ceid=IN:en";
      const r=await fetch(u,{headers:{"User-Agent":"PARTHAVI-TRADE-DESK/2.0"},signal:AbortSignal.timeout(5000)});
      if(!r.ok)return [];
      const xml=await r.text();
      const parts=xml.split("<item>").slice(1);
      return parts.slice(0,5).map(block=>{
        const title=xmlDecode(extractXmlTag(block,"title"));
        const link=xmlDecode(extractXmlTag(block,"link"));
        const pub=xmlDecode(extractXmlTag(block,"pubDate"));
        return {title,link,publishedAt:pub||null};
      }).filter(x=>x.title);
    }catch(e){return []}
  }))).flat();
  const seen=new Set();
  return rows.filter(x=>{
    const k=x.title.toLowerCase();
    if(seen.has(k))return false;
    seen.add(k);
    return true;
  }).slice(0,12);
}
app.get("/api/intelligence",async(req,res)=>{
  if(intelligenceCache.at&&Date.now()-intelligenceCache.at<20000)return res.json(intelligenceCache.data);
  const items=[
    ["NIFTY 50","NSE index","Angel One live when connected"],
    ["BANK NIFTY","NSE index","Angel One live when connected"],
    ["INDIA VIX","NSE index","Angel One live when connected"],
    ["GIFT NIFTY","Global indicator","External quote not guaranteed"],
    ["S&P 500","US market","Public market snapshot"],
    ["NASDAQ","US market","Public market snapshot"],
    ["NIKKEI","Asia market","Public market snapshot"],
    ["USD/INR","FX","Public market snapshot"],
    ["DXY","Dollar index","Public market snapshot"],
    ["US 10Y","Rates","Public market snapshot"],
    ["BRENT","Crude","Public market snapshot"],
    ["GOLD","Commodity","Public market snapshot"]
  ];
  const snaps=[];
  if(session?.jwtToken){
    try{
      const data=await loadInstruments();
      const refs=[
        ["NIFTY",findToken(data,"nse_cm","NIFTY")],
        ["BANK NIFTY",findToken(data,"nse_cm","BANKNIFTY")],
        ["INDIA VIX",data.find(x=>String(x.exch_seg||"").toLowerCase()==="nse_cm"&&/INDIA\s*VIX|INDIAVIX|VIX/.test(String(x.symbol||"").toUpperCase()+" "+String(x.name||"").toUpperCase()))]
      ];
      const valid=refs.filter(x=>x[1]);if(valid.length){
        const qs=await quoteBatch("NSE",valid.map(x=>x[1].token),"FULL");
        const by=new Map(qs.map(x=>[String(x.symbolToken||x.symboltoken),x]));
        for(const [label,c] of valid){
          const q=by.get(String(c.token))||{};
          const price=Number(q.ltp||0),prev=Number(q.close||q.previousClose||0);
          snaps.push({symbol:label,price,previous:prev,changePct:prev?100*(price-prev)/prev:null,source:"Angel One"});
        }
      }
    }catch(e){}
  }
  const publicSnaps=await Promise.all(PUBLIC_SOURCES.map(async s=>{
    try{
      const r=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(s.ticker)+"?range=1d&interval=1m",{headers:{"User-Agent":"PARTHAVI-TRADE-DESK/2.0"},signal:AbortSignal.timeout(3500)});
      if(!r.ok)return null;
      const j=await r.json(),m=j?.chart?.result?.[0]?.meta;if(!m)return null;
      const price=Number(m.regularMarketPrice||0),prev=Number(m.previousClose||0);
      return {symbol:s.symbol,price,previous:prev,changePct:prev?100*(price-prev)/prev:null,source:"Public market data"};
    }catch(e){return null}
  }));
  const news=await fetchNews();
  const out={updatedAt:new Date().toISOString(),items,snapshots:snaps.concat(publicSnaps.filter(Boolean)),news,marketWindow:marketWindow()};
  intelligenceCache={at:Date.now(),data:out};res.json(out);
});

app.get("/api/network/status",async(req,res)=>{
  let observed=null;try{const r=await fetch("https://api.ipify.org?format=json",{signal:AbortSignal.timeout(4000)});if(r.ok)observed=(await r.json()).ip||null;}catch(e){}
  const registered=String(process.env.ANGELONE_REGISTERED_STATIC_IPS||"").split(",").map(x=>x.trim()).filter(Boolean);
  res.json({observedOutboundIp:observed,configuredPublicIp:process.env.ANGELONE_PUBLIC_IP||null,registeredStaticIps:registered,match:observed?registered.includes(observed):false,staticIpVerified:process.env.STATIC_IP_VERIFIED==="true",ordersRequireRegisteredStaticIp:true});
});
app.get("/api/market/status",async(req,res)=>{
  const m=marketWindow();
  await refreshRuntimeStaticIp();
  const g=orderGate();
  res.json({exchange:String(req.query.exchange||"NSE").toUpperCase(),now:new Date().toISOString(),serverOpenWindow:m.session,marketOpen:m.open,weekday:m.weekday,canTrade:g.unlocked,reason:g.unlocked?"Order gate configured; final user confirmation still required.":"Order gate locked."});
});

/* Order APIs intentionally require all production gates; env defaults keep real-money execution OFF. */
const recentOrderIds=new Map();
function cleanOrderId(v){return String(v||"").trim().slice(0,80);}
function rememberOrderId(id){
  const now=Date.now();
  for(const [k,t] of recentOrderIds)if(now-t>10*60*1000)recentOrderIds.delete(k);
  if(!id)return false;
  if(recentOrderIds.has(id))return true;
  recentOrderIds.set(id,now);return false;
}
app.post("/api/orders/place",async(req,res)=>{
  await refreshRuntimeStaticIp(true);
  const gate=orderGate();
  if(!gate.unlocked)return res.status(423).json({placed:false,locked:true,gate,reason:"Production order gate is locked."});
  try{
    await ensureSession();
    const payload={...(req.body||{})},clientOrderId=cleanOrderId(payload.clientOrderId);
    delete payload.clientOrderId;
    if(!clientOrderId)return res.status(400).json({placed:false,error:"clientOrderId is required"});
    if(rememberOrderId(clientOrderId))return res.status(409).json({placed:false,error:"Duplicate clientOrderId rejected"});
    if(!payload.variety||!payload.tradingsymbol||!payload.symboltoken||!payload.transactiontype||!payload.exchange||!payload.ordertype||!payload.producttype||!payload.duration||!payload.quantity)return res.status(400).json({placed:false,error:"Missing required order fields"});
    if(String(payload.ordertype).toUpperCase()==="MARKET")return res.status(400).json({placed:false,error:"MARKET orders are disabled by the execution firewall; use a validated protected order flow."});
    const d=await angelRequest("POST","/rest/secure/angelbroking/order/v1/placeOrder",payload);
    res.json({placed:true,clientOrderId,data:d.data});
  }catch(e){res.status(503).json({placed:false,...safeError(e)});}
});
app.post("/api/orders/modify",async(req,res)=>{await refreshRuntimeStaticIp(true);if(!orderGate().unlocked)return res.status(423).json({modified:false,locked:true,gate:orderGate()});try{await ensureSession();res.json({modified:true,data:(await angelRequest("POST","/rest/secure/angelbroking/order/v1/modifyOrder",req.body||{})).data});}catch(e){res.status(503).json({modified:false,...safeError(e)});}});
app.post("/api/orders/cancel",async(req,res)=>{await refreshRuntimeStaticIp(true);if(!orderGate().unlocked)return res.status(423).json({cancelled:false,locked:true,gate:orderGate()});try{await ensureSession();res.json({cancelled:true,data:(await angelRequest("POST","/rest/secure/angelbroking/order/v1/cancelOrder",req.body||{})).data});}catch(e){res.status(503).json({cancelled:false,...safeError(e)});}});

setInterval(()=>{refreshRuntimeStaticIp(true).catch(()=>{})},60000);
refreshRuntimeStaticIp(true).catch(()=>{});

/* ---------- SmartStream ---------- */
function parsePacket(buf){
  const b=Buffer.isBuffer(buf)?buf:Buffer.from(buf);if(b.length<51)return null;
  const mode=b.readUInt8(0),exchangeType=b.readUInt8(1),token=b.subarray(2,27).toString("utf8").replace(/\0/g,""),sequence=Number(b.readBigInt64LE(27)),exchangeTimestamp=Number(b.readBigInt64LE(35)),o={mode,exchangeType,token,sequence,exchangeTimestamp};
  if(mode===1){o.ltp=b.readInt32LE(43)/100;return o;}
  if(b.length>=123){o.ltp=Number(b.readBigInt64LE(43))/100;o.lastTradedQuantity=Number(b.readBigInt64LE(51));o.avgTradedPrice=Number(b.readBigInt64LE(59))/100;o.volume=Number(b.readBigInt64LE(67));o.totalBuyQuantity=b.readDoubleLE(75);o.totalSellQuantity=b.readDoubleLE(83);o.open=Number(b.readBigInt64LE(91))/100;o.high=Number(b.readBigInt64LE(99))/100;o.low=Number(b.readBigInt64LE(107))/100;o.close=Number(b.readBigInt64LE(115))/100;}
  if(mode===3&&b.length>=379){o.lastTradedTimestamp=Number(b.readBigInt64LE(123));o.openInterest=Number(b.readBigInt64LE(131));o.openInterestChange=b.readDoubleLE(139);}
  return o;
}
function push(ws,p){if(ws.readyState===WebSocket.OPEN)try{ws.send(JSON.stringify(p));}catch(e){}}
function streamKey(mode,tokens){return JSON.stringify({mode,tokens:tokens.map(x=>({exchangeType:x.exchangeType,tokens:[...x.tokens].map(String).sort()})).sort((a,b)=>a.exchangeType-b.exchangeType)});}
async function ensureStream(mode,tokens){
  const key=streamKey(mode,tokens);if(streams.has(key))return streams.get(key);
  if(!session?.feedToken)throw new Error("ANGELONE_SESSION_REQUIRED");
  const state={key,mode,tokens,ws:null,closed:false,subs:new Set(),timer:null};
  const open=()=>{
    if(state.closed)return;
    const url=ANGEL_WS+"?clientCode="+encodeURIComponent(session.clientCode)+"&feedToken="+encodeURIComponent(session.feedToken)+"&apiKey="+encodeURIComponent(process.env.ANGELONE_API_KEY||"");
    state.ws=new WebSocket(url,{handshakeTimeout:10000});
    state.ws.on("open",()=>{try{state.ws.send(JSON.stringify({correlationID:"PTD01",action:1,params:{mode:state.mode,tokenList:state.tokens}}));}catch(e){};clearInterval(state.timer);state.timer=setInterval(()=>{try{if(state.ws.readyState===WebSocket.OPEN)state.ws.ping();}catch(e){}},30000);for(const s of state.subs)push(s,{type:"connected",mode,tokens:state.tokens});});
    state.ws.on("message",data=>{if(Buffer.isBuffer(data)){const tick=parsePacket(data);if(tick)for(const s of state.subs)push(s,{type:"tick",data:tick});}else for(const s of state.subs)push(s,{type:"message",data:String(data)});});
    state.ws.on("error",e=>{for(const s of state.subs)push(s,{type:"stream_error",message:e.message});});
    state.ws.on("close",()=>{clearInterval(state.timer);if(!state.closed){for(const s of state.subs)push(s,{type:"disconnected"});setTimeout(open,2000);}});
  };
  state.open=open;streams.set(key,state);open();return state;
}
const server=createServer(app),wss=new WebSocketServer({server,path:"/api/live/stream"});
wss.on("connection",ws=>{
  subscribedSockets.add(ws);push(ws,{type:"ready",brokerSession:!!session?.jwtToken});
  ws.on("message",async raw=>{try{const m=JSON.parse(String(raw));if(m.action!=="subscribe"||!Array.isArray(m.tokenList)||!m.tokenList.length)return;const state=await ensureStream(Math.max(1,Math.min(3,Number(m.mode||3))),m.tokenList);state.subs.add(ws);push(ws,{type:"subscribed",mode:state.mode,tokens:m.tokenList});}catch(e){push(ws,{type:"stream_error",message:e.message||"Subscribe failed"});}});
  ws.on("close",()=>subscribedSockets.delete(ws));
});

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.get("/*splat",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log("PARTHAVI TRADE DESK PRO on "+PORT));

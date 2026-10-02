import express from "express";
import os from "os";
import crypto from "crypto";
import path from "path";
import {fileURLToPath} from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ANGEL_ROOT = "https://apiconnect.angelone.in";

let session = null;
let instrumentCache = { loadedAt: 0, data: [] };
const INSTRUMENT_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

app.disable("x-powered-by");
app.use(express.json({limit:"32kb"}));
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Permissions-Policy","camera=(),microphone=(),geolocation=()");
  next();
});

function brokerConfigured(){
  return Boolean(process.env.ANGELONE_API_KEY && process.env.ANGELONE_CLIENT_CODE && process.env.ANGELONE_PIN);
}

function gateState(){
  return {
    orderExecutionEnabled: process.env.ORDER_EXECUTION_ENABLED === "true",
    staticIpVerified: process.env.STATIC_IP_VERIFIED === "true",
    protectiveSlVerified: process.env.PROTECTIVE_SL_VERIFIED === "true",
    killSwitch: process.env.TRADING_KILL_SWITCH !== "false"
  };
}

function localIp(){
  for(const list of Object.values(os.networkInterfaces())){
    for(const item of list || []){
      if(!item.internal && (item.family === "IPv4" || item.family === 4)) return item.address;
    }
  }
  return "127.0.0.1";
}

function base32ToBuffer(input){
  const clean = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g,"");
  let bits = "", bytes = [];
  for(const ch of clean){
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    if(v < 0) continue;
    bits += v.toString(2).padStart(5,"0");
  }
  for(let i=0;i+8<=bits.length;i+=8) bytes.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(bytes);
}

function makeTotp(secret, timestamp=Date.now()){
  const key = base32ToBuffer(secret);
  const counter = Math.floor(timestamp/1000/30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length-1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6,"0");
}

async function angelRequest(method, route, body=null, tokenOverride=null){
  const token = tokenOverride || session?.jwtToken;
  if(!token && route.includes("/secure/")) throw new Error("ANGELONE_SESSION_REQUIRED");
  const headers = {
    "Content-Type":"application/json",
    "Accept":"application/json",
    "X-UserType":"USER",
    "X-SourceID":"WEB",
    "X-ClientLocalIP":process.env.ANGELONE_CLIENT_LOCAL_IP || localIp(),
    "X-ClientPublicIP":process.env.ANGELONE_PUBLIC_IP || "0.0.0.0",
    "X-MACAddress":process.env.ANGELONE_MAC_ADDRESS || "00:00:00:00:00:00",
    "X-PrivateKey":process.env.ANGELONE_API_KEY || ""
  };
  if(token) headers.Authorization = "Bearer " + token;
  const resp = await fetch(ANGEL_ROOT + route, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await resp.text();
  let data; try{ data = JSON.parse(text); }catch{ data = {status:false,message:"Invalid JSON from Angel One",raw:text.slice(0,500)}; }
  if(!resp.ok || data?.status === false){
    const err = new Error(data?.message || ("Angel One HTTP "+resp.status));
    err.code = data?.errorcode || String(resp.status);
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureSession(){
  if(!brokerConfigured()) throw new Error("ANGELONE_CREDENTIALS_NOT_CONFIGURED");
  if(session?.jwtToken){
    return session;
  }
  const totp = process.env.ANGELONE_TOTP_SECRET ? makeTotp(process.env.ANGELONE_TOTP_SECRET) : process.env.ANGELONE_TOTP_CODE;
  if(!totp) throw new Error("ANGELONE_TOTP_REQUIRED");
  const data = await angelRequest("POST","/rest/auth/angelbroking/user/v1/loginByPassword",{
    clientcode:process.env.ANGELONE_CLIENT_CODE,
    password:process.env.ANGELONE_PIN,
    totp
  }, null);
  session = {
    jwtToken:data.data.jwtToken,
    refreshToken:data.data.refreshToken,
    feedToken:data.data.feedToken,
    clientCode:process.env.ANGELONE_CLIENT_CODE,
    connectedAt:new Date().toISOString()
  };
  return session;
}


function intervalName(tf){
  return ({
    "1M":"ONE_MINUTE","3M":"THREE_MINUTE","5M":"FIVE_MINUTE","10M":"TEN_MINUTE",
    "15M":"FIFTEEN_MINUTE","30M":"THIRTY_MINUTE","1H":"ONE_HOUR","1D":"ONE_DAY"
  })[tf] || "FIFTEEN_MINUTE";
}

function istStamp(date){
  const d = new Date(date.getTime() + 330*60*1000);
  const p=n=>String(n).padStart(2,"0");
  return d.getUTCFullYear()+"-"+p(d.getUTCMonth()+1)+"-"+p(d.getUTCDate())+" "+p(d.getUTCHours())+":"+p(d.getUTCMinutes());
}

async function loadInstruments(force=false){
  const fresh = instrumentCache.data.length && (Date.now()-instrumentCache.loadedAt < 30*60*1000);
  if(fresh && !force) return instrumentCache.data;
  const resp = await fetch(INSTRUMENT_URL,{signal:AbortSignal.timeout(30000),headers:{"Accept":"application/json","User-Agent":"PARTHAVI-TRADE-DESK/1.0"}});
  if(!resp.ok) throw new Error("INSTRUMENT_MASTER_HTTP_"+resp.status);
  const text = await resp.text();
  const parsed = JSON.parse(text);
  if(!Array.isArray(parsed)) throw new Error("INSTRUMENT_MASTER_INVALID");
  instrumentCache={loadedAt:Date.now(),data:parsed};
  return parsed;
}

function normalizeExchange(exchange, segment){
  if(segment) return String(segment).toLowerCase();
  return ({NSE:"nse_cm",BSE:"bse_cm",NFO:"nse_fo",BFO:"bse_fo",MCX:"mcx_fo"})[String(exchange||"NSE").toUpperCase()] || "nse_cm";
}

function instrumentMatches(item,q,segment){
  const needle=String(q||"").trim().toUpperCase();
  if(!needle) return true;
  const hay=[item.symbol,item.name,item.exch_seg].join(" ").toUpperCase();
  return hay.includes(needle);
}

function safeError(e){
  return {connected:false,error:e?.message || "Broker request failed",errorCode:e?.code || null};
}

app.get("/api/health",(req,res)=>res.json({
  ok:true,
  service:"parthavi-trade-desk-pro",
  liveBrokerConfigured:brokerConfigured(),
  brokerSession:!!session?.jwtToken,
  gates:gateState()
}));

app.post("/api/broker/connect",async(req,res)=>{
  try{
    if(req.body?.totp && !process.env.ANGELONE_TOTP_SECRET){
      process.env.ANGELONE_TOTP_CODE=String(req.body.totp).replace(/\D/g,"").slice(0,6);
    }
    session=null;
    const s=await ensureSession();
    res.json({connected:true,clientCode:s.clientCode,connectedAt:s.connectedAt});
  }catch(e){ res.status(503).json(safeError(e)); }
});

app.post("/api/broker/logout",async(req,res)=>{
  try{
    if(session?.jwtToken){
      await angelRequest("POST","/rest/secure/angelbroking/user/v1/logout",{clientcode:session.clientCode});
    }
  }catch(e){}
  session=null;
  res.json({connected:false});
});

app.get("/api/account",async(req,res)=>{
  try{
    await ensureSession();
    const d=(await angelRequest("GET","/rest/secure/angelbroking/user/v1/getRMS")).data || {};
    res.json({
      connected:true,
      cash:Number(d.availablecash||0),
      net:Number(d.net||0),
      usedMargin:Number(d.utiliseddebits||0),
      dayPnl:Number(d.m2mrealized||0)+Number(d.m2munrealized||0),
      raw:d
    });
  }catch(e){
    res.status(503).json(safeError(e));
  }
});

app.get("/api/profile",async(req,res)=>{
  try{ await ensureSession(); res.json({connected:true,data:(await angelRequest("GET","/rest/secure/angelbroking/user/v1/getProfile")).data}); }
  catch(e){ res.status(503).json(safeError(e)); }
});

app.get("/api/positions",async(req,res)=>{
  try{ await ensureSession(); res.json({connected:true,positions:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getPosition")).data || []}); }
  catch(e){ res.status(503).json(safeError(e)); }
});

app.get("/api/holdings",async(req,res)=>{
  try{ await ensureSession(); const d=(await angelRequest("GET","/rest/secure/angelbroking/portfolio/v1/getAllHolding")).data || {}; res.json({connected:true,...d}); }
  catch(e){ res.status(503).json(safeError(e)); }
});

app.get("/api/orders",async(req,res)=>{
  try{ await ensureSession(); res.json({connected:true,orders:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getOrderBook")).data || []}); }
  catch(e){ res.status(503).json(safeError(e)); }
});

app.get("/api/trades",async(req,res)=>{
  try{ await ensureSession(); res.json({connected:true,trades:(await angelRequest("GET","/rest/secure/angelbroking/order/v1/getTradeBook")).data || []}); }
  catch(e){ res.status(503).json(safeError(e)); }
});

app.post("/api/quote",async(req,res)=>{
  try{
    await ensureSession();
    const {exchange,tradingsymbol,symboltoken}=req.body||{};
    if(!exchange || !tradingsymbol || !symboltoken) return res.status(400).json({error:"exchange, tradingsymbol and symboltoken are required"});
    const d=(await angelRequest("POST","/rest/secure/angelbroking/order/v1/getLtpData",{exchange,tradingsymbol,symboltoken})).data;
    res.json({connected:true,data:d});
  }catch(e){ res.status(503).json(safeError(e)); }
});


app.get("/api/instruments/search",async(req,res)=>{
  try{
    const data=await loadInstruments();
    const exchange=String(req.query.exchange||"NFO").toUpperCase();
    const segment=normalizeExchange(exchange,req.query.segment);
    const q=String(req.query.q||"").trim().toUpperCase();
    const optionType=String(req.query.optionType||"").trim().toUpperCase();
    const strike=req.query.strike!=null && req.query.strike!=="" ? Number(req.query.strike) : null;
    const expiry=String(req.query.expiry||"").trim().toUpperCase();
    const limit=Math.max(1,Math.min(50,Number(req.query.limit||20)));
    let rows=data.filter(x=>String(x.exch_seg||"").toLowerCase()===segment);
    rows=rows.filter(x=>instrumentMatches(x,q,segment));
    if(optionType) rows=rows.filter(x=>String(x.symbol||"").toUpperCase().endsWith(optionType));
    if(strike!=null && Number.isFinite(strike)) rows=rows.filter(x=>Math.abs(Number(x.strike||0)/100-strike)<0.0001 || Math.abs(Number(x.strike||0)-strike)<0.0001);
    if(expiry && expiry!=="NEAREST") rows=rows.filter(x=>String(x.expiry||"").toUpperCase()===expiry);
    rows.sort((a,b)=>{
      const ea=String(a.expiry||""); const eb=String(b.expiry||"");
      return ea.localeCompare(eb) || String(a.symbol||"").localeCompare(String(b.symbol||""));
    });
    const out=rows.slice(0,limit).map(x=>({token:String(x.token),symbol:x.symbol,name:x.name,expiry:x.expiry||"",strike:x.strike,lotsize:x.lotsize,exch_seg:x.exch_seg,optiontype:x.symbol?.slice(-2)||""}));
    res.json({connected:!!session?.jwtToken,source:"Angel One instrument master",count:out.length,contracts:out});
  }catch(e){res.status(503).json({connected:!!session?.jwtToken,error:e?.message||"Instrument search failed"});}
});

app.get("/api/candles",async(req,res)=>{
  try{
    await ensureSession();
    const exchange=String(req.query.exchange||"NSE").toUpperCase();
    const symboltoken=String(req.query.symboltoken||"");
    const tf=String(req.query.tf||"15M").toUpperCase();
    const days=Math.max(1,Math.min(Number(req.query.days||5),tf==="1M"?30:tf==="5M"?100:tf==="15M"?200:tf==="30M"?200:tf==="1H"?400:2000));
    if(!symboltoken) return res.status(400).json({error:"symboltoken is required"});
    const to=new Date(), from=new Date(Date.now()-days*86400000);
    const body={exchange,symboltoken,interval:intervalName(tf),fromdate:istStamp(from),todate:istStamp(to)};
    const data=(await angelRequest("POST","/rest/secure/angelbroking/historical/v1/getCandleData",body)).data || [];
    const candles=(Array.isArray(data)?data:[]).map(r=>({time:Math.floor(new Date(r[0]).getTime()/1000),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]||0)})).filter(x=>Number.isFinite(x.time)&&Number.isFinite(x.close));
    res.json({connected:true,exchange,symboltoken,tf,fromdate:body.fromdate,todate:body.todate,count:candles.length,candles});
  }catch(e){res.status(503).json(safeError(e));}
});

app.get("/api/market/status",(req,res)=>res.json({
  exchange:req.query.exchange||"NSE",
  status:"VERIFYING",
  canTrade:false,
  reason:"Exchange session/order gates must be verified server-side."
}));

app.get("/api/network/status",async(req,res)=>{
  const configured=String(process.env.ANGELONE_PUBLIC_IP||"").trim();
  let observed=null;
  try{
    const r=await fetch("https://api.ipify.org?format=json",{signal:AbortSignal.timeout(4000)});
    if(r.ok) observed=(await r.json()).ip || null;
  }catch(e){}
  const allowed=String(process.env.ANGELONE_REGISTERED_STATIC_IPS||"").split(",").map(x=>x.trim()).filter(Boolean);
  res.json({
    observedOutboundIp:observed,
    configuredPublicIp:configured || null,
    registeredStaticIps:allowed,
    match:observed ? allowed.includes(observed) : false,
    dedicatedIpRequiredForOrders:true,
    staticIpVerified:process.env.STATIC_IP_VERIFIED==="true"
  });
});

app.get("/api/analysis",(req,res)=>res.json({
  live:!!session?.jwtToken,
  prediction:"NEUTRAL",
  confirmation:"NO TRADE",
  confidence:null,
  backtestHitRate:null,
  direction:"NO TRADE",
  reason:session?.jwtToken ? "Broker session available; live multi-timeframe analysis adapter is the next module." : "Verified live candles/options/news/global data not connected."
}));

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.get("/*splat",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log("PARTHAVI TRADE DESK PRO on "+PORT));

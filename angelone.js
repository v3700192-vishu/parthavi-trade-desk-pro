import SmartApiPackage from "smartapi-javascript";
import address from "address";

const { SmartAPI, WebSocketV2 } = SmartApiPackage;
const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

let api = null;
let session = { connected:false, clientCode:null, loginAt:null, jwtToken:null, feedToken:null, profile:null };
let masterCache = { loadedAt:0, items:[] };
let ws = null;
let wsConnected = false;
let wsError = null;
let reconnectTimer = null;
let latestTicks = new Map();
let lastTickAt = null;

export function angelStatus(){
  return {
    connected:session.connected,
    clientCode:session.clientCode,
    loginAt:session.loginAt,
    websocket:!!ws && wsConnected,
    tickCount:latestTicks.size,
    lastTickAt,
    websocketError:wsError
  };
}

export async function loginAngel({clientCode, pin, totp}){
  if(!process.env.ANGEL_API_KEY) throw new Error("ANGEL_API_KEY is not configured on the server");
  const cc = clientCode || process.env.ANGEL_CLIENT_CODE;
  if(!cc || !pin || !totp) throw new Error("Client code, PIN and TOTP are required");
  api = new SmartAPI({api_key:process.env.ANGEL_API_KEY});
  const data = await api.generateSession(cc, pin, totp);
  if(!data?.status) throw new Error(data?.message || "Angel One login failed");
  session = {connected:true, clientCode:cc, loginAt:new Date().toISOString(), jwtToken:data.data?.jwtToken||null, feedToken:data.data?.feedToken||null, profile:null};
  try { session.profile = await api.getProfile(); } catch {}
  try { await connectMarketWebSocket(); } catch (e) { wsError = e?.message || "WebSocket connection failed"; }
  return {connected:true, clientCode:cc, loginAt:session.loginAt, profile:session.profile, websocket:angelStatus().websocket, websocketError:wsError};
}

export async function logoutAngel(){
  try { if(api && session.connected) await api.logout({clientcode:session.clientCode}); } catch {}
  if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
  if(ws){ try{ws.closeConnection?.()}catch{}; ws=null; }
  wsConnected=false; wsError=null; lastTickAt=null;
  api=null; session={connected:false,clientCode:null,loginAt:null,jwtToken:null,feedToken:null,profile:null}; latestTicks.clear();
  return angelStatus();
}

function requireApi(){ if(!api || !session.connected) throw new Error("Angel One is not connected"); return api; }

function requireSession(){
  if(!api || !session.connected || !session.jwtToken) throw new Error("Angel One is not connected");
  return {api, jwtToken:session.jwtToken};
}

function exchangeForSegment(exchSeg){
  const s=String(exchSeg||'').toLowerCase();
  if(s==='nse_cm') return 'NSE';
  if(s==='nse_fo') return 'NFO';
  if(s==='bse_cm') return 'BSE';
  if(s==='bse_fo') return 'BFO';
  return null;
}

function normalizeExpiry(value){
  const raw=String(value||'').trim().toUpperCase();
  if(!raw) return '';
  if(/^\d{1,2}[A-Z]{3}\d{4}$/.test(raw)) return raw;
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){
    const [y,m,d]=raw.split('-').map(Number);
    const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${String(d).padStart(2,'0')}${months[m-1]}${y}`;
  }
  return raw;
}

export function normalizeContract(x){
  const exchange=exchangeForSegment(x?.exch_seg);
  const isOption=['OPTCF','OPTSTK','OPTIDX'].includes(String(x?.instrumenttype||'').toUpperCase()) || /(?:CE|PE)$/.test(String(x?.symbol||'').toUpperCase());
  const strikeRaw=Number(x?.strike);
  const strike=(Number.isFinite(strikeRaw) && strikeRaw>0) ? (strikeRaw>=100000?strikeRaw/100: strikeRaw) : '';
  const symbol=String(x?.symbol||'');
  const optionType=/PE$/i.test(symbol)?'PE':/CE$/i.test(symbol)?'CE':'';
  return {
    token:String(x?.token||''), symbol, name:String(x?.name||''), expiry:String(x?.expiry||''),
    normalizedExpiry:normalizeExpiry(x?.expiry), strike, lotsize:Number(x?.lotsize||0)||0,
    instrumenttype:String(x?.instrumenttype||''), exch_seg:String(x?.exch_seg||''), exchange,
    optionType, tradingsymbol:symbol, isOption
  };
}

function mergeMarketData(rows){
  const arr=Array.isArray(rows)?rows:[];
  return arr.map(x=>({
    exchange:x.exchange, tradingSymbol:x.tradingSymbol, symbolToken:String(x.symbolToken||''),
    ltp:x.ltp, open:x.open, high:x.high, low:x.low, close:x.close,
    change:x.percentageChange ?? x.change ?? null, lastTradeQty:x.lastTradeQty ?? null,
    exchTradeTime:x.exchTradeTime ?? x.exchangeTimeStamp ?? null,
    upperCircuit:x.upperCircuit, lowerCircuit:x.lowerCircuit,
    opnInterest:x.opnInterest ?? x.openInterest ?? x.oi ?? null,
    tradeVolume:x.tradeVolume ?? x.volume ?? null,
    bestFive:x.bestFive ?? null
  }));
}

export async function quoteInstruments(instruments){
  const a=requireApi();
  const list=Array.isArray(instruments)?instruments:[];
  if(!list.length) return [];
  const exchangeTokens={};
  for(const x of list){
    const ex=String(x.exchange || exchangeForSegment(x.exch_seg)||'').toUpperCase();
    const token=String(x.symboltoken || x.token || '');
    if(!ex || !token) continue;
    (exchangeTokens[ex] ||= []).push(token);
  }
  for(const k of Object.keys(exchangeTokens)) exchangeTokens[k]=[...new Set(exchangeTokens[k])].slice(0,50);
  const data=await a.getMarketData('FULL', exchangeTokens);
  return mergeMarketData(data?.data?.fetched||[]);
}

export async function optionGreeks({name, expirydate}){
  const {jwtToken}=requireSession();
  const endpoint='https://apiconnect.angelone.in/rest/secure/angelbroking/marketData/v1/optionGreek';
  const headers={
    'Content-Type':'application/json',
    'Accept':'application/json',
    'X-PrivateKey':String(process.env.ANGEL_API_KEY||''),
    'Authorization':`Bearer ${jwtToken}`,
    'X-SourceID':'WEB',
    'X-ClientLocalIP':'127.0.0.1',
    'X-ClientPublicIP':'127.0.0.1',
    'X-MACAddress':'00:00:00:00:00:00'
  };
  const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({name,expirydate:normalizeExpiry(expirydate)})});
  const out=await r.json().catch(()=>({status:false,message:'Invalid JSON'}));
  if(!r.ok || out?.status===false) throw new Error(out?.message||`Option Greeks HTTP ${r.status}`);
  return out?.data||[];
}



function secureHeaders(){
  if(!session.jwtToken || !process.env.ANGEL_API_KEY) throw new Error("Angel One secure session is not ready");
  return {
    'Content-Type':'application/json',
    'Accept':'application/json',
    'X-UserType':'USER',
    'X-SourceID':'WEB',
    'X-PrivateKey':String(process.env.ANGEL_API_KEY).trim(),
    'Authorization':`Bearer ${session.jwtToken}`,
    'X-ClientLocalIP':process.env.ANGEL_CLIENT_LOCAL_IP || '127.0.0.1',
    'X-ClientPublicIP':process.env.ANGEL_CLIENT_PUBLIC_IP || '127.0.0.1',
    'X-MACAddress':process.env.ANGEL_MAC_ADDRESS || '00:00:00:00:00:00'
  };
}

async function secureJson(url, options={}){
  const r=await fetch(url,{...options,signal:AbortSignal.timeout(8000)});
  const out=await r.json().catch(()=>({status:false,message:`HTTP ${r.status}`}));
  if(!r.ok || out?.status===false) throw new Error(out?.message || `Angel One HTTP ${r.status}`);
  return out;
}

export async function rms(){
  requireSession();
  if(api && typeof api.getRMS === 'function') return await api.getRMS();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS',{headers:secureHeaders()});
}

export async function orderBook(){
  requireSession();
  if(api && typeof api.getOrderBook === 'function') return await api.getOrderBook();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getOrderBook',{method:'GET',headers:secureHeaders()});
}

export async function holdings(){
  requireSession();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getHolding',{method:'GET',headers:secureHeaders()});
}

export async function allHoldings(){
  requireSession();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getAllHolding',{method:'GET',headers:secureHeaders()});
}

export async function positions(){
  requireSession();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition',{method:'GET',headers:secureHeaders()});
}

export async function tradeBook(){
  requireSession();
  if(api && typeof api.getTradeBook === 'function') return await api.getTradeBook();
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getTradeBook',{method:'GET',headers:secureHeaders()});
}

export async function modifyOrder(order){
  requireSession();
  const payload={...order};
  if(api && typeof api.modifyOrder === 'function') return await api.modifyOrder(payload);
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/modifyOrder',{method:'POST',headers:secureHeaders(),body:JSON.stringify(payload)});
}

export async function placeOrder(order){
  requireSession();
  const payload={...order};
  if(api && typeof api.placeOrder === 'function') return await api.placeOrder(payload);
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder',{method:'POST',headers:secureHeaders(),body:JSON.stringify(payload)});
}

export async function cancelOrder(orderid){
  requireSession();
  const payload={variety:'NORMAL',orderid:String(orderid)};
  if(api && typeof api.cancelOrder === 'function') return await api.cancelOrder(payload);
  return await secureJson('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/cancelOrder',{method:'POST',headers:secureHeaders(),body:JSON.stringify(payload)});
}

export async function findInstrumentByToken(token){
  const items=await loadMaster();
  const t=String(token||'');
  return items.find(x=>String(x.token||'')===t) || null;
}

export function getLatestTicks(){ return [...latestTicks.values()].sort((a,b)=>b.at-a.at).slice(0,200); }

export async function subscribeMasterTokens(items){
  const groups=new Map([[1,[]],[2,[]],[3,[]],[4,[]],[5,[]]]);
  const toType=x=>({nse_cm:1,nse_fo:2,bse_cm:3,bse_fo:4,mcx_fo:5}[String(x.exch_seg||'').toLowerCase()]||null);
  for(const x of items||[]){ const t=toType(x); if(t && x.token) groups.get(t).push(String(x.token)); }
  const results=[];
  for(const [exchangeType,tokens] of groups){
    if(!tokens.length) continue;
    const u=[...new Set(tokens)].slice(0,50);
    results.push(await subscribe(u,exchangeType,2));
  }
  return results;
}

export async function ltp({exchange, tradingsymbol, symboltoken}){
  requireSession();
  return await secureJson("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getLtpData",{method:"POST",headers:secureHeaders(),body:JSON.stringify({exchange,tradingsymbol,symboltoken:String(symboltoken)})});
}

export async function quote({mode="FULL", exchangeTokens}){
  requireSession();
  return await secureJson("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote",{method:"POST",headers:secureHeaders(),body:JSON.stringify({mode,exchangeTokens})});
}

export async function candles({exchange, symboltoken, interval, fromdate, todate}){
  requireSession();
  return await secureJson("https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData",{method:"POST",headers:secureHeaders(),body:JSON.stringify({exchange,symboltoken:String(symboltoken),interval,fromdate,todate})});
}

export async function searchScrip({exchange, searchscrip}){
  requireSession();
  return await secureJson("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/searchScrip",{method:"POST",headers:secureHeaders(),body:JSON.stringify({exchange,searchscrip})});
}

export async function loadMaster(force=false){
  if(!force && masterCache.items.length && Date.now()-masterCache.loadedAt < 6*60*60*1000) return masterCache.items;
  const r=await fetch(MASTER_URL);
  if(!r.ok) throw new Error(`Instrument master HTTP ${r.status}`);
  const items=await r.json();
  if(!Array.isArray(items)) throw new Error("Instrument master format unexpected");
  masterCache={loadedAt:Date.now(),items};
  return items;
}

export async function findContracts({exchange="NSE", segment="OPTIDX", underlying="", expiry="", optionType="", strike="", query=""}){
  const items=await loadMaster();
  const ex=exchange.toUpperCase();
  const segMap={NSE:{EQUITY:"nse_cm",FUT:"nse_fo",OPTIDX:"nse_fo",OPTSTK:"nse_fo"},BSE:{EQUITY:"bse_cm",FUT:"bse_fo",OPTIDX:"bse_fo",OPTSTK:"bse_fo"}};
  const targetSeg=segMap[ex]?.[segment.toUpperCase()] || segment.toLowerCase();
  const q=(query||underlying||"").toUpperCase();
  const ot=(optionType||"").toUpperCase();
  const st=strike!=="" && strike!=null ? Number(strike) : null;
  return items.filter(x=>{
    if(String(x.exch_seg||'').toLowerCase()!==targetSeg) return false;
    if(q && !(String(x.name||'').toUpperCase().includes(q) || String(x.symbol||'').toUpperCase().includes(q))) return false;
    if(underlying && String(x.name||'').toUpperCase()!==underlying.toUpperCase()) return false;
    if(expiry && String(x.expiry||'').toUpperCase()!==expiry.toUpperCase()) return false;
    if(ot && !String(x.symbol||'').toUpperCase().endsWith(ot)) return false;
    if(st!==null && Number(x.strike)/100!==st && Number(x.strike)!==st) return false;
    return true;
  }).slice(0,200).map(x=>({token:x.token,symbol:x.symbol,name:x.name,expiry:x.expiry,strike:x.strike,lotsize:x.lotsize,instrumenttype:x.instrumenttype,exch_seg:x.exch_seg,tick_size:x.tick_size}));
}

async function subscribeOnSocket(tokens, exchangeType=1, mode=1){
  if(!ws || !wsConnected) throw new Error("Angel One WebSocket is not connected");
  const clean=[...new Set((tokens||[]).map(String).filter(Boolean))];
  if(!clean.length) throw new Error("No tokens supplied");
  const req={correlationID:`PTD${Date.now().toString().slice(-7)}`,action:1,mode:Number(mode),exchangeType:Number(exchangeType),tokens:clean};
  ws.fetchData(req);
  return {subscribed:true,tokens:clean.length,exchangeType:Number(exchangeType),mode:Number(mode)};
}

function scheduleReconnect(){
  if(!session.connected || reconnectTimer) return;
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    if(!session.connected) return;
    try { await connectMarketWebSocket(); } catch (e) {
      wsError=e?.message||"WebSocket reconnect failed";
      scheduleReconnect();
    }
  },5000);
}

async function connectMarketWebSocket(){
  if(!session.connected || !session.jwtToken || !session.feedToken) throw new Error("Angel One session is not connected");
  if(ws && wsConnected) return angelStatus();

  if(ws){ try{ws.closeConnection?.()}catch{}; ws=null; }
  wsConnected=false; wsError=null;

  const socket=new WebSocketV2({
    jwttoken:session.jwtToken,
    apikey:process.env.ANGEL_API_KEY,
    clientcode:session.clientCode,
    feedtype:session.feedToken
  });
  ws=socket;

  try{
    socket.on('tick', data=>{
      try{
        const token=String(data?.token ?? data?.symbolToken ?? data?.symboltoken ?? JSON.stringify(data));
        latestTicks.set(token,{data,at:Date.now()});
        lastTickAt=Date.now();
        wsConnected=true;
        wsError=null;
      }catch{}
    });
    socket.on('error', err=>{
      wsConnected=false;
      wsError=err?.message || String(err) || "Angel One WebSocket error";
      scheduleReconnect();
    });
    socket.on('close', ()=>{
      wsConnected=false;
      if(session.connected) scheduleReconnect();
    });
  }catch{}

  await socket.connect();
  wsConnected=true;
  wsError=null;
  await subscribeOnSocket(["99926000","99926009","99926017","99926037","99926074"],1,1);
  return angelStatus();
}

export async function subscribe(tokens, exchangeType=2, mode=1){
  if(!session.connected || !session.jwtToken || !session.feedToken) throw new Error("Angel One session is not connected");
  if(!ws || !wsConnected) await connectMarketWebSocket();
  return await subscribeOnSocket(tokens,exchangeType,mode);
}
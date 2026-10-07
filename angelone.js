import SmartApiPackage from "smartapi-javascript";
import address from "address";

const { SmartAPI, WebSocketV2 } = SmartApiPackage;

function angelApiKey(){
  return String(process.env.ANGEL_API_KEY || process.env.ANGELONE_API_KEY || '').trim();
}

const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

let api = null;
let session = { connected:false, clientCode:null, loginAt:null, jwtToken:null, refreshToken:null, feedToken:null, profile:null };
let masterCache = { loadedAt:0, items:[] };
let ws = null;
let wsConnected = false;
let wsError = null;
let reconnectTimer = null;
let tokenRefreshTimer = null;
let watchdogTimer = null;
let wsConnectBusy = false;
let wsConnectPromise=null;
let latestTicks = new Map();
let lastTickAt = null;
let wsGeneration = 0;
let lastRefreshAt = 0;
let refreshPromise=null;

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
  const apiKey=angelApiKey();
  if(!apiKey) throw new Error("ANGEL_API_KEY / ANGELONE_API_KEY is not configured on the server");
  const cc = clientCode || (process.env.ANGEL_CLIENT_CODE || process.env.ANGELONE_CLIENT_CODE);
  if(!cc || !pin || !totp) throw new Error("Client code, PIN and TOTP are required");
  api = new SmartAPI({api_key:apiKey});
  try{ api.setSessionExpiryHook?.(()=>{
    const age=Date.now()-(session.loginAt?Date.parse(session.loginAt):Date.now());
    if(age<60000) return;
    void refreshSessionTokens();
  }); }catch{}
  const data = await api.generateSession(cc, pin, totp);
  if(!data?.status) throw new Error(data?.message || "Angel One login failed");
  session = {connected:true, clientCode:cc, loginAt:new Date().toISOString(), jwtToken:data.data?.jwtToken||null, refreshToken:data.data?.refreshToken||null, feedToken:data.data?.feedToken||null, profile:null};
  startConnectionGuards();
  try { session.profile = await api.getProfile(); } catch {}
  // Do not block REST login on the streaming socket. Angel One login succeeds first;
  // WebSocket connection is established in the background and can retry independently.
  void connectMarketWebSocket().catch(e=>{ wsError=e?.message || "WebSocket connection failed"; scheduleReconnect(); });
  return {connected:true, clientCode:cc, loginAt:session.loginAt, profile:session.profile, websocket:angelStatus().websocket, websocketError:wsError};
}

export async function logoutAngel(){
  try { if(api && session.connected) await api.logout({clientcode:session.clientCode}); } catch {}
  if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
  if(tokenRefreshTimer){ clearTimeout(tokenRefreshTimer); tokenRefreshTimer=null; }
  if(watchdogTimer){ clearInterval(watchdogTimer); watchdogTimer=null; }
  if(ws){ try{ws.close?.()}catch{}; try{ws.closeConnection?.()}catch{}; ws=null; }
  wsConnected=false; wsConnectBusy=false; wsError=null; lastTickAt=null;
  api=null; session={connected:false,clientCode:null,loginAt:null,jwtToken:null,refreshToken:null,feedToken:null,profile:null}; latestTicks.clear();
  wsConnectBusy=false;
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
    change:x.percentChange ?? x.percentageChange ?? x.netChange ?? x.change ?? null, netChange:x.netChange ?? null, percentChange:x.percentChange ?? x.percentageChange ?? null, lastTradeQty:x.lastTradeQty ?? null,
    exchTradeTime:x.exchTradeTime ?? x.exchangeTimeStamp ?? null,
    upperCircuit:x.upperCircuit, lowerCircuit:x.lowerCircuit,
    opnInterest:x.opnInterest ?? x.openInterest ?? x.oi ?? null,
    tradeVolume:x.tradeVolume ?? x.volume ?? null,
    bestFive:x.depth ?? x.bestFive ?? null
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
  let rows=[];
  try{
    const data=await a.getMarketData('FULL', exchangeTokens);
    rows=mergeMarketData(data?.data?.fetched||[]);
  }catch(e){
    console.warn('[ANGEL_QUOTE] FULL quote unavailable:',e?.message||e);
  }
  // FULL can omit contracts or fail transiently while authenticated REST is still usable.
  // Fill every missing contract through the authenticated LTP endpoint.
  const seen=new Set(rows.map(x=>String(x.symbolToken||'')));
  const missing=list.filter(x=>String(x.token||x.symboltoken||'') && !seen.has(String(x.token||x.symboltoken)));
  if(missing.length){
    const extra=await Promise.allSettled(missing.slice(0,20).map(async x=>{
      const ex=String(x.exchange||exchangeForSegment(x.exch_seg)||'').toUpperCase();
      const token=String(x.symboltoken||x.token||'');
      if(!ex||!token) return null;
      const r=await ltp({exchange:ex,tradingsymbol:String(x.tradingsymbol||x.symbol||''),symboltoken:token});
      const d=r?.data||r;
      if(d?.ltp==null) return null;
      return {exchange:ex,tradingSymbol:String(x.tradingsymbol||x.symbol||''),symbolToken:token,
        ltp:Number(d.ltp),close:d?.close??null,
        change:d?.percentChange??d?.percentageChange??d?.netChange??null,
        netChange:d?.netChange??null,percentChange:d?.percentChange??d?.percentageChange??null,
        opnInterest:d?.opnInterest??d?.openInterest??d?.oi??null,
        tradeVolume:d?.tradeVolume??d?.volume??null,
        bestFive:d?.depth??d?.bestFive??null};
    }));
    rows=rows.concat(extra.map(x=>x.status==='fulfilled'?x.value:null).filter(Boolean));
  }
  return rows;
}
export async function optionGreeks({name, expirydate}){
  const {jwtToken}=requireSession();
  const endpoint='https://apiconnect.angelone.in/rest/secure/angelbroking/marketData/v1/optionGreek';
  const headers={
    'Content-Type':'application/json',
    'Accept':'application/json',
    'X-PrivateKey':angelApiKey(),
    'Authorization':`Bearer ${jwtToken}`,
    'X-UserType':'USER',
    'X-SourceID':'WEB',
    'X-ClientLocalIP':(process.env.ANGEL_CLIENT_LOCAL_IP || process.env.ANGELONE_CLIENT_LOCAL_IP || '127.0.0.1'),
    'X-ClientPublicIP':(process.env.ANGEL_CLIENT_PUBLIC_IP || process.env.ANGELONE_PUBLIC_IP || '127.0.0.1'),
    'X-MACAddress':(process.env.ANGEL_MAC_ADDRESS || process.env.ANGELONE_MAC_ADDRESS || '00:00:00:00:00:00')
  };
  const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({name,expirydate:normalizeExpiry(expirydate)})});
  const out=await r.json().catch(()=>({status:false,message:'Invalid JSON'}));
  if(!r.ok || out?.status===false) throw new Error(out?.message||`Option Greeks HTTP ${r.status}`);
  return out?.data||[];
}



function secureHeaders(){
  if(!session.jwtToken || !angelApiKey()) throw new Error("Angel One secure session is not ready");
  return {
    'Content-Type':'application/json',
    'Accept':'application/json',
    'X-UserType':'USER',
    'X-SourceID':'WEB',
    'X-PrivateKey':angelApiKey(),
    'Authorization':`Bearer ${session.jwtToken}`,
    'X-ClientLocalIP':(process.env.ANGEL_CLIENT_LOCAL_IP || process.env.ANGELONE_CLIENT_LOCAL_IP) || '127.0.0.1',
    'X-ClientPublicIP':(process.env.ANGEL_CLIENT_PUBLIC_IP || process.env.ANGELONE_PUBLIC_IP) || '127.0.0.1',
    'X-MACAddress':(process.env.ANGEL_MAC_ADDRESS || process.env.ANGELONE_MAC_ADDRESS) || '00:00:00:00:00:00'
  };
}

async function secureJson(url, options={}, retryAuth=true){
  const r=await fetch(url,{...options,headers:{...(options.headers||secureHeaders())},signal:AbortSignal.timeout(8000)});
  const out=await r.json().catch(()=>({status:false,message:`HTTP ${r.status}`}));
  const message=String(out?.message||out?.error||'').toLowerCase();
  const authFailure=(r.status===401||r.status===403||/token|jwt|authoriz|session|login|expired|invalid credential/.test(message));
  if((!r.ok||out?.status===false)&&authFailure&&retryAuth&&session.connected&&session.refreshToken){
    const refreshed=await refreshSessionTokens();
    if(refreshed){
      return await secureJson(url,{...options,headers:secureHeaders()},false);
    }
  }
  if(!r.ok||out?.status===false) throw new Error(out?.message||out?.error||`Angel One HTTP ${r.status}`);
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
  const seg=segment.toUpperCase();
  const targetSeg=ex==='BSE'?'bse_fo':seg==='EQUITY'?'nse_cm':'nse_fo';
  const q=(query||underlying||"").trim().toUpperCase();
  const ot=(optionType||"").trim().toUpperCase();
  const st=strike!=="" && strike!=null ? Number(strike) : null;
  const normSeg=x=>{const s=String(x?.exch_seg||x?.exchange||'').toLowerCase(); if(s==='nse_fo'||s==='nfo')return'nse_fo'; if(s==='bse_fo'||s==='bfo')return'bse_fo'; if(s==='nse_cm'||s==='nse')return'nse_cm'; if(s==='bse_cm'||s==='bse')return'bse_cm'; return s;};
  const arr=items.filter(x=>{
    const sym=String(x.symbol||'').toUpperCase(), name=String(x.name||'').toUpperCase();
    let okSeg=normSeg(x)===targetSeg;
    if(!okSeg && ex==='NSE' && (seg==='OPTIDX'||seg==='OPTSTK') && /(?:CE|PE)$/.test(sym)) okSeg=true;
    if(!okSeg) return false;
    if((seg==='OPTIDX'||seg==='OPTSTK') && !/(?:CE|PE)$/.test(sym)) return false;
    if(q && !(name===q || name.startsWith(q) || sym.startsWith(q) || sym.includes(q))) return false;
    if(underlying && !(name===underlying.toUpperCase() || name.startsWith(underlying.toUpperCase()) || sym.startsWith(underlying.toUpperCase()))) return false;
    if(expiry && String(x.expiry||'').toUpperCase()!==String(expiry).toUpperCase()) return false;
    if(ot && !sym.endsWith(ot)) return false;
    if(st!==null && Number(x.strike)/100!==st && Number(x.strike)!==st) return false;
    return true;
  });
  return arr.slice(0,200).map(x=>({token:x.token,symbol:x.symbol,name:x.name,expiry:x.expiry,strike:x.strike,lotsize:x.lotsize,instrumenttype:x.instrumenttype,exch_seg:x.exch_seg,tick_size:x.tick_size}));
}

async function subscribeOnSocket(tokens, exchangeType=1, mode=1){
  if(!ws || !wsConnected) throw new Error("Angel One WebSocket is not connected");
  const clean=[...new Set((tokens||[]).map(String).filter(Boolean))];
  if(!clean.length) throw new Error("No tokens supplied");
  const req={correlationID:`PTD${Date.now().toString().slice(-7)}`,action:1,mode:Number(mode),exchangeType:Number(exchangeType),tokens:clean};
  ws.fetchData(req);
  return {subscribed:true,tokens:clean.length,exchangeType:Number(exchangeType),mode:Number(mode)};
}

function jwtExpiryMs(token){
  try{
    const part=String(token||'').split('.')[1];
    if(!part) return 0;
    const json=JSON.parse(Buffer.from(part.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
    const exp=Number(json?.exp||0);
    return exp>0?exp*1000:0;
  }catch{return 0;}
}
function marketHoursNow(){
  const d=new Date();
  const s=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
  const m=Object.fromEntries(s.map(x=>[x.type,x.value]));
  const mins=Number(m.hour)*60+Number(m.minute);
  return !['Sat','Sun'].includes(m.weekday) && mins>=555 && mins<940;
}
async function refreshSessionTokens(){
  if(refreshPromise) return await refreshPromise;
  if(!session.connected || !session.refreshToken || !angelApiKey()) return false;
  if(Date.now()-lastRefreshAt<90000) return false;
  lastRefreshAt=Date.now();
  refreshPromise=(async()=>{
    try{
      // SmartAPI refresh tokens rotate. Only one refresh may run at a time;
      // concurrent REST/WS failures must wait for the same refresh result.
      const out=api && typeof api.generateToken==='function'
        ? await api.generateToken(session.refreshToken)
        : null;
      if(!out?.status || !out?.data?.jwtToken || !out?.data?.feedToken){
        throw new Error(out?.message||'Angel One token refresh failed');
      }
      session.jwtToken=out.data.jwtToken;
      session.refreshToken=out.data.refreshToken||session.refreshToken;
      session.feedToken=out.data.feedToken;
      try{ api?.setAccessToken?.(session.jwtToken); }catch{}
      try{ api?.setRefreshToken?.(session.refreshToken); }catch{}
      try{ api?.setFeedToken?.(session.feedToken); }catch{}
      // Replace the old socket exactly once after a successful token rotation.
      wsConnected=false; wsError=null;
      try{ if(ws){ws.close?.();ws.closeConnection?.();} }catch{}
      ws=null;
      await connectMarketWebSocket();
      console.log('[ANGEL_AUTH] token refreshed + websocket restored');
      scheduleTokenRefresh();
      return true;
    }catch(e){
      wsError=e?.message||'Angel One token refresh failed';
      console.warn('[ANGEL_AUTH] refresh failed:',wsError);
      scheduleTokenRefresh(60000);
      return false;
    }finally{
      refreshPromise=null;
    }
  })();
  return await refreshPromise;
}
function scheduleTokenRefresh(delayOverride=0){
  if(tokenRefreshTimer){clearTimeout(tokenRefreshTimer);tokenRefreshTimer=null;}
  if(!session.connected) return;
  const exp=jwtExpiryMs(session.jwtToken);
  let delay=Number(delayOverride)>0?Number(delayOverride):(exp?Math.max(60000,exp-Date.now()-120000):30*60*1000);
  delay=Math.min(Math.max(delay,60000),55*60*1000);
  tokenRefreshTimer=setTimeout(async()=>{tokenRefreshTimer=null;await refreshSessionTokens();},delay);
}
function startConnectionGuards(){
  scheduleTokenRefresh();
  if(watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer=setInterval(async()=>{
    if(!session.connected) return;
    if(!wsConnected){scheduleReconnect();return;}
    if(marketHoursNow() && (!lastTickAt || Date.now()-lastTickAt>75000)){
      wsConnected=false;
      wsError='Live tick stale — reconnecting automatically';
      try{if(ws){ws.close?.();ws.closeConnection?.();}}catch{}
      ws=null;
      scheduleReconnect();
    }
  },10000);
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
  if(wsConnectPromise) return await wsConnectPromise;
  wsConnectPromise=(async()=>{
    wsConnectBusy=true;
    try{
      if(ws){ try{ws.close?.(); ws.closeConnection?.()}catch{}; ws=null; }
      wsGeneration++;
      wsConnected=false; wsError=null;

      const generation=++wsGeneration;
      const socket=new WebSocketV2({
        jwttoken:session.jwtToken,
        apikey:angelApiKey(),
        clientcode:session.clientCode,
        feedtype:session.feedToken
      });
      ws=socket;

      try{ socket.customError?.(); }catch{}
      try{
        socket.on('tick', data=>{
          if(generation!==wsGeneration || ws!==socket) return;
          try{
            const token=String(data?.token ?? data?.symbolToken ?? data?.symboltoken ?? JSON.stringify(data));
            latestTicks.set(token,{data,at:Date.now()});
            lastTickAt=Date.now();
            wsConnected=true;
            wsError=null;
          }catch{}
        });
      }catch{}

      console.log('[ANGEL_WS] connecting client='+String(session.clientCode||'').slice(0,24));
      const timeoutMs=12000;
      await Promise.race([
        socket.connect(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Angel One WebSocket connect timeout after 12 seconds')),timeoutMs))
      ]);

      // A newer connection may have replaced this socket while it was connecting.
      if(generation!==wsGeneration || ws!==socket) throw new Error('Stale WebSocket connection discarded');
      wsConnected=true;
      wsError=null;
      console.log('[ANGEL_WS] connected');

      const sub=await subscribeOnSocket(["99926000","99926009","99926017","99926037","99926074"],1,1);
      console.log('[ANGEL_WS] subscribed index tokens='+sub.tokens);
      return angelStatus();
    }catch(e){
      wsConnected=false;
      wsError=e?.message||'Angel One WebSocket connection failed';
      try{if(ws){ws.close?.();ws.closeConnection?.();}}catch{}
      ws=null;
      throw e;
    }finally{
      wsConnectBusy=false;
      wsConnectPromise=null;
    }
  })();
  return await wsConnectPromise;
}
export async function reconnectWebSocket(){
  if(!session.connected) throw new Error("Angel One is not connected");
  return await connectMarketWebSocket();
}

export async function subscribe(tokens, exchangeType=2, mode=1){
  if(!session.connected || !session.jwtToken || !session.feedToken) throw new Error("Angel One session is not connected");
  if(!ws || !wsConnected) await connectMarketWebSocket();
  return await subscribeOnSocket(tokens,exchangeType,mode);
}
/* PARTHAVI TRADE DESK PRO — Phase 12 Production Readiness
   Readiness is deliberately conservative: it reports what is configured, never fabricates a live connection.
*/

function b(v, d=false){ if(v==null) return d; return ['1','true','yes','on'].includes(String(v).trim().toLowerCase()); }
function present(v){ return Boolean(v && !/^replace_|^change_me|^your_/i.test(String(v).trim())); }
function productionReadiness({angelConnected=false, marketOpen=false, exchange='NSE', marketDataFresh=false}={}){
  const env={
    apiKey: present(process.env.ANGEL_API_KEY || process.env.ANGELONE_API_KEY),
    clientCode: present(process.env.ANGEL_CLIENT_CODE || process.env.ANGELONE_CLIENT_CODE),
    phase11Secret: present(process.env.PHASE11_SECRET),
    httpsConfigured: b(process.env.FORCE_HTTPS,false) || b(process.env.ALLOW_HTTP_LOCAL,true),
    orderExecution: b(process.env.ORDER_EXECUTION_ENABLED,false),
    staticIpVerified: b(process.env.STATIC_IP_VERIFIED,false),
    bseSessionVerified: b(process.env.BSE_SESSION_VERIFIED,false),
    killSwitch: b(process.env.TRADING_KILL_SWITCH,true)
  };
  const checks=[
    {id:'ENV_API_KEY',ok:env.apiKey,label:'Angel One API key configured'},
    {id:'ENV_CLIENT_CODE',ok:env.clientCode,label:'Angel One client code configured'},
    {id:'PHASE11_SECRET',ok:env.phase11Secret,label:'Signed confirmation secret configured'},
    {id:'ANGEL_SESSION',ok:Boolean(angelConnected),label:'Angel One session connected'},
    {id:'MARKET_SESSION',ok:Boolean(marketOpen),label:`${exchange} session open`},
    {id:'MARKET_TICK_FRESH',ok:!marketOpen || Boolean(marketDataFresh),label:'Fresh exchange-timestamped tick (required during session)'},
    {id:'STATIC_IP',ok:env.staticIpVerified,label:'Registered static IP verified'},
    {id:'ORDER_EXECUTION',ok:env.orderExecution,label:'Server order execution enabled'},
    {id:'KILL_SWITCH',ok:!env.killSwitch,label:'Trading kill switch is OFF'},
    {id:'BSE_SESSION',ok:exchange!=='BSE' || env.bseSessionVerified,label:'BSE session adapter verified'},
    {id:'HTTPS',ok:env.httpsConfigured,label:'HTTPS/local mode configured'}
  ];
  const liveReady=checks.every(x=>x.ok);
  return {phase:12,mode:liveReady?'GO-LIVE READY':'LOCKED',liveReady,exchange,checks,asOf:new Date().toISOString(),safety:{noSecretExposure:true,noGuaranteedProfit:true,explicitUserConfirmationRequired:true}};
}
export {productionReadiness};
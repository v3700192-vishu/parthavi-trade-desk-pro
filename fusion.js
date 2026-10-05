/*
  PARTHAVI TRADE DESK PRO — Phase 4 Market Fusion
  Provider-agnostic news/global/event adapters + deterministic scoring.
  This module never invents live headlines or prices.
*/

const SOURCE_WEIGHTS = [
  [/\b(nse|bse|sebi|rbi|pib|finance ministry|imf|fed|ecb|boj)\b/i, 1.0],
  [/reuters|bloomberg|cnbc|financial times/i, 0.95],
  [/economic times|moneycontrol|business standard|mint|livemint|investing/i, 0.85],
];

const POS = [
  [/rate cut|cuts rates|eases|dovish|disinflation|cooling inflation|strong earnings|profit rises|beats estimates|buyback|capex|order win|upgrade|inflow|fii buying|record high|stimulus|growth improves/i, 1],
  [/bullish|positive|surge|rally|beat|strong|inflows|optimism/i, 0.55]
];
const NEG = [
  [/rate hike|hikes rates|hawkish|hot inflation|inflation rises|weak earnings|profit falls|misses estimates|downgrade|outflow|fii selling|default|sanction|war|escalation|recession|tariff|crash|selloff/i, 1],
  [/bearish|negative|slump|drop|fall|weak|outflows|risk-off/i, 0.55]
];

function n(v, d=null){ const x=Number(v); return Number.isFinite(x)?x:d; }
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function pctToFreshness(ageMin, halfLife){ if(!Number.isFinite(ageMin)) return 0; return clamp(Math.exp(-Math.max(0,ageMin)/halfLife),0,1); }
function ageMinutes(ts){ if(!ts) return Infinity; const t=new Date(ts).getTime(); return Number.isFinite(t)?Math.max(0,(Date.now()-t)/60000):Infinity; }
function sourceWeight(source=''){ for(const [re,w] of SOURCE_WEIGHTS) if(re.test(source)) return w; return 0.7; }
function lexicalScore(title=''){
  let s=0; for(const [re,w] of POS) if(re.test(title)) s+=w; for(const [re,w] of NEG) if(re.test(title)) s-=w; return clamp(s,-2,2);
}
function relevance(title, symbol='NIFTY'){
  const t=String(title).toUpperCase(), s=String(symbol).toUpperCase();
  const direct = s==='NIFTY' ? /NIFTY|SENSEX|INDEX|INDIA|RBI|FI[IIT]|CRUDE|USD|RUPEE|FED|US10Y|VIX/.test(t) : t.includes(s);
  const macro = /RBI|FED|INFLATION|CPI|GDP|CRUDE|BRENT|RUPEE|USD|BOND|YIELD|TARIFF|WAR|SANCTION|FII|DII|VIX|GLOBAL/.test(t);
  return direct ? 1 : (macro ? 0.72 : 0.35);
}
function normalizeNews(raw, symbol='NIFTY'){
  const arr=Array.isArray(raw)?raw:(raw?.items||raw?.articles||raw?.data||[]);
  return arr.map((x,i)=>{
    const title=String(x.title||x.headline||x.name||'').trim();
    const source=String(x.source?.name||x.source||x.publisher||'').trim();
    const publishedAt=x.publishedAt||x.pubDate||x.time||x.timestamp||x.published_at;
    const supplied=String(x.sentiment||x.bias||'').toLowerCase();
    const l=lexicalScore(title);
    let bias=supplied.includes('bull')||supplied.includes('positive')?1:supplied.includes('bear')||supplied.includes('negative')?-1:Math.sign(l);
    const lex=Math.abs(l)>0?l:bias;
    const age=ageMinutes(publishedAt);
    const fresh=pctToFreshness(age, 45);
    const rel=relevance(title,symbol);
    const impact=String(x.impact||x.importance||'').toUpperCase() || (Math.abs(lex)>=1?'HIGH':'MEDIUM');
    const score=clamp(lex*sourceWeight(source)*fresh*rel*50,-100,100);
    return {id:x.id||`${i}-${title.slice(0,24)}`,title,source,publishedAt,ageMin:Number.isFinite(age)?Number(age.toFixed(1)):null,bias:score>15?'BULLISH':score<-15?'BEARISH':'NEUTRAL',score:Number(score.toFixed(1)),relevance:Number(rel.toFixed(2)),freshness:Number(fresh.toFixed(2)),impact};
  }).filter(x=>x.title).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score));
}
function analyzeNews(items){
  const xs=items||[]; if(!xs.length) return {connected:false,score:0,bias:'WAIT',confidence:0,highImpact:false,hardBlock:false,reason:'News feed not connected or no relevant fresh headlines.'};
  const top=xs.slice(0,12);
  const pos=top.filter(x=>x.score>10).reduce((a,x)=>a+x.score,0);
  const neg=top.filter(x=>x.score<-10).reduce((a,x)=>a+Math.abs(x.score),0);
  const gross=pos+neg; const score=gross?clamp(((pos-neg)/gross)*100,-100,100):0;
  const conflict=pos>25&&neg>25&&Math.abs(score)<25;
  const highImpact=top.some(x=>x.impact==='HIGH'&&x.freshness>=0.35);
  return {connected:true,score:Number(score.toFixed(1)),bias:conflict?'MIXED':score>20?'BULLISH':score<-20?'BEARISH':'NEUTRAL',confidence:Number(clamp(gross/2,0,100).toFixed(0)),highImpact,hardBlock:false,conflict,top:top.slice(0,6),reason:conflict?'Fresh headlines are materially conflicting; news bias is neutralized.':highImpact?'Fresh high-impact news is present; the engine applies a caution modifier.':'Fresh market-relevant headlines were scored by source, relevance and recency.'};
}

const GLOBAL_RULES={
  GIFT_NIFTY:{sign:1,weight:1.0}, US_FUTURES:{sign:1,weight:.8}, ASIA:{sign:1,weight:.6}, USDINR:{sign:-1,weight:.45}, US10Y:{sign:-1,weight:.35}, BRENT:{sign:-1,weight:.3}, GOLD:{sign:-1,weight:.15}, VIX:{sign:-1,weight:.8}
};
function normalizeGlobal(raw){
  const x=raw||{}; const aliases={GIFT_NIFTY:['GIFT_NIFTY','GIFT NIFTY'],US_FUTURES:['US_FUTURES','US FUTURES','SPX_FUT','NASDAQ_FUT'],ASIA:['ASIA'],USDINR:['USDINR','USD/INR'],US10Y:['US10Y','US 10Y'],BRENT:['BRENT'],GOLD:['GOLD'],VIX:['VIX','VIX / RISK']};
  const out={};
  for(const [k,keys] of Object.entries(aliases)){
    let v=null; for(const key of keys){ if(x[key]!=null){v=x[key];break;} }
    const value=typeof v==='object' && v!==null ? (v.value??v.ltp??v.price) : v;
    const change=typeof v==='object' && v!==null ? n(v.changePct??v.changePercent??v.pct??v.change) : null;
    out[k]={value:value??'WAIT',change, tone:change>0.1?'up':change<-0.1?'down':'flat'};
  }
  return out;
}
function analyzeGlobal(global){
  const parts=[]; let weighted=0,wsum=0;
  for(const [k,r] of Object.entries(global||{})){
    const c=n(r.change); const rule=GLOBAL_RULES[k];
    if(c==null||!rule) continue;
    const contribution=clamp(c,-5,5)*rule.sign*rule.weight; weighted+=contribution; wsum+=rule.weight*5;
    parts.push({key:k,change:c,contribution:Number(contribution.toFixed(2))});
  }
  if(!parts.length) return {connected:false,score:0,bias:'WAIT',confidence:0,hardRisk:false,reason:'Global market feeds not connected.'};
  const score=clamp((weighted/wsum)*100,-100,100); const hardRisk=Math.abs(score)>=70;
  return {connected:true,score:Number(score.toFixed(1)),bias:score>18?'RISK-ON':score<-18?'RISK-OFF':'MIXED',confidence:Math.round(clamp(parts.length/8*100,0,100)),hardRisk,parts,reason:hardRisk?'Global risk is extreme; the engine tightens trade gates.':'Global conditions are incorporated as a secondary risk modifier.'};
}
function analyzeEvents(raw){
  const arr=Array.isArray(raw)?raw:(raw?.items||raw?.events||raw?.data||[]);
  const events=arr.map(x=>({label:String(x.label||x.title||x.name||'Event'),time:x.time||x.datetime||x.timestamp||x.start||'',risk:String(x.risk||x.impact||x.importance||'WATCH').toUpperCase()})).filter(x=>x.label);
  const now=Date.now(); let hardBlock=false,watch=false;
  for(const e of events){ const t=new Date(e.time).getTime(); if(!Number.isFinite(t)) continue; const mins=(t-now)/60000; const hi=['HIGH','RED','CRITICAL'].includes(e.risk); if(hi&&mins>=0&&mins<=15) hardBlock=true; else if(hi&&mins>=0&&mins<=60) watch=true; }
  return {connected:events.length>0,events,hardBlock,watch,reason:hardBlock?'High-impact event inside 15 minutes: NO TRADE gate.':watch?'High-impact event inside 60 minutes: caution modifier.':'No imminent high-impact event detected from the connected calendar.'};
}
function fuse({technicalScore=0,newsScore=0,globalScore=0,eventRisk=false,marketOpen=true,feeds={}}={}){
  // Phase 4 modifies, never overrides, the existing technical model.
  // News +8%, global +6%, technical retains 86%; event risk is a hard gate when imminent.
  const tech=clamp(technicalScore,-100,100);
  const raw=clamp(tech*.86+clamp(newsScore,-100,100)*.08+clamp(globalScore,-100,100)*.06,-100,100);
  const gate=!marketOpen||eventRisk||!feeds.market||!feeds.options||!feeds.news||!feeds.global;
  return {score:Number(raw.toFixed(1)),direction:raw>20?'BULLISH':raw<-20?'BEARISH':'NEUTRAL',hardGate:gate};
}

export {normalizeNews,analyzeNews,normalizeGlobal,analyzeGlobal,analyzeEvents,fuse};
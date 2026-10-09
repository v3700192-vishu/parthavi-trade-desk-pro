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
    const status=age===Infinity?'UNVERIFIED':age<=15?'LIVE':age<=180?'DELAYED':'UNVERIFIED';
    const score=clamp(lex*sourceWeight(source)*fresh*rel*50,-100,100);
    return {id:x.id||`${i}-${title.slice(0,24)}`,title,source,publishedAt,ageMin:Number.isFinite(age)?Number(age.toFixed(1)):null,status,bias:score>15?'BULLISH':score<-15?'BEARISH':'NEUTRAL',score:Number(score.toFixed(1)),relevance:Number(rel.toFixed(2)),freshness:Number(fresh.toFixed(2)),impact};
  }).filter(x=>x.title).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score));
}
function analyzeNews(items){
  const all=items||[];
  const xs=all.filter(x=>(x.status==='LIVE'||x.status==='DELAYED') && Number.isFinite(Number(x.ageMin)) && Number(x.ageMin)<=180);
  if(!xs.length) return {connected:false,score:0,bias:'WAIT',confidence:0,highImpact:false,hardBlock:false,reason:'No fresh verified news headlines available.',freshCount:0,totalCount:all.length};
  const top=xs.slice(0,12);
  const pos=top.filter(x=>x.score>10).reduce((a,x)=>a+x.score,0);
  const neg=top.filter(x=>x.score<-10).reduce((a,x)=>a+Math.abs(x.score),0);
  const gross=pos+neg; const score=gross?clamp(((pos-neg)/gross)*100,-100,100):0;
  const conflict=pos>25&&neg>25&&Math.abs(score)<25;
  const highImpact=top.some(x=>x.impact==='HIGH'&&x.freshness>=0.35);
  const liveCount=top.filter(x=>x.status==='LIVE').length;
  const delayedCount=top.filter(x=>x.status==='DELAYED').length;
  return {
    connected:true,
    score:Number(score.toFixed(1)),
    bias:conflict?'MIXED':score>20?'BULLISH':score<-20?'BEARISH':'NEUTRAL',
    confidence:Number(clamp(gross/2,0,100).toFixed(0)),
    highImpact,
    hardBlock:false,
    conflict,
    top:top.slice(0,6),
    freshCount:xs.length,
    liveCount,
    delayedCount,
    reason:conflict?'Fresh headlines are materially conflicting; news bias is neutralized.':highImpact?'Fresh high-impact news is present; the engine applies a caution modifier.':'Fresh market-relevant headlines were scored by source, relevance and recency.'
  };
}

const GLOBAL_RULES={
  GIFT_NIFTY:{sign:1,weight:1.0}, US_FUTURES:{sign:1,weight:.8}, ASIA:{sign:1,weight:.6}, USDINR:{sign:-1,weight:.45}, US10Y:{sign:-1,weight:.35}, BRENT:{sign:-1,weight:.3}, GOLD:{sign:-1,weight:.15}, VIX:{sign:-1,weight:.8}
};
function normalizeGlobal(raw){
  const x=raw||{};
  const aliases={GIFT_NIFTY:['GIFT_NIFTY','GIFT NIFTY'],US_FUTURES:['US_FUTURES','US FUTURES','SPX_FUT','NASDAQ_FUT'],ASIA:['ASIA'],USDINR:['USDINR','USD/INR'],US10Y:['US10Y','US 10Y'],BRENT:['BRENT'],GOLD:['GOLD'],VIX:['VIX','VIX / RISK']};
  const out={};
  for(const [k,keys] of Object.entries(aliases)){
    let v=null; for(const key of keys){ if(x[key]!=null){v=x[key];break;} }
    const obj=typeof v==='object' && v!==null ? v : {value:v};
    const value=obj.value??obj.ltp??obj.price;
    const rawChange=obj.changePct??obj.changePercent??obj.pct??obj.change;
    const change=(rawChange===null||rawChange===undefined||rawChange==='')?null:n(rawChange);
    const asOf=obj.asOf??obj.timestamp??obj.time??null;
    const rawAgeSec=obj.ageSec;
    const ageMin=(rawAgeSec===null||rawAgeSec===undefined||rawAgeSec==='')?ageMinutes(asOf)
      : (Number.isFinite(Number(rawAgeSec))?Math.max(0,Number(rawAgeSec))/60:ageMinutes(asOf));
    const status=String(obj.status||'').toUpperCase() || (ageMin===Infinity?'UNVERIFIED':ageMin<=10?'LIVE':ageMin<=240?'DELAYED':'UNVERIFIED');
    const usableValue=value!==null && value!==undefined && value!=='WAIT' && value!=='';
    const usableChange=Number.isFinite(Number(change));
    out[k]={
      value:usableValue?value:'WAIT',
      change:usableChange?Number(change):null,
      tone:usableChange?(Number(change)>0.1?'up':Number(change)<-0.1?'down':'flat'):'flat',
      source:obj.source??'UNKNOWN',
      asOf,
      ageMin:ageMin===Infinity?null:Number(ageMin.toFixed(1)),
      status,
      reason:obj.reason??null
    };
  }
  return out;
}
function analyzeGlobal(global){
  const parts=[]; let weighted=0,wsum=0;
  const freshKeys=[];
  for(const [k,r] of Object.entries(global||{})){
    const c=n(r.change); const rule=GLOBAL_RULES[k];
    const age=Number(r.ageMin);
    const status=String(r.status||'UNVERIFIED').toUpperCase();
    const fresh=(status==='LIVE'||status==='DELAYED') && Number.isFinite(age) && age<=240;
    if(!fresh||c==null||!rule||r.value==='WAIT') continue;
    const contribution=clamp(c,-5,5)*rule.sign*rule.weight;
    weighted+=contribution; wsum+=rule.weight*5;
    freshKeys.push(k);
    parts.push({key:k,change:c,contribution:Number(contribution.toFixed(2)),status,ageMin:Number(age.toFixed(1)),source:r.source||'UNKNOWN'});
  }
  if(!parts.length) return {
    connected:false,score:0,bias:'WAIT',confidence:0,hardRisk:false,parts:[],
    freshInputs:0,liveInputs:0,delayedInputs:0,
    reason:'No fresh verified global market changes are available. Stale/unverified inputs are excluded from the trade gate.'
  };
  const score=clamp((weighted/wsum)*100,-100,100);
  const hardRisk=Math.abs(score)>=70;
  const liveInputs=parts.filter(x=>x.status==='LIVE').length;
  const delayedInputs=parts.filter(x=>x.status==='DELAYED').length;
  return {
    connected:true,
    score:Number(score.toFixed(1)),
    bias:score>18?'RISK-ON':score<-18?'RISK-OFF':'MIXED',
    confidence:Math.round(clamp(parts.length/8*100,0,100)),
    hardRisk,
    parts,
    freshInputs:parts.length,
    liveInputs,
    delayedInputs,
    reason:hardRisk?'Global risk is extreme; the engine tightens trade gates.':'Global conditions are incorporated as a secondary risk modifier. Only fresh LIVE/DELAYED inputs are scored.'
  };
}
function istDateKey(ts){
  const d=new Date(ts);
  if(Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
function analyzeEvents(raw){
  const arr=Array.isArray(raw)?raw:(raw?.items||raw?.events||raw?.data||[]);
  const events=arr.map(x=>({
    label:String(x.label||x.title||x.name||'Event'),
    time:x.time||x.datetime||x.timestamp||x.start||'',
    risk:String(x.risk||x.impact||x.importance||'WATCH').toUpperCase()
  })).filter(x=>x.label);
  const now=Date.now();
  const today=istDateKey(now);
  let hardBlock=false,watch=false,eventDayBlock=false,unverifiedHighImpact=false;
  const highImpact=[];
  for(const e of events){
    const t=new Date(e.time).getTime();
    const hi=['HIGH','RED','CRITICAL'].includes(e.risk);
    if(!hi) continue;
    highImpact.push(e);
    if(!Number.isFinite(t)){unverifiedHighImpact=true;continue;}
    const eventDate=istDateKey(t);
    const mins=(t-now)/60000;
    if(eventDate && eventDate===today) eventDayBlock=true;
    if(mins>=0&&mins<=15) hardBlock=true;
    else if(mins>=0&&mins<=60) watch=true;
  }
  const connected=events.length>0;
  const eventSafe=connected && !hardBlock && !eventDayBlock && !unverifiedHighImpact;
  return {
    connected,
    events,
    hardBlock,
    watch,
    eventDayBlock,
    unverifiedHighImpact,
    eventSafe,
    highImpactCount:highImpact.length,
    reason:!connected
      ? 'Economic-event calendar is not connected or returned no usable events. Event safety is UNKNOWN; new entries stay blocked.'
      : unverifiedHighImpact
        ? 'A high-impact event has no verified timestamp. Event safety is UNKNOWN; new entries stay blocked.'
        : eventDayBlock
          ? 'High-impact event day detected (e.g. RBI/Fed/Budget-type event): NO TRADE for the session.'
          : hardBlock
            ? 'High-impact event inside 15 minutes: NO TRADE gate.'
            : watch
              ? 'High-impact event inside 60 minutes: caution modifier.'
              : 'Calendar data is connected; no high-impact event block was detected in the current session.'; 
  };
}

function fuse({technicalScore=0,newsScore=0,globalScore=0,eventRisk=false,marketOpen=true,feeds={}}={}){
  // Phase 4 modifies, never overrides, the existing technical model.
  // News +8%, global +6%, technical retains 86%; event risk is a hard gate when imminent.
  const tech=clamp(technicalScore,-100,100);
  const raw=clamp(tech*.86+clamp(newsScore,-100,100)*.08+clamp(globalScore,-100,100)*.06,-100,100);
  const gate=!marketOpen||eventRisk||feeds.eventDayBlock||!feeds.market||!feeds.options||!feeds.news||!feeds.global;
  return {score:Number(raw.toFixed(1)),direction:raw>20?'BULLISH':raw<-20?'BEARISH':'NEUTRAL',hardGate:gate};
}

export {normalizeNews,analyzeNews,normalizeGlobal,analyzeGlobal,analyzeEvents,fuse};
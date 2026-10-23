const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26','2026-03-03','2026-03-26','2026-03-31','2026-04-03','2026-04-14','2026-05-01',
  '2026-05-28','2026-06-26','2026-09-14','2026-10-02','2026-10-20','2026-11-10','2026-11-24','2026-12-25'
]);
function istParts(now=new Date()){
  const p=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hour12:false}).formatToParts(now);
  return Object.fromEntries(p.map(z=>[z.type,z.value]));
}
function configuredDates(name){
  return new Set(String(process.env[name]||'').split(',').map(x=>x.trim()).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)));
}
function boolEnv(name,fallback=false){
  const raw=process.env[name];
  if(raw==null||String(raw).trim()==='') return fallback;
  return ['1','true','yes','on'].includes(String(raw).trim().toLowerCase());
}
export function exchangeSessionOpen(exchange='NSE',now=new Date()){
  const x=istParts(now),date=x.year+'-'+x.month+'-'+x.day,day=x.weekday,mins=Number(x.hour)*60+Number(x.minute);
  if(['Sat','Sun'].includes(day)||mins<555||mins>=940) return false;
  const ex=String(exchange||'NSE').toUpperCase();
  const extra=configuredDates('EXTRA_HOLIDAYS_IST');
  if(ex==='NSE'&&(NSE_HOLIDAYS_2026.has(date)||extra.has(date))) return false;
  if(ex==='BSE'){
    const bseExtra=configuredDates('BSE_HOLIDAYS_IST');
    if(!boolEnv('BSE_SESSION_VERIFIED',false)) return false;
    if(bseExtra.has(date)||extra.has(date)) return false;
  }
  return true;
}
export function nseSessionOpen(now=new Date()){ return exchangeSessionOpen('NSE',now); }
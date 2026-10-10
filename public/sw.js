const CACHE='ptd-shell-v4';
const SHELL=['/','/manifest.webmanifest','/icon.svg','/mobile-haptics.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET') return;
  const u=new URL(r.url);
  if(u.pathname.startsWith('/api/')) return; // live data must always hit the server
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put('/',copy));return res}).catch(()=>caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{if(res.ok&&u.origin===location.origin){const copy=res.clone();caches.open(CACHE).then(c=>c.put(r,copy))}return res})));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const win=list.find(c=>c.url&&new URL(c.url).origin===self.location.origin);
    if(win) return win.focus();
    return clients.openWindow('/');
  }).catch(()=>{}));
});
// PINNED KOREA service worker: network first, cached page as offline fallback. /api and map tiles are never cached here.
const C='pk-shell-v1';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/favicon.svg','/icon-192.png'])).catch(()=>{}));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
 if(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const y=x.clone();caches.open(C).then(c=>c.put('/',y));return x;}).catch(()=>caches.match('/')));return;}
 e.respondWith(fetch(r).then(x=>{if(x.ok&&/\.(css|js|json|png|svg|jpg|woff2?)$/.test(u.pathname)){const y=x.clone();caches.open(C).then(c=>c.put(r,y));}return x;}).catch(()=>caches.match(r)));});

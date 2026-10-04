/* IPO Ledger — service worker
   Handles: basic offline fetch fallback, and Periodic Background Sync so
   Android can check for IPOs closing today / allotment today and fire a
   real system notification even if the app hasn't been opened that day.
   Chrome decides the actual wake frequency (not a guaranteed exact time) —
   see https://developer.chrome.com/docs/capabilities/periodic-background-sync
*/

const DB_NAME = 'ipo_ledger_db';
const DB_VERSION = 1;

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
    // No onupgradeneeded here deliberately — the main app page owns schema
    // creation. If this runs before the app has ever been opened, the
    // database simply won't exist yet and getAll() below will return
    // nothing, which is handled gracefully.
  });
}

function idbAll(db, store){
  return new Promise((resolve, reject) => {
    try{
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    }catch(e){ resolve([]); } // store may not exist yet on a brand-new DB
  });
}

function todayStr(){ return new Date().toISOString().slice(0,10); }
function daysDiff(dateStr){
  if(!dateStr) return null;
  const today = new Date(todayStr()+'T00:00:00');
  const d = new Date(dateStr+'T00:00:00');
  if(isNaN(d)) return null;
  return Math.round((d - today) / 86400000);
}

async function checkAndNotify(){
  let db;
  try{ db = await openDB(); } catch(e){ return; } // app never opened yet on this device — nothing to check
  const ipos = await idbAll(db, 'ipos');
  if(!ipos.length) return;

  // Avoid re-notifying for the same item on the same day across multiple
  // background wakes — tracked via the Cache Storage API, since a service
  // worker has no access to localStorage.
  const cache = await caches.open('ipo-ledger-notified');
  const seenReq = new Request('https://ipo-ledger.local/notified-keys');
  let seen = [];
  const cached = await cache.match(seenReq);
  if(cached) seen = await cached.json();
  const seenSet = new Set(seen);

  const toNotify = [];
  for(const ipo of ipos){
    const closeD = daysDiff(ipo.closeDate);
    const allotD = daysDiff(ipo.allotmentDate);
    if(closeD === 0){
      const gmpTag = ipo.gmpPercent != null ? ` (GMP ${Number(ipo.gmpPercent)>0?'+':''}${ipo.gmpPercent}%)` : '';
      const key = `close:${ipo.id}:${todayStr()}`;
      if(!seenSet.has(key)) toNotify.push({ key, title: `${ipo.name} closes today${gmpTag}`, body: 'Last day to apply.' });
    }
    if(allotD === 0){
      const key = `allot:${ipo.id}:${todayStr()}`;
      if(!seenSet.has(key)) toNotify.push({ key, title: `${ipo.name} — allotment day`, body: 'Check allotment if available.' });
    }
  }

  for(const item of toNotify){
    try{
      await self.registration.showNotification(item.title, { body: item.body, tag: item.key });
      seenSet.add(item.key);
    }catch(e){ /* ignore individual failures, keep going */ }
  }

  if(toNotify.length){
    const trimmed = Array.from(seenSet).slice(-200);
    await cache.put(seenReq, new Response(JSON.stringify(trimmed)));
  }
}

self.addEventListener('periodicsync', (event) => {
  if(event.tag === 'ipo-daily-check'){
    event.waitUntil(checkAndNotify());
  }
});

// Also respond to a one-off 'sync' (Background Sync, broader support) as a
// fallback trigger path, and to a manual test message from the page.
self.addEventListener('sync', (event) => {
  if(event.tag === 'ipo-daily-check'){
    event.waitUntil(checkAndNotify());
  }
});
self.addEventListener('message', (event) => {
  if(event.data === 'check-now'){
    event.waitUntil(checkAndNotify());
  }
});

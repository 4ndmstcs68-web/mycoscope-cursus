// sw.js — MycoScope PWA Service Worker v2.0
// Offline-first cache + Push Notifications + Background Sync

const CACHE = 'mycoscope-v2';
const OFFLINE_URLS = ['./', './index.html', './cursus.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.includes('cursus')) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request))
  );
});

// ─── Push notifications ───────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let data; try { data = e.data.json(); } catch { data = { type: 'reminder', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(...buildNotif(data)));
});

function buildNotif(data) {
  const base = { icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', vibrate: [100,50,100], timestamp: Date.now() };
  switch (data.type) {
    case 'streak_reminder': return [`🔥 ${data.streak} dagen streak!`, { ...base, body: `Nog één les vandaag?`, tag: 'streak', data: { url: '/cursus', lessonId: data.nextLesson }, actions: [{ action: 'open', title: '▶ Doorgaan' }, { action: 'later', title: 'Later' }] }];
    case 'streak_save': return [`⚡ Sla je streak op!`, { ...base, body: `${data.minutesLeft} minuten voor middernacht.`, tag: 'streak-save', data: { url: '/cursus', lessonId: data.nextLesson }, actions: [{ action: 'open', title: '▶ Nu even' }, { action: 'dismiss', title: 'Morgen' }], requireInteraction: true }];
    case 'new_unit': return [`📚 Nieuwe unit: ${data.unitTitle}`, { ...base, body: data.body || 'Staat klaar om te beginnen.', tag: 'new-content', data: { url: '/cursus' }, requireInteraction: true }];
    case 'lab_tip': return [`🔬 Lab-tip van de dag`, { ...base, body: data.tip, tag: 'lab-tip', data: { url: data.url || '/cursus' } }];
    case 'unit_complete': return [`🏆 ${data.unitTitle} voltooid!`, { ...base, body: `+${data.xp} XP verdiend. Ga zo door!`, tag: 'achievement', vibrate: [200,100,200,100,200] }];
    default: return [data.title || 'MycoScope', { ...base, body: data.body || '', data: { url: data.url || '/cursus' } }];
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'later') { setTimeout(() => self.registration.showNotification('⏰ Nog 30 min', { body: 'Nog even en dan?', icon: '/icons/icon-192.png' }), 30 * 60 * 1000); return; }
  if (e.action === 'dismiss') return;
  const url = (e.notification.data || {}).url || '/cursus';
  const lessonId = (e.notification.data || {}).lessonId;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
      const w = ws.find(c => c.url.includes(self.location.origin));
      if (w) { w.focus(); if (lessonId) w.postMessage({ type: 'navigate', lessonId }); return; }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'sync-progress') e.waitUntil(syncProgress());
});

async function syncProgress() {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('mycoscope-progress', 1);
      r.onupgradeneeded = ev => { const db = ev.target.result; if (!db.objectStoreNames.contains('unsynced')) db.createObjectStore('unsynced', { keyPath: 'id', autoIncrement: true }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('unsynced', 'readonly');
    const items = await new Promise(res => { const req = tx.objectStore('unsynced').getAll(); req.onsuccess = () => res(req.result); });
    if (!items.length) return;
    const resp = await fetch('/api/progress/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    if (resp.ok) { const tx2 = db.transaction('unsynced', 'readwrite'); tx2.objectStore('unsynced').clear(); }
  } catch(e) { console.warn('Sync failed:', e); }
}

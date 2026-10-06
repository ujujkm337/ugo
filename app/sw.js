/* УГО — service worker. Приложение полностью офлайн: кешируем оболочку,
   данные и все 18 страниц оригинала стандарта; сеть не используется вообще. */
const CACHE = 'ugo-v2';
const SHELL = [
  './', './index.html', './styles.css',
  './symbols.js', './plan-symbols.js', './circuit.js', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './gost/p01.jpg',
  './gost/p02.jpg',
  './gost/p03.jpg',
  './gost/p04.jpg',
  './gost/p05.jpg',
  './gost/p06.jpg',
  './gost/p07.jpg',
  './gost/p08.jpg',
  './gost/p09.jpg',
  './gost/p10.jpg',
  './gost/p11.jpg',
  './gost/p12.jpg',
  './gost/p13.jpg',
  './gost/p14.jpg',
  './gost/p15.jpg',
  './gost/p16.jpg',
  './gost/p17.jpg',
  './gost/p18.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Оболочка и страницы стандарта — из кеша. Символы планов подтягиваем
   по мере просмотра и тоже складываем в кеш: первый раз нужен доступ
   к файлам, дальше работает офлайн. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(r => {
        if (r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match('./index.html'))
    )
  );
});

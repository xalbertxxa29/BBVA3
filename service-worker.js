/* service-worker.js — v10
   ✔ Intercepta GET de mismo-origen y de CDNs conocidos (Firebase/Leaflet)
   ✔ Precache de assets locales y externos esenciales
   ✔ Navigation Preload para navegaciones más rápidas
   ✔ Stale-While-Revalidate para estáticos
   ✔ Fallback offline (menu.html o index.html)
*/

const CACHE_NAME = 'lidercontrol-cache-v10';

const PRECACHE = [
  './',
  './index.html',
  './menu.html',
  './formulariocaj.html',
  './formularioof.html',
  './logs-panel.html',

  // CSS locales
  './styles.css',
  './menu.css',

  // JS locales
  './script.js',
  './menu.js',
  './formulariocaj.js',
  './formularioof.js',
  './firebase-config.js',
  './logout.js',
  './logs-utils.js',

  // PWA & Assets
  './manifest.json',
  './icon-192.png',

  // Leaflet (CDN)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',

  // Firebase (CDN)
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-storage-compat.js'
];

// ---------- Install: precache y activar de inmediato ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        // Para assets locales, usamos reload para saltar el cache HTTP del navegador
        // Para assets externos (cors), usamos modo no-cors o aseguramos que el servidor permita CORS
        const requests = PRECACHE.map(url => {
          const isExternal = url.startsWith('http');
          return new Request(url, { 
            cache: isExternal ? 'default' : 'reload',
            mode: isExternal ? 'cors' : 'same-origin' 
          });
        });
        
        // Intentar cachear uno por uno para que un error en uno no rompa todo el precache
        for (const req of requests) {
          try {
            const resp = await fetch(req);
            if (resp.ok || resp.type === 'opaque') {
              await cache.put(req, resp);
            }
          } catch (e) {
            console.warn('Fallo precache de:', req.url, e);
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

// ---------- Activate: limpia versiones antiguas ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME) && caches.delete(k)));

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

// ---------- Estrategia SWR con soporte Cross-Origin limitado ----------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const url = new URL(request.url);
  const isAllowedExternal = [
    'unpkg.com',
    'www.gstatic.com',
    'raw.githubusercontent.com',
    'cdnjs.cloudflare.com',
    'tile.openstreetmap.org'
  ].some(domain => url.hostname.includes(domain));

  const fromNet = fetch(request).then((res) => {
    // Cachear si es mismo-origen OK, o si es un CDN permitido (incluso si es opaque)
    if (res && (res.ok || (res.type === 'opaque' && isAllowedExternal))) {
      cache.put(request, res.clone());
    }
    return res;
  }).catch(() => undefined);

  return cached || fromNet || new Response('Offline', { status: 503 });
}

// ---------- Fetch: intercepta GET ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Filtro de dominios permitidos para cachear fuera del origen
  const isAllowedHost = [
    self.location.hostname,
    'unpkg.com',
    'www.gstatic.com',
    'raw.githubusercontent.com',
    'cdnjs.cloudflare.com',
    'tile.openstreetmap.org'
  ].some(domain => url.hostname.includes(domain));

  if (!isAllowedHost) return;
  if (url.pathname.endsWith('service-worker.js')) return;

  // Navegaciones (document)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;

        const net = await fetch(new Request(req, { cache: 'no-store' }));
        if (net && net.ok) {
          const c = await caches.open(CACHE_NAME);
          c.put(req, net.clone());
        }
        return net;
      } catch {
        const c = await caches.open(CACHE_NAME);
        return (await c.match('./menu.html')) || (await c.match('./index.html')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

// ---------- Mensajes desde la app (opcional) ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

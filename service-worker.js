/* service-worker.js — v7
   ✔ Solo intercepta GET de mismo-origen (no toca Firebase/Google/CDNs ni subidas)
   ✔ Precache de assets locales (incluye favicon)
   ✔ Navigation Preload para navegaciones más rápidas
   ✔ Stale-While-Revalidate para estáticos
   ✔ Fallback offline (menu.html o index.html)
   ✔ Mensaje a clientes cuando el SW queda listo
*/

const CACHE_NAME = 'lidercontrol-cache-v7';

const PRECACHE = [
  './',
  './index.html',
  './menu.html',
  './formulariocaj.html',
  './formularioof.html',

  // CSS
  './styles.css',
  './menu.css',

  // JS
  './script.js',
  './menu.js',
  './formulariocaj.js',
  './formularioof.js',

  // Config & PWA
  './firebase-config.js',
  './manifest.json',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png'
];

// ---------- Install: precache y activar de inmediato ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        // Evita servir del HTTP cache en la primera instalación
        await cache.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })));
      })
      .then(() => self.skipWaiting())
  );
});

// ---------- Activate: limpia versiones antiguas + habilita Navigation Preload + avisa ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // borra cachés viejos
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME) && caches.delete(k)));

    // habilita navigation preload si está disponible
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }

    await self.clients.claim();

    // avisar a las páginas controladas que el SW está listo
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_READY', cache: CACHE_NAME, version: 'v7' }));
  })());
});

// ---------- Estrategia SWR para GET (no-navigate) ----------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fromNet = fetch(request).then((res) => {
    // Cachear solo respuestas OK del mismo origen
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone());
    }
    return res;
  }).catch(() => undefined);

  // Respuesta inmediata desde caché si existe; si no, red; si nada → 503
  return cached || fromNet || new Response('Offline', { status: 503, statusText: 'Offline' });
}

// ---------- Fetch: intercepta solo GET/mismo-origen ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 1) Nunca interceptar métodos distintos de GET (evita romper subidas / CORS preflights)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 2) Dejar pasar todo lo que NO sea mismo-origen (Firebase/Google/CDNs)
  if (url.origin !== self.location.origin) return;

  // 3) No interceptar el propio SW
  if (url.pathname.endsWith('service-worker.js')) return;

  // 4) Navegaciones (document) → preload → red (no-store) → fallback cache
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // a) Usa Navigation Preload si existe
        const preload = await event.preloadResponse;
        if (preload) return preload;

        // b) Red sin usar el HTTP cache del navegador
        const net = await fetch(new Request(req, { cache: 'no-store' }));
        // Cachear la página si es del mismo origen y OK
        if (net && net.ok && net.type === 'basic') {
          const c = await caches.open(CACHE_NAME);
          c.put(req, net.clone());
        }
        return net;
      } catch {
        // c) Fallback offline
        const c = await caches.open(CACHE_NAME);
        return (await c.match('./menu.html'))
            || (await c.match('./index.html'))
            || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // 5) Resto de GET/mismo-origen → SWR
  event.respondWith(staleWhileRevalidate(req));
});

// ---------- Mensajes desde la app (opcional) ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

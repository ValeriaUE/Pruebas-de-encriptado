/* ===== FN Inspección — Service Worker =====
   Cachea el "app shell" y las librerías externas para que la aplicación
   funcione sin conexión una vez abierta con internet la primera vez.
   Sube el número de versión (CACHE) cada vez que publiques cambios para
   forzar la actualización en los dispositivos ya instalados. */

const CACHE = 'fn-inspeccion-v23';

// Recursos locales del propio sitio (mismo origen).
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './supabase-sync.js',
  './acceso.js',
  './almacenamiento.js',
  './logo-neumaticos.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

// Librerías externas (CDN) que la app necesita para arrancar.
const CDN_ASSETS = [
  'https://unpkg.com/@tailwindcss/browser@4',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
  'https://unpkg.com/lucide@0.453.0/dist/umd/lucide.min.js',
  'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
  'https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Los locales son críticos: si fallan, falla la instalación.
    await cache.addAll(LOCAL_ASSETS);
    // Los CDN se intentan uno a uno para no abortar todo si alguno falla.
    await Promise.allSettled(
      CDN_ASSETS.map((url) =>
        fetch(url, { mode: 'cors' })
          .then((res) => { if (res.ok) return cache.put(url, res.clone()); })
          .catch(() => {})
      )
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca interceptar las llamadas a Supabase: siempre van por red (datos frescos).
  if (url.hostname.endsWith('.supabase.co')) return;

  // Nunca interceptar el envío de correos: es una función del servidor.
  if (url.pathname.indexOf('/api/') !== -1) return;

  // Navegaciones (abrir la app): red primero, con respaldo a la copia cacheada.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Resto de recursos.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const sameOrigin = url.origin === self.location.origin;

    // Archivos propios (index, supabase-sync.js, datos/…): SIEMPRE red
    // primero y sin cajón del navegador. La copia guardada es solo respaldo para
    // cuando no hay conexión, nunca la fuente de la versión que se ejecuta.
    if (sameOrigin) {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return (await cache.match(req)) || Response.error();
      }
    }

    // Librerías externas (versión fija en la URL): cache primero, se actualizan solas.
    const cached = await cache.match(req, { ignoreSearch: false });
    const network = fetch(req)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    return cached || (await network) || Response.error();
  })());
});

// ═══════════════════════════════════════════════════════════════════
// ALMACÉN MEDIESE - SERVICE WORKER
// Caché offline para que la PWA funcione sin internet
// ═══════════════════════════════════════════════════════════════════

const CACHE_NAME = "almacen-mediese-v1";

const ARCHIVOS_CACHE = [
  "./",
  "./index.html",
  "./app.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js"
];


// ═══════════════════════════════════════════════════════════════════
// INSTALACIÓN
// ═══════════════════════════════════════════════════════════════════

self.addEventListener("install", (event) => {
  console.log("🔧 Service Worker instalando...");

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("📦 Cacheando archivos...");
      return cache.addAll(ARCHIVOS_CACHE).catch((err) => {
        console.warn("⚠️ Error al cachear algunos archivos:", err);
      });
    }).then(() => self.skipWaiting())
  );
});


// ═══════════════════════════════════════════════════════════════════
// ACTIVACIÓN
// ═══════════════════════════════════════════════════════════════════

self.addEventListener("activate", (event) => {
  console.log("✅ Service Worker activado");

  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("🗑️ Eliminando caché viejo:", key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});


// ═══════════════════════════════════════════════════════════════════
// FETCH - Estrategia de caché
// ═══════════════════════════════════════════════════════════════════

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // 🔴 NUNCA cachear:
  // - usuarios.json (siempre debe ser fresco)
  // - Peticiones a Apps Script (van al servidor)
  // - Peticiones con ?t= (timestamp para romper caché)
  if (
    url.includes("usuarios.json") ||
    url.includes("script.google.com") ||
    url.includes("?t=") ||
    url.includes("callback=")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 🟢 Para el resto: Cache First, Network Fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Cachear nuevas peticiones
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Si no hay red, devolver algo genérico para HTML
        if (event.request.destination === "document") {
          return caches.match("./index.html");
        }
      });
    })
  );
});

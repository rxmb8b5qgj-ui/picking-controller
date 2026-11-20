// Fonctionnement hors ligne : après une première ouverture (réseau requis une fois),
// la page se charge même sans Wi-Fi ni données mobiles — le Bluetooth suffit ensuite.
// Changer VERSION à chaque mise à jour des fichiers pour que les téléphones la reçoivent.
const VERSION = "picking-controller-v1";
const FILES = ["./", "index.html", "app.js", "protocol.js", "orders.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (mise à jour dès qu'il y a du réseau), cache sinon. ?device=… est ignoré.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && new URL(event.request.url).origin === location.origin) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

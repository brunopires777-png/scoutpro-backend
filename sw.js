// Service worker mínimo — só existe pra habilitar "Instalar app" no navegador.
// Sem cache agressivo de propósito: placares, odds e predições do ESA mudam
// o tempo todo, então cachear a API antigamente causaria dado desatualizado.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Sempre busca da rede primeiro; só cai pro cache (se existir) se a rede falhar.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

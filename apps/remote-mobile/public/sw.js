const CACHE = 'turboflux-remote-v3'
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/remote-mark.svg', '/manifest.webmanifest']))))
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
  self.clients.claim(),
])))
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.searchParams.has('pair')) {
    event.respondWith(fetch(event.request))
    return
  }
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone()
    void caches.open(CACHE).then(cache => cache.put(event.request, copy))
    return response
  }).catch(() => caches.match(event.request)))
})

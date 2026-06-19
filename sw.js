// sw.js — Service Worker für Manga Tracker (Phase 69)
//
// CACHE_VERSION bumpen, wenn Assets sich ändern → activate() löscht dann den
// alten Cache automatisch. Format: 'mt-pwa-vN' (z. B. 'mt-pwa-v2').
// Danach alle offenen Tabs neu laden, damit der neue SW sofort greift.

'use strict';

const CACHE_VERSION = 'mt-pwa-v1';

// App-Shell: statische Dateien, die nach dem ersten Online-Besuch offline
// verfügbar sein sollen. Relative Pfade (./…) damit GitHub-Pages-Sub-Pfad
// (/manga-tracker/) korrekt funktioniert.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './src/styles.css',
  './src/utils.js',
  './src/supabase.js',
  './src/release-utils.js',
  './src/auth.js',
  './src/app.js',
  './src/sw-register.js',
  './vendor/jszip.min.js',
];

// ── install: Shell precachen ──────────────────────────────────────────────────
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ── activate: alte Cache-Versionen aufräumen ──────────────────────────────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ── fetch: Cache-Strategien nach Ressourcentyp ────────────────────────────────
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // 1. Non-GET → nie abfangen (Supabase-Writes, RPC-POSTs etc.)
  if (request.method !== 'GET') {
    return;
  }

  var url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // 2. Cross-Origin → durchlassen (Supabase, api.manga-passion.de)
  //    Das ist die zentrale Schutzbarriere: Supabase-Antworten und Auth-Token
  //    werden NIEMALS gecacht.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. data/*.json → Network-First mit Cache-Fallback
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(request).then(function (response) {
        // Nur valide same-origin-Antworten cachen
        if (response.ok && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(request);
      })
    );
    return;
  }

  // 4. Same-origin Shell → Cache-First mit Network-Fallback
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).then(function (response) {
        if (response.ok && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      });
    })
  );
});

// sw-register.js — Service-Worker-Registrierung (Phase 69)
// Externes Script (CSP: script-src 'self', kein unsafe-inline).
// Läuft im window-load-Handler → blockiert den App-Boot nicht.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js')
      .then(function (reg) {
        console.log('[SW] registered, scope:', reg.scope);
      })
      .catch(function (err) {
        console.warn('[SW] registration failed:', err);
      });
  });
}

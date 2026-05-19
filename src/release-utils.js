// src/release-utils.js — Phase 20: Zentralisierte Release-Normalisierung (UMD)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.MangaTrackerReleaseUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Normalisiert einen Serientitel für den Abgleich.
  // Umlaute als Digraphen (ae/oe/ue), damit der Output mit update-release-cache.js übereinstimmt.
  function normalizeTitle(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Normalisiert einen Verlagsnamen für den Abgleich.
  // Umlaute als Digraphen, konsistent mit update-release-cache.js.
  function normalizePublisher(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
      .replace(/[!.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Prüft ob zwei normalisierte Verlagsnamen übereinstimmen.
  // Fehlende Verlage schließen nicht aus (true wenn einer fehlt).
  function pubsMatch(a, b) {
    if (!a || !b) return true;
    return normalizePublisher(a) === normalizePublisher(b);
  }

  // Erzeugt einen stabilen Cache-Schlüssel aus Titel, Verlag und Bandnummer.
  function cacheKey(title, publisher, volume) {
    return normalizeTitle(title) + '|' + normalizePublisher(publisher) + '|' + volume;
  }

  // Bestimmt den Zielband für den Release-Abgleich einer Serie.
  // Gibt null zurück wenn die Serie abgeschlossen und vollständig ist.
  // mFirstMissingBand und mNextBand werden von der App übergeben.
  function getReleaseTargetVolume(m, mFirstMissingBand, mNextBand) {
    var firstMiss = mFirstMissingBand(m);
    if (m.ongoing === 'false' && firstMiss === null) return null;
    return firstMiss !== null && firstMiss !== undefined ? firstMiss : mNextBand(m);
  }

  return {
    normalizeTitle: normalizeTitle,
    normalizePublisher: normalizePublisher,
    pubsMatch: pubsMatch,
    cacheKey: cacheKey,
    getReleaseTargetVolume: getReleaseTargetVolume,
  };
});

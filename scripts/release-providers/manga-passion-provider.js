'use strict';

const {
  normalizePublisher,
  normalizeTitle,
} = require('../release-confidence');
const {
  fetchJson: defaultFetchJson,
  normalizeIsbn13,
  normalizeProviderResult,
  safeHttpsUrl,
  sleep,
} = require('./provider-utils');

const MP_API = 'https://api.manga-passion.de';
const MP_SOURCE_URL = 'https://www.manga-passion.de';

function buildEditionSourceUrl(editionId) {
  const idNumber = Number(editionId);
  if (!Number.isInteger(idNumber) || idNumber < 1) return null;
  return `${MP_SOURCE_URL}/editions/${idNumber}`;
}

function publisherNames(edition) {
  return Array.isArray(edition && edition.publishers)
    ? edition.publishers.map(p => p && p.name).filter(Boolean)
    : [];
}

function scoreEdition(seed, edition, aliasMap) {
  const seedTitle = normalizeTitle(seed.seriesTitle);
  const editionTitle = normalizeTitle(edition && edition.title);
  const seedPublisher = normalizePublisher(seed.publisher, aliasMap);
  const editionPublishers = publisherNames(edition).map(name => normalizePublisher(name, aliasMap));
  let score = 0;
  if (editionTitle === seedTitle) score += 60;
  else if (editionTitle.includes(seedTitle) || seedTitle.includes(editionTitle)) score += 35;
  else {
    const seedTokens = new Set(seedTitle.split(' ').filter(token => token.length > 2));
    const hitTokens = editionTitle.split(' ').filter(token => seedTokens.has(token)).length;
    score += Math.min(25, hitTokens * 8);
  }
  if (editionPublishers.includes(seedPublisher)) score += 30;
  if (edition && edition.print === true) score += 10;
  if (edition && edition.digital === true) score -= 15;
  if (/ebook|e book|light novel|novel|roman|artbook|kochbuch|wimmelbuch/i.test(String(edition && edition.title || ''))) score -= 30;
  if (Number(edition && edition.numVolumes) >= Number(seed.volumeNumber)) score += 5;
  return score;
}

function dateFromMpVolumeRaw(volume) {
  if (!volume) return null;
  if (Number.isInteger(volume.year) && Number.isInteger(volume.month) && Number.isInteger(volume.day)) {
    return `${String(volume.year).padStart(4, '0')}-${String(volume.month).padStart(2, '0')}-${String(volume.day).padStart(2, '0')}`;
  }
  if (typeof volume.date === 'string' && volume.date.length >= 10) return volume.date.slice(0, 10);
  return null;
}

const mangaPassionProvider = {
  id: 'manga-passion',
  sourceName: 'Manga Passion',
  sourceUrl: MP_SOURCE_URL,

  async findRelease(candidate, context = {}) {
    const aliasMap = context.aliasMap;
    const policy = context.policy || {};
    const fetchJson = typeof context.fetchJson === 'function' ? context.fetchJson : defaultFetchJson;
    const base = {
      ...candidate,
      providerId: this.id,
      sourceName: this.sourceName,
      sourceUrl: this.sourceUrl,
      checkedAt: context.checkedAt || new Date().toISOString(),
    };

    try {
      const searchUrl = `${MP_API}/editions?search=${encodeURIComponent(candidate.seriesTitle)}&itemsPerPage=8`;
      const hits = await fetchJson(searchUrl, policy);
      await sleep(Number(policy.minDelayMs || 0));
      if (!Array.isArray(hits) || hits.length === 0) {
        return normalizeProviderResult(candidate, this, {
          ...base,
          sourceResult: 'no-edition-found',
          sourceFetchFailed: false,
          evidence: 'Manga Passion lieferte keine passende Edition zur Suchanfrage.',
        });
      }

      const scored = hits
        .map(edition => ({ edition, score: scoreEdition(candidate, edition, aliasMap) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 60) {
        return normalizeProviderResult(candidate, this, {
          ...base,
          sourceResult: `edition-match-too-weak:${best ? best.score : 0}`,
          evidence: 'Manga Passion lieferte keine hinreichend eindeutige Print-Edition.',
        });
      }

      const expectedTitle = normalizeTitle(candidate.seriesTitle);
      const expectedPublisher = normalizePublisher(candidate.publisher, aliasMap);
      const exactEditionMatches = scored.filter(({ edition }) => {
        const titleMatches = normalizeTitle(edition && edition.title) === expectedTitle;
        const publishers = publisherNames(edition).map(name => normalizePublisher(name, aliasMap));
        return titleMatches && publishers.includes(expectedPublisher) && edition.print === true;
      });

      const volumesUrl = `${MP_API}/editions/${best.edition.id}/volumes?itemsPerPage=300`;
      const volumes = await fetchJson(volumesUrl, policy);
      await sleep(Number(policy.minDelayMs || 0));
      if (!Array.isArray(volumes) || volumes.length === 0) {
        return normalizeProviderResult(candidate, this, {
          ...base,
          sourceEditionId: best.edition.id,
          sourceEditionTitle: best.edition.title || null,
          sourcePublisher: publisherNames(best.edition)[0] || null,
          sourceUrl: buildEditionSourceUrl(best.edition.id) || this.sourceUrl,
          sourceResult: 'no-volumes-found',
          evidence: 'Manga Passion Edition gefunden, aber keine Bandliste erhalten.',
        });
      }

      const volume = volumes.find(item => Number(item.number) === Number(candidate.volumeNumber));
      if (!volume) {
        return normalizeProviderResult(candidate, this, {
          ...base,
          sourceEditionId: best.edition.id,
          sourceEditionTitle: best.edition.title || null,
          sourcePublisher: publisherNames(best.edition)[0] || null,
          sourceUrl: buildEditionSourceUrl(best.edition.id) || this.sourceUrl,
          sourceResult: 'volume-not-found',
          sourceVolumeNumber: null,
          evidence: `Manga Passion Edition gefunden, aber Band ${candidate.volumeNumber} nicht in der Bandliste.`,
        });
      }

      const releaseDate = dateFromMpVolumeRaw(volume);
      const editionSourceUrl = buildEditionSourceUrl(best.edition.id);
      return normalizeProviderResult(candidate, this, {
        ...base,
        releaseDate,
        isbn13: normalizeIsbn13(volume.isbn13 || volume.isbn || null),
        coverUrl: safeHttpsUrl(volume.cover) || safeHttpsUrl(best.edition.cover),
        // Phase 48: prefer the concrete editions URL; only fall back to the
        // generic source URL if the edition ID is missing or invalid.
        sourceUrl: editionSourceUrl || this.sourceUrl,
        sourceEditionId: best.edition.id,
        sourceEditionTitle: best.edition.title || null,
        sourcePublisher: publisherNames(best.edition)[0] || null,
        sourceVolumeNumber: Number(volume.number),
        sourceVolumeSpecialType: volume.specialType || null,
        sourceScore: best.score,
        ambiguousEdition: exactEditionMatches.length > 1,
        sourceResult: 'volume-found',
        evidence: 'Manga Passion Edition, Verlag und Bandnummer wurden gegen die Bandliste abgeglichen.',
      });
    } catch (error) {
      return normalizeProviderResult(candidate, this, {
        ...base,
        sourceFetchFailed: true,
        sourceResult: `fetch-error:${error.message}`,
        sourceError: error.message,
        evidence: `Manga Passion konnte nicht abgefragt werden: ${error.message}`,
      });
    }
  },
};

module.exports = mangaPassionProvider;
module.exports._private = { buildEditionSourceUrl };

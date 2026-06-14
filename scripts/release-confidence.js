#!/usr/bin/env node
'use strict';

/**
 * release-confidence.js - Phase 25
 *
 * Central confidence rules for automated release-cache candidates. The rules are
 * intentionally conservative: only fully confirmed, allowed-source candidates
 * may become high-confidence cache patches. Ambiguous or unsafe data is routed
 * to the source-review queue instead of being written to the public cache.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_RELEASE_DATES = new Set([
  '2999-12-31',
  '9999-12-31',
  '2099-12-31',
  '0000-00-00',
]);

const DEFAULT_PUBLISHER_ALIASES = new Map([
  ['carlsen', 'carlsen manga'],
  ['carlsen manga', 'carlsen manga'],
  ['carlsen manga!', 'carlsen manga'],
  ['tokyo pop', 'tokyopop'],
  ['tokyopop', 'tokyopop'],
  ['tokyo-pop', 'tokyopop'],
  ['kaze manga', 'crunchyroll manga'],
  ['kaz manga', 'crunchyroll manga'],
  ['kazé manga', 'crunchyroll manga'],
  ['kaze', 'crunchyroll manga'],
  ['crunchyroll', 'crunchyroll manga'],
  ['crunchyroll manga', 'crunchyroll manga'],
  ['planet manga', 'panini manga'],
  ['panini', 'panini manga'],
  ['panini manga', 'panini manga'],
  // Phase 3.2 (Backlog): DEFAULT-Map an source-basierte Map (release-sources.json) angleichen.
  ['manga cult', 'manga cult'],
  ['mangacult', 'manga cult'],
  ['cross cult', 'manga cult'],
  ['mangamoon', 'mangamoon'],
  ['animoon publishing', 'mangamoon'],
  ['altraverse', 'altraverse'],
  ['egmont', 'egmont manga'],
  ['egmont manga', 'egmont manga'],
  ['egmont shop', 'egmont manga'],
  // Hayabusa: eigenständiger Verlag mit eigener Source (release-sources.json).
  ['hayabusa', 'hayabusa'],
  ['dani books', 'dani books'],
  ['dokico', 'dokico'],
  ['yomeru', 'yomeru'],
  ['kaze online', 'crunchyroll manga'],
]);

function normalizeBase(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function normalizeComparable(value) {
  return normalizeBase(value)
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  return normalizeComparable(value);
}

function normalizePublisher(value, aliasMap) {
  const normalized = normalizeComparable(value);
  if (!normalized) return '';
  return (aliasMap || DEFAULT_PUBLISHER_ALIASES).get(normalized) || normalized;
}

function buildPublisherAliasMap(sources) {
  const map = new Map(DEFAULT_PUBLISHER_ALIASES);
  if (!sources || !Array.isArray(sources.sources)) return map;

  for (const source of sources.sources) {
    const aliases = Array.isArray(source.publisherAliases) ? source.publisherAliases : [];
    const canonical = aliases[aliases.length - 1] || source.name;
    const normalizedCanonical = normalizePublisher(canonical, map) || normalizeTitle(canonical);
    for (const alias of aliases) {
      const key = normalizeComparable(alias);
      if (key && normalizedCanonical) map.set(key, normalizedCanonical);
    }
  }
  return map;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function isRealReleaseDate(value) {
  return isValidDate(value) && !PLACEHOLDER_RELEASE_DATES.has(value);
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isAllowedSourceUrl(sourceUrl, sources) {
  if (!isValidHttpUrl(sourceUrl)) return false;
  if (!sources || !Array.isArray(sources.sources)) return false;

  return sources.sources
    .filter(source => source && source.enabled !== false)
    .some(source => {
      const allowedUrls = Array.isArray(source.allowedUrls) && source.allowedUrls.length
        ? source.allowedUrls
        : [source.baseUrl].filter(Boolean);
      return allowedUrls.some(prefix => typeof prefix === 'string' && sourceUrl.startsWith(prefix));
    });
}

// Phase 48: A high-confidence entry must point to a concrete resource (such as
// a /editions/<id> or product page), not to the bare publisher landing page.
// Returns true if the URL only encodes the host with no meaningful path.
function isBareLandingPageUrl(sourceUrl) {
  if (!isValidHttpUrl(sourceUrl)) return false;
  try {
    const url = new URL(sourceUrl);
    const path = (url.pathname || '/').replace(/\/+$/, '');
    if (path === '' || path === '/') return url.search === '' && url.hash === '';
    return false;
  } catch (_) {
    return false;
  }
}

function hasPublisherConflict(candidate, aliasMap) {
  const expected = normalizePublisher(candidate.publisher, aliasMap);
  const sourcePublisher = normalizePublisher(candidate.sourcePublisher || candidate.publisherFromSource, aliasMap);
  return Boolean(expected && sourcePublisher && expected !== sourcePublisher);
}

function hasEditionConflict(candidate) {
  const expected = normalizeTitle(candidate.seriesTitle);
  const editionTitle = normalizeTitle(candidate.sourceEditionTitle || candidate.editionTitle || candidate.sourceSeriesTitle);
  if (!expected || !editionTitle) return false;
  return expected !== editionTitle;
}

function hasVolumeConflict(candidate) {
  const expected = Number(candidate.volumeNumber);
  const sourceVolume = Number(candidate.sourceVolumeNumber == null ? candidate.volumeNumber : candidate.sourceVolumeNumber);
  if (!Number.isInteger(expected) || expected < 1) return true;
  if (!Number.isInteger(sourceVolume) || sourceVolume < 1) return true;
  if (sourceVolume !== expected) return true;
  return candidate.sourceVolumeSpecialType !== null && candidate.sourceVolumeSpecialType !== undefined && candidate.sourceVolumeSpecialType !== false;
}

function mapReviewStatus(evaluation) {
  if (evaluation.confidence === 'high') return 'auto-ready-to-patch';
  if (evaluation.reasonCodes.includes('placeholder-release-date')) return 'auto-not-yet-released';
  if (evaluation.reasonCodes.includes('missing-source-url') || evaluation.reasonCodes.includes('source-fetch-failed')) return 'auto-source-missing';
  if (evaluation.confidence === 'medium') return 'auto-medium-confidence';
  if (evaluation.confidence === 'low') return 'auto-low-confidence';
  return 'auto-blocked';
}

function evaluateReleaseCandidate(candidate, context = {}) {
  const sources = context.sources || null;
  const aliasMap = context.aliasMap || buildPublisherAliasMap(sources);
  const reasonCodes = [];

  const sourceUrlAllowed = isAllowedSourceUrl(candidate.sourceUrl, sources);
  const realDate = isRealReleaseDate(candidate.releaseDate);
  const hasSourceUrl = isValidHttpUrl(candidate.sourceUrl);
  const sourceTitle = candidate.sourceEditionTitle || candidate.editionTitle || candidate.sourceSeriesTitle || null;
  const sourcePublisher = candidate.sourcePublisher || candidate.publisherFromSource || null;
  const hasSourceVolumeNumber = candidate.sourceVolumeNumber !== null && candidate.sourceVolumeNumber !== undefined;
  const exactTitle = Boolean(sourceTitle) && normalizeTitle(candidate.seriesTitle) === normalizeTitle(sourceTitle);
  const publisherConflict = hasPublisherConflict(candidate, aliasMap);
  const editionConflict = hasEditionConflict(candidate);
  const volumeConflict = hasVolumeConflict(candidate);

  if (!hasSourceUrl) reasonCodes.push('missing-source-url');
  if (hasSourceUrl && !sourceUrlAllowed) reasonCodes.push('source-url-not-allowed');
  // Phase 48: a bare landing-page URL (e.g. https://www.manga-passion.de) is
  // not specific enough to act as proof for a single volume; require a deeper
  // path such as /editions/<id> or a product detail page.
  const bareLandingPage = hasSourceUrl && isBareLandingPageUrl(candidate.sourceUrl);
  if (bareLandingPage) reasonCodes.push('source-url-not-specific');
  if (!candidate.sourceName || typeof candidate.sourceName !== 'string') reasonCodes.push('missing-source-name');
  if (!sourceTitle) reasonCodes.push('missing-source-edition-title');
  if (!sourcePublisher) reasonCodes.push('missing-source-publisher');
  if (!hasSourceVolumeNumber) reasonCodes.push('missing-source-volume-number');
  if (!candidate.releaseDate) reasonCodes.push('missing-release-date');
  else if (PLACEHOLDER_RELEASE_DATES.has(candidate.releaseDate)) reasonCodes.push('placeholder-release-date');
  else if (!isValidDate(candidate.releaseDate)) reasonCodes.push('invalid-release-date');
  if (sourceTitle && !exactTitle) reasonCodes.push('edition-title-conflict');
  if (publisherConflict) reasonCodes.push('publisher-conflict');
  if (volumeConflict) reasonCodes.push('volume-number-conflict');
  if (candidate.ambiguousEdition === true) reasonCodes.push('ambiguous-edition');
  if (candidate.sourceFetchFailed === true) reasonCodes.push('source-fetch-failed');
  if (candidate.providerConflict === true) reasonCodes.push('provider-conflict');

  const blockedReasons = new Set([
    'placeholder-release-date',
    'invalid-release-date',
    'source-url-not-allowed',
    'publisher-conflict',
    'edition-title-conflict',
    'volume-number-conflict',
    'ambiguous-edition',
    'provider-conflict',
  ]);
  const blocked = reasonCodes.some(code => blockedReasons.has(code));

  let confidence = 'low';
  if (blocked) {
    confidence = 'blocked';
  } else if (
    exactTitle &&
    sourcePublisher &&
    hasSourceVolumeNumber &&
    !publisherConflict &&
    !volumeConflict &&
    realDate &&
    hasSourceUrl &&
    sourceUrlAllowed &&
    !bareLandingPage &&
    candidate.sourceName
  ) {
    confidence = 'high';
  } else if (realDate && hasSourceUrl && sourceUrlAllowed && candidate.sourceName) {
    confidence = 'medium';
  }

  return {
    confidence,
    reviewStatus: mapReviewStatus({ confidence, reasonCodes }),
    blocked,
    highConfidenceReady: confidence === 'high',
    reasonCodes,
  };
}

module.exports = {
  PLACEHOLDER_RELEASE_DATES,
  DEFAULT_PUBLISHER_ALIASES,
  buildPublisherAliasMap,
  evaluateReleaseCandidate,
  hasPublisherConflict,
  isAllowedSourceUrl,
  isBareLandingPageUrl,
  isRealReleaseDate,
  isValidDate,
  isValidHttpUrl,
  normalizePublisher,
  normalizeTitle,
};

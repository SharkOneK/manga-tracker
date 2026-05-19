'use strict';

const {
  evaluateReleaseCandidate,
  normalizePublisher,
  normalizeTitle,
} = require('../release-confidence');
const mangaPassionProvider = require('./manga-passion-provider');
const { sourceConfigEnabled } = require('./provider-utils');

const REGISTERED_PROVIDERS = [
  mangaPassionProvider,
];

const CONFIDENCE_RANK = new Map([
  ['high', 3],
  ['medium', 2],
  ['low', 1],
  ['blocked', 0],
]);

function hasCandidateSourceData(candidate) {
  return Boolean(candidate && candidate.releaseDate && candidate.sourceUrl && candidate.sourceName);
}

function getEnabledReleaseProviders(sources) {
  return REGISTERED_PROVIDERS.filter(provider => sourceConfigEnabled(sources, provider.id));
}

function sourceVolume(result) {
  return Number(result.sourceVolumeNumber == null ? result.volumeNumber : result.sourceVolumeNumber);
}

function highResultsConflict(left, right, aliasMap) {
  if (left.releaseDate && right.releaseDate && left.releaseDate !== right.releaseDate) return true;
  if (sourceVolume(left) !== sourceVolume(right)) return true;

  const leftPublisher = normalizePublisher(left.sourcePublisher || left.publisher, aliasMap);
  const rightPublisher = normalizePublisher(right.sourcePublisher || right.publisher, aliasMap);
  if (leftPublisher && rightPublisher && leftPublisher !== rightPublisher) return true;

  const leftTitle = normalizeTitle(left.sourceEditionTitle || left.seriesTitle);
  const rightTitle = normalizeTitle(right.sourceEditionTitle || right.seriesTitle);
  if (leftTitle && rightTitle && leftTitle !== rightTitle) return true;

  return false;
}

function buildProviderConflictCandidate(candidate, highResults, aliasMap) {
  const providers = highResults.map(item => item.provider.id).join(', ');
  const conflictDetails = [];
  for (let i = 0; i < highResults.length; i++) {
    for (let j = i + 1; j < highResults.length; j++) {
      if (highResultsConflict(highResults[i].result, highResults[j].result, aliasMap)) {
        conflictDetails.push(`${highResults[i].provider.id}<->${highResults[j].provider.id}`);
      }
    }
  }
  return {
    ...candidate,
    providerId: 'multi-provider',
    sourceName: providers ? `Provider-Konflikt: ${providers}` : 'Provider-Konflikt',
    sourceUrl: highResults[0] && highResults[0].result.sourceUrl ? highResults[0].result.sourceUrl : candidate.sourceUrl || null,
    releaseDate: null,
    providerConflict: true,
    sourceResult: `provider-conflict:${conflictDetails.join(',')}`,
    evidence: 'Mehrere Provider lieferten widersprüchliche High-Confidence-Ergebnisse; automatischer Cache-Patch blockiert.',
    checkedAt: new Date().toISOString(),
  };
}

async function checkCandidateSource(candidate, context = {}) {
  const { sources, aliasMap } = context;

  if (hasCandidateSourceData(candidate)) {
    return {
      ...candidate,
      providerId: candidate.providerId || 'manual-reviewed',
      checkedAt: candidate.checkedAt || new Date().toISOString(),
    };
  }

  const providers = getEnabledReleaseProviders(sources);
  if (!providers.length) {
    return {
      ...candidate,
      sourceFetchFailed: true,
      sourceResult: 'no-enabled-provider',
      evidence: 'Keine aktivierte Release-Provider-Implementierung vorhanden.',
    };
  }

  const checkedResults = [];
  for (const provider of providers) {
    const result = await provider.findRelease(candidate, context);
    const evaluation = evaluateReleaseCandidate(result, { sources, aliasMap });
    checkedResults.push({ provider, result, evaluation });
  }

  const highResults = checkedResults.filter(item => item.evaluation.confidence === 'high');
  if (highResults.length > 1) {
    const hasConflict = highResults.some((left, index) =>
      highResults.slice(index + 1).some(right => highResultsConflict(left.result, right.result, aliasMap))
    );
    if (hasConflict) return buildProviderConflictCandidate(candidate, highResults, aliasMap);
  }

  if (highResults.length) return highResults[0].result;

  const best = checkedResults
    .slice()
    .sort((a, b) => (CONFIDENCE_RANK.get(b.evaluation.confidence) || 0) - (CONFIDENCE_RANK.get(a.evaluation.confidence) || 0))[0];

  return best ? best.result : {
    ...candidate,
    sourceFetchFailed: true,
    sourceResult: 'no-provider-result',
    evidence: 'Aktive Provider lieferten kein verwertbares Ergebnis.',
  };
}

module.exports = {
  REGISTERED_PROVIDERS,
  checkCandidateSource,
  getEnabledReleaseProviders,
  sourceConfigEnabled,
};

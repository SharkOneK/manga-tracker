'use strict';

const {
  normalizePublisher,
  normalizeTitle,
} = require('../release-confidence');
const {
  isHttpsUrl,
  normalizeProviderResult,
  safeHttpsUrl,
  sleep,
  sourceConfigFor,
} = require('./provider-utils');

const DEFAULT_USER_AGENT = 'MangaTrackerReleaseBot/1.0 (+https://github.com/SharkOneK/manga-tracker)';

function sourcePolicy(sources, sourceId, contextPolicy = {}) {
  const globalPolicy = sources && sources.requestPolicy && typeof sources.requestPolicy === 'object'
    ? sources.requestPolicy
    : {};
  const source = sourceConfigFor(sources, sourceId) || {};
  const localPolicy = source.requestPolicy && typeof source.requestPolicy === 'object'
    ? source.requestPolicy
    : {};
  return {
    ...globalPolicy,
    ...localPolicy,
    ...contextPolicy,
    minDelayMs: Number(contextPolicy.minDelayMs ?? localPolicy.minDelayMs ?? globalPolicy.minDelayMs ?? 1200),
    timeoutMs: Number(contextPolicy.timeoutMs ?? localPolicy.timeoutMs ?? globalPolicy.timeoutMs ?? 12000),
    userAgent: String(contextPolicy.userAgent || localPolicy.userAgent || globalPolicy.userAgent || DEFAULT_USER_AGENT),
  };
}

function samePublisher(candidatePublisher, aliases, aliasMap) {
  const expected = normalizePublisher(candidatePublisher, aliasMap);
  return aliases.some(alias => normalizePublisher(alias, aliasMap) === expected);
}

async function fetchHtml(url, policy = {}) {
  if (!isHttpsUrl(url)) throw new Error('Only HTTPS provider URLs are allowed');
  const controller = new AbortController();
  const timeoutMs = Number(policy.timeoutMs || 12000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'User-Agent': String(policy.userAgent || DEFAULT_USER_AGENT),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    await sleep(Number(policy.minDelayMs || 0));
  }
}

function noResult(candidate, provider, context, sourceResult, evidence, extra = {}) {
  return normalizeProviderResult(candidate, provider, {
    ...candidate,
    providerId: provider.id,
    sourceName: provider.sourceName,
    sourceUrl: provider.sourceUrl,
    checkedAt: context.checkedAt || new Date().toISOString(),
    sourceFetchFailed: false,
    sourceResult,
    evidence,
    ...extra,
  });
}

function createNotImplementedPublisherProvider({ id, sourceName, baseUrl, publisherAliases = [] }) {
  return buildPublisherProvider({
    id,
    sourceName,
    baseUrl,
    publisherAliases,
  });
}

function buildPublisherProvider({
  id,
  sourceName,
  baseUrl,
  publisherAliases = [],
  search,
  parseProduct,
}) {
  if (!id || !sourceName || !baseUrl) throw new Error('Publisher provider requires id, sourceName and baseUrl');
  const provider = {
    id,
    sourceName,
    sourceUrl: baseUrl,
    baseUrl,
    publisherAliases,

    async findRelease(candidate, context = {}) {
      const policy = sourcePolicy(context.sources, id, context.policy || {});
      const ctx = {
        ...context,
        policy,
        fetchHtml: context.fetchHtml || fetchHtml,
        checkedAt: context.checkedAt || new Date().toISOString(),
      };
      const aliases = publisherAliases.length ? publisherAliases : [sourceName];

      if (!search || !parseProduct) {
        return noResult(candidate, provider, ctx, 'not-implemented', `${sourceName} ist als Publisher-Provider-Skeleton angelegt, aber noch nicht implementiert.`);
      }

      if (!samePublisher(candidate && candidate.publisher, aliases, context.aliasMap)) {
        return noResult(candidate, provider, ctx, 'publisher-not-supported', `${sourceName} ist fÃ¼r den Publisher dieses Kandidaten nicht zustÃ¤ndig.`);
      }

      try {
        const hits = await search(candidate, ctx);
        if (!Array.isArray(hits) || hits.length === 0) {
          return noResult(candidate, provider, ctx, 'no-edition-found', `${sourceName} lieferte keine Produktseite zur Suchanfrage.`);
        }

        const parsed = [];
        const parseErrors = [];
        for (const hit of hits) {
          try {
            const result = await parseProduct(hit, candidate, ctx);
            if (result && typeof result === 'object') parsed.push(result);
          } catch (error) {
            parseErrors.push(error.message);
          }
        }
        if (!parsed.length && parseErrors.length) {
          throw new Error(parseErrors[0]);
        }
        if (!parsed.length) {
          return noResult(candidate, provider, ctx, 'no-edition-found', `${sourceName} lieferte keine belegte Produktseite mit Bandnummer und Datum.`);
        }

        parsed.sort((a, b) => Number(b.sourceScore || 0) - Number(a.sourceScore || 0));
        return normalizeProviderResult(candidate, provider, {
          ...candidate,
          ...parsed[0],
          sourceName,
          checkedAt: ctx.checkedAt,
          sourceResult: parsed[0].sourceResult || 'volume-found',
          evidence: parsed[0].evidence || `${sourceName}: Produktseite wurde gegen Titel, Verlag und Bandnummer abgeglichen.`,
        });
      } catch (error) {
        return normalizeProviderResult(candidate, provider, {
          ...candidate,
          providerId: id,
          sourceName,
          sourceUrl: baseUrl,
          checkedAt: ctx.checkedAt,
          sourceFetchFailed: true,
          sourceResult: `fetch-error:${error.message}`,
          sourceError: error.message,
          evidence: `${sourceName} konnte nicht abgefragt werden: ${error.message}`,
        });
      }
    },
  };
  return provider;
}

module.exports = {
  DEFAULT_USER_AGENT,
  buildPublisherProvider,
  createNotImplementedPublisherProvider,
  fetchHtml,
  safeHttpsUrl,
  sourcePolicy,
};

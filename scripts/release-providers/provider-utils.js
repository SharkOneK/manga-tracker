'use strict';

const { isValidHttpUrl } = require('../release-confidence');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function safeHttpsUrl(value) {
  return isHttpsUrl(value) ? String(value).trim() : null;
}

function normalizeIsbn13(value) {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/[^0-9Xx]/g, '');
  if (/^(978|979)\d{10}$/.test(digits)) return digits;
  return null;
}

function normalizeProviderResult(candidate, provider, result) {
  const now = new Date().toISOString();
  return {
    ...candidate,
    ...(result && typeof result === 'object' ? result : {}),
    providerId: provider.id,
    sourceName: provider.sourceName,
    checkedAt: (result && result.checkedAt) || now,
  };
}

async function fetchJson(url, policy = {}) {
  if (!isHttpsUrl(url)) throw new Error('Only HTTPS provider URLs are allowed');
  const controller = new AbortController();
  const timeoutMs = Number(policy.timeoutMs || 12000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': String(policy.userAgent || 'MangaTrackerReleaseBot/1.0'),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sourceConfigEnabled(sources, sourceId) {
  return Array.isArray(sources && sources.sources) &&
    sources.sources.some(source => source && source.id === sourceId && source.enabled !== false);
}

function sourceConfigFor(sources, sourceId) {
  return Array.isArray(sources && sources.sources)
    ? sources.sources.find(source => source && source.id === sourceId) || null
    : null;
}

module.exports = {
  fetchJson,
  isHttpsUrl,
  isValidHttpUrl,
  normalizeIsbn13,
  normalizeProviderResult,
  safeHttpsUrl,
  sleep,
  sourceConfigEnabled,
  sourceConfigFor,
};

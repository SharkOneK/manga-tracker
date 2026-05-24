'use strict';

const { normalizeTitle } = require('../release-confidence');
const { normalizeIsbn13, safeHttpsUrl } = require('./provider-utils');
const { buildPublisherProvider } = require('./publisher-provider-base');

const BASE_URL = 'https://www.carlsen.de';
const PRODUCT_PATH_RE = /^\/(?:manga|softcover|hardcover|taschenbuch|produkt)\//i;

function decodeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function absoluteCarlsenUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(decodeHtml(href), BASE_URL);
    url.hash = '';
    if (url.protocol !== 'https:' || url.hostname !== 'www.carlsen.de') return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractSearchResultUrls(html) {
  const urls = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = decodeHtml(match[1]);
    const url = absoluteCarlsenUrl(href);
    if (!url) continue;
    const path = new URL(url).pathname;
    if (PRODUCT_PATH_RE.test(path) || /\/978(?:3|\d)/.test(path)) urls.push(url);
  }
  return unique(urls).slice(0, 8);
}

function flattenJsonLd(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(item => flattenJsonLd(item, out));
    return out;
  }
  if (typeof value === 'object') {
    out.push(value);
    if (Array.isArray(value['@graph'])) value['@graph'].forEach(item => flattenJsonLd(item, out));
  }
  return out;
}

function extractJsonLdObjects(html) {
  const objects = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = decodeHtml(match[1]).trim();
    if (!raw) continue;
    try {
      flattenJsonLd(JSON.parse(raw), objects);
    } catch (_) {
      // Ignore malformed third-party JSON-LD; visible HTML fallback still applies.
    }
  }
  return objects;
}

function objectTypes(item) {
  const type = item && item['@type'];
  return Array.isArray(type) ? type.map(String) : [String(type || '')];
}

function findProductJsonLd(html) {
  return extractJsonLdObjects(html).find(item => objectTypes(item).some(type => /Product|Book/i.test(type))) || null;
}

function firstString(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      if (typeof value.url === 'string' && value.url.trim()) return value.url.trim();
      if (typeof value['@id'] === 'string' && value['@id'].trim()) return value['@id'].trim();
    }
  }
  return null;
}

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const german = value.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (german) return `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`;
  return null;
}

function releaseDateFromProduct(product, html) {
  const candidates = [
    product && product.datePublished,
    product && product.releaseDate,
    product && product.publicationDate,
    product && product.offers && product.offers.availabilityStarts,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDate(candidate);
    if (normalized) return normalized;
  }
  const meta = html.match(/(?:Erscheinungstermin|Erscheinungsdatum|erscheint am|erschienen am)[^\d]{0,80}(\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})/i);
  return meta ? normalizeDate(meta[1]) : null;
}

function isbnFromProduct(product, html) {
  const direct = normalizeIsbn13(product && (product.gtin13 || product.isbn || product.isbn13 || product.sku));
  if (direct) return direct;
  const match = html.match(/(?:ISBN(?:-13)?|gtin13)[^0-9]{0,30}((?:978|979)[0-9\-\s]{10,20})/i);
  return match ? normalizeIsbn13(match[1]) : null;
}

function imageFromProduct(product) {
  const image = product && product.image;
  if (Array.isArray(image)) return safeHttpsUrl(firstString(...image));
  return safeHttpsUrl(firstString(image));
}

function titleContainsVolume(title, volumeNumber) {
  const escaped = String(volumeNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = normalizeTitle(title);
  return new RegExp(`(?:band\\s*)?${escaped}(?:\\b|$)`, 'i').test(normalized);
}

function stripVolumeFromTitle(title, volumeNumber) {
  const escaped = String(volumeNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(title || '')
    .replace(new RegExp(`\\b(?:band|bd\\.?)\\s*${escaped}\\b`, 'ig'), '')
    .replace(new RegExp(`(?:[:#-]|\\s)${escaped}\\s*$`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreProductTitle(candidate, productTitle, sourcePublisher) {
  const expectedTitle = normalizeTitle(candidate.seriesTitle);
  const hitTitle = normalizeTitle(stripVolumeFromTitle(productTitle, candidate.volumeNumber));
  let score = 0;
  if (hitTitle === expectedTitle) score += 70;
  else if (hitTitle.includes(expectedTitle) || expectedTitle.includes(hitTitle)) score += 45;
  else {
    const expectedTokens = new Set(expectedTitle.split(' ').filter(token => token.length > 2));
    const tokenHits = hitTitle.split(' ').filter(token => expectedTokens.has(token)).length;
    score += Math.min(30, tokenHits * 10);
  }
  if (titleContainsVolume(productTitle, candidate.volumeNumber)) score += 20;
  if (/carlsen|hayabusa/i.test(String(sourcePublisher || ''))) score += 10;
  return score;
}

function publisherFromProduct(product, html) {
  const publisher = product && product.publisher;
  if (typeof publisher === 'string') return publisher;
  if (publisher && typeof publisher.name === 'string') return publisher.name;
  const brand = product && product.brand;
  if (typeof brand === 'string') return brand;
  if (brand && typeof brand.name === 'string') return brand.name;
  if (/hayabusa/i.test(html)) return 'Hayabusa';
  return 'Carlsen Manga';
}

async function carlsenSearch(candidate, ctx) {
  const query = `${candidate.seriesTitle} Band ${candidate.volumeNumber}`;
  const searchUrl = `${BASE_URL}/suche?q=${encodeURIComponent(query)}`;
  const html = await ctx.fetchHtml(searchUrl, ctx.policy);
  return extractSearchResultUrls(html).map(url => ({ url }));
}

async function carlsenParseProduct(hit, candidate, ctx) {
  const url = typeof hit === 'string' ? hit : hit && hit.url;
  if (!url) return null;
  const html = hit.html || await ctx.fetchHtml(url, ctx.policy);
  const product = findProductJsonLd(html) || {};
  const productTitle = firstString(product.name, product.headline) || decodeHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/<[^>]+>/g, ' ').trim();
  if (!productTitle || !titleContainsVolume(productTitle, candidate.volumeNumber)) return null;

  const sourcePublisher = publisherFromProduct(product, html);
  const score = scoreProductTitle(candidate, productTitle, sourcePublisher);
  if (score < 80) return null;

  const releaseDate = releaseDateFromProduct(product, html);
  if (!releaseDate || releaseDate === '2999-12-31') return null;

  const sourceEditionTitle = stripVolumeFromTitle(productTitle, candidate.volumeNumber) || candidate.seriesTitle;
  return {
    releaseDate,
    isbn13: isbnFromProduct(product, html),
    coverUrl: imageFromProduct(product),
    sourceUrl: safeHttpsUrl(firstString(product.url, url)) || url,
    sourceEditionTitle,
    sourcePublisher,
    sourceVolumeNumber: Number(candidate.volumeNumber),
    sourceVolumeSpecialType: null,
    sourceScore: score,
    sourceProductTitle: productTitle,
    sourceResult: 'volume-found',
    evidence: 'Carlsen-Produktseite: JSON-LD/HTML enthielt Produktname, Bandnummer und Erscheinungsdatum; ISBN/Cover wurden nur uebernommen, wenn strukturiert vorhanden.',
  };
}

module.exports = buildPublisherProvider({
  id: 'carlsen',
  sourceName: 'Carlsen Manga',
  baseUrl: BASE_URL,
  publisherAliases: ['Carlsen', 'Carlsen Manga', 'Hayabusa'],
  search: carlsenSearch,
  parseProduct: carlsenParseProduct,
});

module.exports._private = {
  carlsenParseProduct,
  carlsenSearch,
  extractJsonLdObjects,
  extractSearchResultUrls,
  findProductJsonLd,
  normalizeDate,
  stripVolumeFromTitle,
  titleContainsVolume,
};

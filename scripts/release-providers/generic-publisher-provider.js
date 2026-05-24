'use strict';

const { normalizeTitle } = require('../release-confidence');
const { normalizeIsbn13, safeHttpsUrl } = require('./provider-utils');
const { buildPublisherProvider } = require('./publisher-provider-base');

function decodeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
      // Ignore malformed JSON-LD; providers also use visible HTML fallbacks.
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
      if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
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

function releaseDateFromHtml(html) {
  const patterns = [
    /(?:Erscheinungstermin|Erscheinungsdatum|erscheint am|erschienen am|Veroeffentlichung|Verfuegbarkeit|Lieferbar ab)[^\d]{0,120}(\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})/i,
    /(?:releaseDate|datePublished|publicationDate)["'\s:=>-]{1,30}(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return normalizeDate(match[1]);
  }
  return null;
}

function releaseDateFromProduct(product, html) {
  const candidates = [
    product && product.datePublished,
    product && product.releaseDate,
    product && product.publicationDate,
    product && product.offers && product.offers.availabilityStarts,
    product && product.offers && product.offers.validFrom,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDate(candidate);
    if (normalized) return normalized;
  }
  return releaseDateFromHtml(html);
}

function isbnFromProduct(product, html) {
  const direct = normalizeIsbn13(product && (product.gtin13 || product.isbn || product.isbn13 || product.sku || product.mpn));
  if (direct) return direct;
  const match = html.match(/(?:ISBN(?:-13)?|gtin13|EAN)[^0-9]{0,40}((?:978|979)[0-9\-\s]{10,24})/i);
  return match ? normalizeIsbn13(match[1]) : null;
}

function imageFromProduct(product, html) {
  const image = product && product.image;
  const fromProduct = Array.isArray(image) ? safeHttpsUrl(firstString(...image)) : safeHttpsUrl(firstString(image));
  if (fromProduct) return fromProduct;
  const og = html.match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["'][^>]*>/i);
  return og ? safeHttpsUrl(decodeHtml(og[1])) : null;
}

function titleContainsVolume(title, volumeNumber) {
  const escaped = String(volumeNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = normalizeTitle(title);
  return new RegExp(`(?:band|bd|volume|vol)?\\s*${escaped}(?:\\b|$)`, 'i').test(normalized);
}

function stripVolumeFromTitle(title, volumeNumber) {
  const escaped = String(volumeNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(title || '')
    .replace(new RegExp(`\\b(?:band|bd\\.?|volume|vol\\.?)\\s*${escaped}\\b`, 'ig'), '')
    .replace(new RegExp(`(?:[:#-]|\\s)${escaped}\\s*$`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const ogTitle = html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i);
  if (ogTitle) return decodeHtml(ogTitle[1]).trim();
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripTags(title[1]) : null;
}

function scoreProductTitle(candidate, productTitle, sourcePublisher, publisherPattern) {
  const expectedTitle = normalizeTitle(candidate.seriesTitle);
  const hitTitle = normalizeTitle(stripVolumeFromTitle(productTitle, candidate.volumeNumber));
  let score = 0;
  if (hitTitle === expectedTitle) score += 70;
  else if (hitTitle.includes(expectedTitle) || expectedTitle.includes(hitTitle)) score += 45;
  else {
    const expectedTokens = new Set(expectedTitle.split(' ').filter(token => token.length > 2));
    const tokenHits = hitTitle.split(' ').filter(token => expectedTokens.has(token)).length;
    score += Math.min(35, tokenHits * 10);
  }
  if (titleContainsVolume(productTitle, candidate.volumeNumber)) score += 20;
  if (publisherPattern && publisherPattern.test(String(sourcePublisher || ''))) score += 10;
  return score;
}

function publisherFromProduct(product, html, config) {
  const publisher = product && product.publisher;
  if (typeof publisher === 'string' && publisher.trim()) return publisher.trim();
  if (publisher && typeof publisher.name === 'string' && publisher.name.trim()) return publisher.name.trim();
  const brand = product && product.brand;
  if (typeof brand === 'string' && brand.trim()) return brand.trim();
  if (brand && typeof brand.name === 'string' && brand.name.trim()) return brand.name.trim();
  for (const alias of config.publisherAliases || []) {
    if (new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(html)) return alias;
  }
  return config.sourcePublisher || config.sourceName;
}

function absoluteUrl(href, baseUrl, hostnames) {
  if (!href) return null;
  try {
    const url = new URL(decodeHtml(href), baseUrl);
    url.hash = '';
    if (url.protocol !== 'https:') return null;
    if (hostnames && hostnames.length && !hostnames.includes(url.hostname)) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function extractSearchResultUrls(html, config) {
  const hostnames = config.hostnames || [new URL(config.baseUrl).hostname];
  const productPathPatterns = config.productPathPatterns || [/\/product/i, /\/products\//i, /\/produkt/i, /\/manga/i, /\/shop/i, /\/978(?:3|\d)/i];
  const urls = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const url = absoluteUrl(match[1], config.baseUrl, hostnames);
    if (!url) continue;
    const path = new URL(url).pathname;
    if (productPathPatterns.some(pattern => pattern.test(path))) urls.push(url);
  }
  return unique(urls).slice(0, config.maxSearchHits || 8);
}

function searchUrlForCandidate(candidate, config) {
  const query = `${candidate.seriesTitle} Band ${candidate.volumeNumber}`;
  const template = config.searchUrlTemplate;
  if (typeof template === 'function') return template(query, candidate);
  return String(template).replace('{query}', encodeURIComponent(query));
}

function buildGenericPublisherProvider(config) {
  const publisherPattern = new RegExp((config.publisherAliases || [config.sourceName]).map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

  async function search(candidate, ctx) {
    const html = await ctx.fetchHtml(searchUrlForCandidate(candidate, config), ctx.policy);
    return extractSearchResultUrls(html, config).map(url => ({ url }));
  }

  async function parseProduct(hit, candidate, ctx) {
    const url = typeof hit === 'string' ? hit : hit && hit.url;
    if (!url) return null;
    const html = hit.html || await ctx.fetchHtml(url, ctx.policy);
    const product = findProductJsonLd(html) || {};
    const productTitle = firstString(product.name, product.headline) || titleFromHtml(html);
    if (!productTitle || !titleContainsVolume(productTitle, candidate.volumeNumber)) return null;

    const sourcePublisher = publisherFromProduct(product, html, config);
    const score = scoreProductTitle(candidate, productTitle, sourcePublisher, publisherPattern);
    if (score < (config.minScore || 80)) return null;

    const releaseDate = releaseDateFromProduct(product, html);
    if (!releaseDate || releaseDate === '2999-12-31') return null;

    return {
      releaseDate,
      isbn13: isbnFromProduct(product, html),
      coverUrl: imageFromProduct(product, html),
      sourceUrl: safeHttpsUrl(firstString(product.url, url)) || url,
      sourceEditionTitle: stripVolumeFromTitle(productTitle, candidate.volumeNumber) || candidate.seriesTitle,
      sourcePublisher,
      sourceVolumeNumber: Number(candidate.volumeNumber),
      sourceVolumeSpecialType: null,
      sourceScore: score,
      sourceProductTitle: productTitle,
      sourceResult: 'volume-found',
      evidence: `${config.sourceName}-Produktseite: Produktname, Bandnummer und Erscheinungsdatum wurden aus JSON-LD oder sichtbarem HTML belegt.`,
    };
  }

  const provider = buildPublisherProvider({
    id: config.id,
    sourceName: config.sourceName,
    baseUrl: config.baseUrl,
    publisherAliases: config.publisherAliases,
    search,
    parseProduct,
  });
  provider._private = {
    decodeHtml,
    extractJsonLdObjects,
    extractSearchResultUrls: html => extractSearchResultUrls(html, config),
    findProductJsonLd,
    normalizeDate,
    parseProduct,
    releaseDateFromProduct,
    stripVolumeFromTitle,
    titleContainsVolume,
  };
  return provider;
}

module.exports = {
  buildGenericPublisherProvider,
  decodeHtml,
  extractJsonLdObjects,
  extractSearchResultUrls,
  findProductJsonLd,
  normalizeDate,
  stripVolumeFromTitle,
  titleContainsVolume,
};


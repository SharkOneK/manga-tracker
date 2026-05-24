'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'crunchyroll-manga',
  sourceName: 'Crunchyroll Manga',
  sourcePublisher: 'Crunchyroll Manga',
  baseUrl: 'https://www.crunchyroll.com',
  searchUrlTemplate: 'https://www.crunchyroll.com/search?q={query}',
  hostnames: ['www.crunchyroll.com', 'store.crunchyroll.com', 'www.kaze-online.de', 'vertrieb.kaze-online.de'],
  publisherAliases: ['Kazé Manga', 'Kaze Manga', 'Crunchyroll', 'Crunchyroll Manga'],
  productPathPatterns: [/\/products\//i, /\/manga\//i, /\/produkt\//i, /\/978(?:3|\d)/i],
});

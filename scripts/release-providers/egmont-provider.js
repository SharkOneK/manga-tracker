'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'egmont',
  sourceName: 'Egmont Manga',
  sourcePublisher: 'Egmont Manga',
  baseUrl: 'https://www.egmont-manga.de',
  searchUrlTemplate: 'https://www.egmont-shop.de/suche?query={query}',
  hostnames: ['www.egmont-manga.de', 'www.egmont-shop.de'],
  publisherAliases: ['Egmont', 'Egmont Manga'],
  productPathPatterns: [/\/produkt\//i, /\/manga\//i, /\/978(?:3|\d)/i],
});

'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'manga-cult',
  sourceName: 'Manga Cult',
  sourcePublisher: 'Manga Cult',
  baseUrl: 'https://www.manga-cult.de',
  searchUrlTemplate: 'https://www.manga-cult.de/suche?tx_indexedsearch_pi2%5Bsearch%5D%5Bsword%5D={query}',
  hostnames: ['www.manga-cult.de', 'www.cross-cult.de'],
  publisherAliases: ['Manga Cult'],
  productPathPatterns: [/\/titel\//i, /\/manga\//i, /\/produkt\//i, /\/978(?:3|\d)/i],
});

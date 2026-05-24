'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'panini',
  sourceName: 'Panini Manga',
  sourcePublisher: 'Panini Manga',
  baseUrl: 'https://www.paninishop.de/manga',
  searchUrlTemplate: 'https://www.paninishop.de/suche?q={query}',
  hostnames: ['www.paninishop.de', 'www.panini.de'],
  publisherAliases: ['Planet Manga', 'Panini', 'Panini Manga'],
  productPathPatterns: [/\/shp_deu_de\//i, /\/manga\//i, /\/products?\//i, /\/978(?:3|\d)/i],
});

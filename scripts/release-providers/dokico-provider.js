'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'dokico',
  sourceName: 'Dokico',
  sourcePublisher: 'Dokico',
  baseUrl: 'https://dokico.de',
  searchUrlTemplate: 'https://dokico.de/search?q={query}',
  publisherAliases: ['Dokico'],
  productPathPatterns: [/\/products\//i, /\/collections\//i],
});

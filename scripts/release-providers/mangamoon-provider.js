'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'mangamoon',
  sourceName: 'MangaMoon',
  sourcePublisher: 'MangaMoon',
  baseUrl: 'https://animoon-publishing.de',
  searchUrlTemplate: 'https://animoon-publishing.de/search?q={query}',
  publisherAliases: ['Animoon Publishing', 'MANGAMOON', 'MangaMoon'],
  productPathPatterns: [/\/products\//i, /\/collections\/mangamoon/i],
});

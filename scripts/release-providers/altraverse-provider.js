'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'altraverse',
  sourceName: 'Altraverse',
  sourcePublisher: 'Altraverse',
  baseUrl: 'https://altraverse.de',
  searchUrlTemplate: 'https://altraverse.de/search?search={query}',
  publisherAliases: ['Altraverse'],
  productPathPatterns: [/\/detail\//i, /\/manga\//i, /\/.*\/\d+[a-z0-9-]*$/i],
});

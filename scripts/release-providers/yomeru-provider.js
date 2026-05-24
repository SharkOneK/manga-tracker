'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'yomeru',
  sourceName: 'Yomeru',
  sourcePublisher: 'Yomeru',
  baseUrl: 'https://yomeru.de',
  searchUrlTemplate: 'https://yomeru.de/?s={query}&post_type=product',
  hostnames: ['yomeru.de', 'www.yomeru.de'],
  publisherAliases: ['Yomeru'],
  productPathPatterns: [/\/produkt\//i, /\/product\//i, /\/shop\//i],
});

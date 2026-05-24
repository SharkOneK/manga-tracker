'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'dani-books',
  sourceName: 'dani books',
  sourcePublisher: 'dani books',
  baseUrl: 'https://dani-books.com',
  searchUrlTemplate: 'https://dani-books.com/?s={query}',
  publisherAliases: ['Dani Books', 'dani books'],
  productPathPatterns: [/\/produkt\//i, /\/shop\//i, /\/manga\//i],
});

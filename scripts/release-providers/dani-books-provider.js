'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'dani-books',
  sourceName: 'dani books',
  baseUrl: 'https://dani-books.com',
  publisherAliases: ['dani books', 'Dani Books'],
});

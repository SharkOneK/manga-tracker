'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'egmont',
  sourceName: 'Egmont Manga',
  baseUrl: 'https://www.egmont-manga.de',
  publisherAliases: ['Egmont', 'Egmont Manga'],
});

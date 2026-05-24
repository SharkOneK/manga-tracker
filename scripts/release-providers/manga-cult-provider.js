'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'manga-cult',
  sourceName: 'Manga Cult',
  baseUrl: 'https://www.manga-cult.de',
  publisherAliases: ['Manga Cult'],
});

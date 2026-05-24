'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'panini',
  sourceName: 'Panini Manga',
  baseUrl: 'https://www.paninishop.de/manga',
  publisherAliases: ['Panini', 'Panini Manga', 'Planet Manga'],
});

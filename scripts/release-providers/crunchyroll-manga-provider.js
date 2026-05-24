'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'crunchyroll-manga',
  sourceName: 'Crunchyroll Manga',
  baseUrl: 'https://www.crunchyroll.com',
  publisherAliases: ['Crunchyroll Manga', 'Kazé Manga', 'Kaze Manga', 'Crunchyroll'],
});

'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'mangamoon',
  sourceName: 'MangaMoon',
  baseUrl: 'https://animoon-publishing.de',
  publisherAliases: ['MangaMoon', 'MANGAMOON', 'Animoon Publishing'],
});

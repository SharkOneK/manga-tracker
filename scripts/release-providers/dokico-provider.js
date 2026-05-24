'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'dokico',
  sourceName: 'Dokico',
  baseUrl: 'https://dokico.de',
  publisherAliases: ['Dokico'],
});

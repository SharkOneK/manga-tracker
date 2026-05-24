'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'altraverse',
  sourceName: 'Altraverse',
  baseUrl: 'https://altraverse.de',
  publisherAliases: ['Altraverse'],
});

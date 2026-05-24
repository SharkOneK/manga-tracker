'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'hayabusa',
  sourceName: 'Hayabusa',
  baseUrl: 'https://hayabusa.de',
  publisherAliases: ['Hayabusa'],
});

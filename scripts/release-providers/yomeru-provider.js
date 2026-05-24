'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'yomeru',
  sourceName: 'Yomeru',
  baseUrl: 'https://yomeru.de',
  publisherAliases: ['Yomeru'],
});

'use strict';

const { createNotImplementedPublisherProvider } = require('./publisher-provider-base');

module.exports = createNotImplementedPublisherProvider({
  id: 'tokyopop',
  sourceName: 'Tokyopop',
  baseUrl: 'https://www.tokyopop.de',
  publisherAliases: ['Tokyopop', 'Tokyo Pop', 'Tokyo-Pop'],
});

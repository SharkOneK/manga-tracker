'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'tokyopop',
  sourceName: 'Tokyopop',
  sourcePublisher: 'Tokyopop',
  baseUrl: 'https://www.tokyopop.de',
  searchUrlTemplate: 'https://www.tokyopop.de/search?search={query}',
  publisherAliases: ['Tokyo Pop', 'Tokyo-Pop', 'Tokyopop'],
  productPathPatterns: [/\/detail\//i, /\/manga\//i, /\/products?\//i],
});

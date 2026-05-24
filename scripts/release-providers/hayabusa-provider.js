'use strict';

const { buildGenericPublisherProvider } = require('./generic-publisher-provider');

module.exports = buildGenericPublisherProvider({
  id: 'hayabusa',
  sourceName: 'Hayabusa',
  sourcePublisher: 'Hayabusa',
  baseUrl: 'https://hayabusa.de',
  searchUrlTemplate: 'https://hayabusa.de/suche?q={query}',
  hostnames: ['hayabusa.de', 'www.hayabusa.de'],
  publisherAliases: ['Hayabusa'],
  productPathPatterns: [/\/manga\//i, /\/softcover\//i, /\/produkt\//i, /\/978(?:3|\d)/i],
});

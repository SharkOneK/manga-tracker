'use strict';

/**
 * Phase 57: schema validation for data/series-publication-status.json.
 *
 * Pure, dependency-free validator so it can run in the app (client mirror) and
 * in CI. Mirrors the strictness of validate-release-volume-counts.js.
 */

const ALLOWED_ONGOING = new Set(['true', 'false']);
const ALLOWED_SOURCE_STATUS = new Set([1, 2]);

function validateSeriesPublicationStatus(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['document-not-an-object'] };
  }
  if (doc.schemaVersion !== 1) errors.push('schemaVersion-must-be-1');
  if (typeof doc.generatedAt !== 'string' || !doc.generatedAt) errors.push('generatedAt-missing');
  if (!Array.isArray(doc.items)) {
    errors.push('items-not-an-array');
    return { ok: errors.length === 0, errors };
  }

  const seen = new Set();
  doc.items.forEach((item, index) => {
    const where = `items[${index}]`;
    if (!item || typeof item !== 'object') { errors.push(`${where}-not-an-object`); return; }
    if (typeof item.seriesTitle !== 'string' || !item.seriesTitle.trim()) errors.push(`${where}.seriesTitle-invalid`);
    if (typeof item.publisher !== 'string' || !item.publisher.trim()) errors.push(`${where}.publisher-invalid`);
    if (!ALLOWED_ONGOING.has(item.ongoing)) errors.push(`${where}.ongoing-must-be-true-or-false-string`);
    if (!ALLOWED_SOURCE_STATUS.has(Number(item.sourceStatus))) errors.push(`${where}.sourceStatus-unexpected`);
    if (!Number.isInteger(Number(item.editionId)) || Number(item.editionId) < 1) errors.push(`${where}.editionId-invalid`);
    if (typeof item.source !== 'string' || !item.source.trim()) errors.push(`${where}.source-invalid`);
    if (typeof item.sourceUrl !== 'string' || !item.sourceUrl.startsWith('https://')) errors.push(`${where}.sourceUrl-invalid`);
    if (item.confidence !== 'high') errors.push(`${where}.confidence-must-be-high`);
    if (typeof item.checkedAt !== 'string' || !item.checkedAt) errors.push(`${where}.checkedAt-missing`);

    const key = `${String(item.seriesTitle).toLowerCase()}|${String(item.publisher).toLowerCase()}`;
    if (seen.has(key)) errors.push(`${where}-duplicate-series-publisher`);
    seen.add(key);
  });

  return { ok: errors.length === 0, errors };
}

module.exports = { validateSeriesPublicationStatus };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const file = path.resolve(__dirname, '..', 'data', 'series-publication-status.json');
  if (!fs.existsSync(file)) {
    console.error(`❌ series-publication-status.json fehlt: ${file}`);
    process.exit(1);
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`❌ series-publication-status.json nicht lesbar: ${e.message}`); process.exit(1); }
  const result = validateSeriesPublicationStatus(doc);
  if (!result.ok) {
    console.error('❌ series-publication-status invalid:');
    result.errors.forEach(err => console.error(`- ${err}`));
    process.exit(1);
  }
  console.log(`✅ series-publication-status valid (data/series-publication-status.json) — ${doc.items.length} Serie(n)`);
}

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

class StorageMock {
  constructor(seed = {}) {
    this.store = { ...seed };
  }

  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }

  setItem(key, value) {
    this.store[key] = String(value);
  }

  removeItem(key) {
    delete this.store[key];
  }

  key(index) {
    return Object.keys(this.store)[index] || null;
  }

  get length() {
    return Object.keys(this.store).length;
  }
}

class ElementMock {
  constructor() {
    this.dataset = {};
    this.classList = { toggle() {} };
    this.textContent = "";
    this.innerHTML = "";
  }

  append() {}
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function volume(id, seriesId, volumeNumber, options = {}) {
  return {
    id,
    seriesId,
    volumeNumber,
    title: options.title || "Test Manga",
    publisher: "manga_cult",
    editionType: options.editionType,
    owned: Boolean(options.owned),
    read: Boolean(options.read),
    boughtAt: options.boughtAt || null,
    readAt: options.readAt || null,
    releaseDate: options.releaseDate || "",
    notes: options.notes || "",
  };
}

function makeDatabase() {
  const now = "2026-05-12T00:00:00.000Z";
  return {
    schemaVersion: 1,
    updatedAt: now,
    series: [
      {
        id: "test-manga",
        title: "Test Manga",
        publisher: "manga_cult",
        dates: { lastUpdated: now },
        links: {},
      },
    ],
    volumes: [
      volume("test-manga-001", "test-manga", 1, { editionType: "standard", owned: true, read: true, boughtAt: "2025-01-02", readAt: "2025-01-03", releaseDate: "2025-01-01" }),
      volume("test-manga-002", "test-manga", 2, { editionType: "standard", owned: true, releaseDate: "2025-02-01" }),
      volume("test-manga-003", "test-manga", 3, { editionType: "", owned: true, releaseDate: "2025-03-01" }),
      volume("test-manga-box-004", "test-manga", 4, { editionType: "boxset", owned: true, title: "Test Manga Box Set 1" }),
      volume("test-manga-005", "test-manga", 5, { editionType: "standard", owned: true, releaseDate: "2025-05-01" }),
      volume("test-manga-006", "test-manga", 6, { editionType: "standard", owned: false, releaseDate: "2026-01-01" }),
      volume("test-manga-007", "test-manga", 7, { editionType: "standard", owned: false, releaseDate: "2026-08-01" }),
      volume("test-manga-008", "test-manga", 8, { editionType: "standard", owned: false }),
      volume("test-manga-deluxe-001", "test-manga", 1, { editionType: "deluxe", owned: true, releaseDate: "2025-01-01" }),
      volume("test-manga-deluxe-003", "test-manga", 3, { editionType: "deluxe", owned: false, releaseDate: "2026-09-01" }),
    ],
  };
}

function makeContext(database) {
  const localStorage = new StorageMock({
    "mangaTracker.database.v1": JSON.stringify(database),
  });
  const app = new ElementMock();
  const tabs = new ElementMock();
  const storageStatus = new ElementMock();
  const context = {
    console,
    Blob,
    URL,
    TextEncoder,
    DataView,
    Uint8Array,
    Array,
    Map,
    Set,
    Date,
    Intl,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    RegExp,
    Math,
    parseInt,
    encodeURIComponent,
    setTimeout() { return 1; },
    clearTimeout() {},
    localStorage,
    sessionStorage: new StorageMock(),
    confirm() { return true; },
    fetch: async () => {
      throw new Error("Phase 6 analysis test must not fetch.");
    },
    window: {
      addEventListener() {},
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    document: {
      querySelector(selector) {
        if (selector === "#app") return app;
        if (selector === "#tabs") return tabs;
        if (selector === "#storageStatus") return storageStatus;
        if (selector === "#emptyStateTemplate") return { content: { cloneNode: () => new ElementMock() } };
        return null;
      },
      querySelectorAll() { return []; },
      createElement() { return new ElementMock(); },
    },
  };
  context.window.localStorage = localStorage;
  context.window.sessionStorage = context.sessionStorage;
  return context;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const context = makeContext(makeDatabase());
vm.createContext(context);
const appJs = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
vm.runInContext(appJs, context, { filename: "src/app.js" });

const api = context.window.mangaTrackerPhase6;
const state = api.getState();
const before = JSON.parse(JSON.stringify(state.database.volumes));
const syncBefore = JSON.stringify(state.syncConfig);
const backupKeysBeforeAnalysis = Object.keys(context.localStorage.store).filter((key) => key.startsWith("mangaTracker.backup."));

const standardMissing = api.getMissingVolumes("test-manga", "standard");
assert(standardMissing.some((row) => row.volumeNumber === 4), "Standard-Band 4 wurde nicht als fehlend erkannt.");

const standardRange = api.getKnownVolumeRange("test-manga", "standard");
assert(standardRange.volumeNumbers.includes(3), "Leere editionType wurde nicht als Standard behandelt.");
assert(!standardRange.volumeNumbers.includes(4), "Boxset wurde als Standard-Einzelband gezaehlt.");

const deluxeMissing = api.getMissingVolumes("test-manga", "deluxe");
assert(deluxeMissing.length === 1 && deluxeMissing[0].volumeNumber === 2, "Deluxe-Luecke wurde nicht getrennt erkannt.");
assert(!standardMissing.some((row) => row.volumeNumber === 2), "Deluxe wurde mit Standard vermischt.");

const releasedUnowned = api.getReleasedUnowned("test-manga", "standard");
assert(releasedUnowned.some((row) => row.volumeNumber === 6), "Erschienener, nicht gekaufter Band wurde nicht erkannt.");

const upcoming = api.getUpcomingVolumes("test-manga", "standard");
assert(upcoming.some((row) => row.volumeNumber === 7), "Kommender Band wurde nicht erkannt.");

const rows = api.getCollectionGapRows();
assert(rows.some((row) => row.volumeNumber === 4 && row.status === "missing"), "Sammelluecken-Zeile fuer fehlenden Band fehlt.");
assert(rows.some((row) => row.volumeNumber === 6 && row.status === "released_unowned"), "Sammelluecken-Zeile fuer erschienenen offenen Band fehlt.");
assert(rows.some((row) => row.volumeNumber === 7 && row.status === "upcoming"), "Sammelluecken-Zeile fuer kommenden Band fehlt.");
assert(rows.some((row) => row.volumeNumber === 8 && row.status === "unknown"), "Sammelluecken-Zeile fuer unbekannten offenen Band fehlt.");

const summary = api.getSeriesCollectionSummary("test-manga");
assert(summary.missingCount === 2, "Serien-Summary zaehlt fehlende Baende falsch.");
assert(summary.buyableCount === 1, "Serien-Summary zaehlt kaufbare Baende falsch.");
assert(summary.upcomingCount === 2, "Serien-Summary zaehlt kommende Baende falsch.");

const after = state.database.volumes;
before.forEach((oldVolume) => {
  const nextVolume = after.find((item) => item.id === oldVolume.id);
  ["owned", "read", "boughtAt", "readAt"].forEach((field) => {
    assert(JSON.stringify(nextVolume[field]) === JSON.stringify(oldVolume[field]), `${field} wurde veraendert.`);
  });
});

assert(JSON.stringify(state.syncConfig) === syncBefore, "JSONBin Sync-State wurde veraendert.");
const backupKeysAfterAnalysis = Object.keys(context.localStorage.store).filter((key) => key.startsWith("mangaTracker.backup."));
assert(JSON.stringify(backupKeysAfterAnalysis) === JSON.stringify(backupKeysBeforeAnalysis), "Analyse hat ein Backup oder eine Migration erzeugt.");

console.log("Phase 6 Analyse-Tests erfolgreich.");

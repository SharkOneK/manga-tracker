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

function makeDatabase() {
  const now = "2026-05-12T00:00:00.000Z";
  return {
    schemaVersion: 1,
    updatedAt: now,
    series: [
      {
        id: "chainsaw-man",
        title: "Chainsaw Man",
        publisher: "manga_cult",
        dates: { lastUpdated: now },
        links: {},
      },
    ],
    volumes: [
      {
        id: "chainsaw-man-001",
        seriesId: "chainsaw-man",
        volumeNumber: 1,
        title: "Chainsaw Man",
        publisher: "manga_cult",
        editionType: "standard",
        coverUrl: "",
        coverConfidence: 0,
        coverManuallySet: false,
        owned: true,
        read: true,
        boughtAt: "2025-01-02",
        readAt: "2025-01-03",
        releaseDate: "2025-01-01",
      },
      {
        id: "chainsaw-man-002",
        seriesId: "chainsaw-man",
        volumeNumber: 2,
        title: "Chainsaw Man",
        publisher: "manga_cult",
        editionType: "standard",
        coverUrl: "https://old.example/2.jpg",
        coverConfidence: 30,
        coverManuallySet: true,
        releaseDate: "2025-02-01",
      },
      {
        id: "chainsaw-man-003",
        seriesId: "chainsaw-man",
        volumeNumber: 3,
        title: "Chainsaw Man",
        publisher: "manga_cult",
        editionType: "standard",
        coverUrl: "https://old.example/3.jpg",
        coverConfidence: 60,
        coverManuallySet: false,
        releaseDate: "2025-03-01",
      },
      {
        id: "chainsaw-man-004",
        seriesId: "chainsaw-man",
        volumeNumber: 4,
        title: "Chainsaw Man",
        publisher: "manga_cult",
        editionType: "standard",
        coverUrl: "",
        coverConfidence: 0,
        coverManuallySet: false,
        releaseDate: "2025-04-01",
      },
      {
        id: "chainsaw-man-005",
        seriesId: "chainsaw-man",
        volumeNumber: 5,
        title: "Chainsaw Man",
        publisher: "manga_cult",
        editionType: "",
        isbn13: "9781234567897",
        coverUrl: "",
        coverConfidence: 0,
        coverManuallySet: false,
        releaseDate: "2025-05-01",
      },
    ],
  };
}

function makeCache() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-12T00:00:00.000Z",
    source: "manga-passion",
    itemCount: 4,
    items: [
      {
        seriesTitle: "Chainsaw Man",
        publisher: "Manga Cult",
        volumeNumber: 1,
        coverUrl: "https://cache.example/1.jpg",
        editionType: "standard",
        isbn13: "",
        confidence: 80,
      },
      {
        seriesTitle: "Chainsaw Man",
        publisher: "Manga Cult",
        volumeNumber: 2,
        coverUrl: "https://cache.example/2.jpg",
        editionType: "standard",
        confidence: 95,
      },
      {
        seriesTitle: "Chainsaw Man",
        publisher: "Manga Cult",
        volumeNumber: 3,
        coverUrl: "https://cache.example/3.jpg",
        editionType: "standard",
        confidence: 90,
      },
      {
        seriesTitle: "Chainsaw Man",
        publisher: "Manga Cult",
        volumeNumber: 4,
        coverUrl: "https://cache.example/4-deluxe.jpg",
        editionType: "deluxe",
        confidence: 99,
      },
      {
        seriesTitle: "Different Title",
        publisher: "Manga Cult",
        volumeNumber: 99,
        coverUrl: "https://cache.example/5-isbn.jpg",
        editionType: "standard",
        isbn13: "9781234567897",
        confidence: 88,
      },
    ],
  };
}

function makeContext(database, cache) {
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
    fetch: async (url) => {
      if (String(url) !== "./data/release-cache.json") {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => cache,
      };
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

(async () => {
  const context = makeContext(makeDatabase(), makeCache());
  vm.createContext(context);
  const appJs = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  vm.runInContext(appJs, context, { filename: "src/app.js" });

  await context.window.mangaTrackerPhase5.previewCoverUpdateForSeries("chainsaw-man");
  const state = context.window.mangaTrackerPhase5.getState();
  const rows = state.coverPreview.rows;

  assert(rows.some((row) => row.volumeId === "chainsaw-man-001"), "Band ohne Cover bekommt keinen Vorschlag.");
  assert(!rows.some((row) => row.volumeId === "chainsaw-man-002"), "Manuell gesetztes Cover wurde vorgeschlagen.");
  assert(rows.some((row) => row.volumeId === "chainsaw-man-003"), "Hoehere Confidence ersetzt altes Auto-Cover nicht.");
  assert(!rows.some((row) => row.volumeId === "chainsaw-man-004"), "Falsche Edition wurde nicht ignoriert.");
  assert(rows.some((row) => row.volumeId === "chainsaw-man-005"), "ISBN-13 Matching wurde nicht priorisiert.");

  const before = JSON.parse(JSON.stringify(state.database.volumes));
  context.window.mangaTrackerPhase5.applySelectedCoverPreview("chainsaw-man");
  const after = state.database.volumes;
  const volume1 = after.find((volume) => volume.id === "chainsaw-man-001");
  const volume2 = after.find((volume) => volume.id === "chainsaw-man-002");
  const volume3 = after.find((volume) => volume.id === "chainsaw-man-003");
  const volume4 = after.find((volume) => volume.id === "chainsaw-man-004");
  const volume5 = after.find((volume) => volume.id === "chainsaw-man-005");

  assert(volume1.coverUrl === "https://cache.example/1.jpg", "Band ohne Cover wurde nicht aktualisiert.");
  assert(volume2.coverUrl === "https://old.example/2.jpg", "Manuelles Cover wurde veraendert.");
  assert(volume3.coverUrl === "https://cache.example/3.jpg", "Hoehere Confidence wurde nicht uebernommen.");
  assert(volume4.coverUrl === "", "Falsche Edition wurde uebernommen.");
  assert(volume5.coverUrl === "https://cache.example/5-isbn.jpg", "ISBN-13 Match wurde nicht uebernommen.");

  before.forEach((oldVolume) => {
    const nextVolume = after.find((volume) => volume.id === oldVolume.id);
    ["owned", "read", "boughtAt", "readAt", "releaseDate"].forEach((field) => {
      assert(JSON.stringify(nextVolume[field]) === JSON.stringify(oldVolume[field]), `${field} wurde veraendert.`);
    });
  });

  assert(state.syncConfig.pendingPush === false, "JSONBin Sync-State wurde unerwartet instabil.");
  const exported = after.map((volume) => `${volume.volumeNumber}:${volume.releaseDate}:${volume.owned}:${volume.read}`).join("|");
  assert(exported.includes("1:2025-01-01:true:true"), "Obsidian-relevante Banddaten sind instabil.");
  assert(Object.keys(context.localStorage.store).some((key) => key.startsWith("mangaTracker.backup.release-cache-cover-preview.")), "Backup wurde nicht erstellt.");

  console.log("Phase 5 Cover-Cache Tests erfolgreich.");
})();

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
    publisher: options.publisher,
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
        id: "alpha",
        title: "Alpha",
        publisher: "manga_cult",
        dates: { lastUpdated: now },
        links: {},
      },
      {
        id: "beta",
        title: "Beta",
        publisher: "egmont",
        dates: { lastUpdated: now },
        links: {},
      },
    ],
    volumes: [
      volume("alpha-001", "alpha", 1, { publisher: "manga_cult", editionType: "standard", owned: true, read: true, releaseDate: "2025-01-01" }),
      volume("alpha-002", "alpha", 2, { publisher: "manga_cult", editionType: "standard", owned: true, read: false, releaseDate: "2025-02-01" }),
      volume("alpha-002b", "alpha", 2, { publisher: "manga_cult", editionType: "standard", owned: false, read: true, releaseDate: "2025-02-01" }),
      volume("alpha-004", "alpha", 4, { publisher: "manga_cult", editionType: "", owned: false, read: false, releaseDate: "2026-05-20" }),
      volume("alpha-deluxe-001", "alpha", 1, { publisher: "manga_cult", editionType: "deluxe", owned: false, read: false, releaseDate: "2026-06-20" }),
      volume("beta-001", "beta", 1, { publisher: "", editionType: "limited", owned: true, read: true, releaseDate: "2025-03-01" }),
      volume("beta-002", "beta", 2, { publisher: "egmont", editionType: "limited", owned: false, read: false }),
      volume("beta-003", "beta", 3, { publisher: "egmont", editionType: "boxset", owned: false, read: false, releaseDate: "2025-04-01" }),
    ],
  };
}

function makeCache() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-12T00:00:00.000Z",
    source: "manga-passion",
    itemCount: 1,
    items: [
      {
        seriesTitle: "Alpha",
        publisher: "Manga Cult",
        volumeNumber: 3,
        releaseDate: "2026-05-01",
        editionType: "standard",
        isbn13: "9781234567003",
        sourceUrl: "https://example.test/alpha-3",
        confidence: 90,
      },
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
    fetch: async (url) => {
      if (String(url) !== "./data/release-cache.json") {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return {
        ok: true,
        json: async () => makeCache(),
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
  const context = makeContext(makeDatabase());
  vm.createContext(context);
  const appJs = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  vm.runInContext(appJs, context, { filename: "src/app.js" });

  const api = context.window.mangaTrackerPhase7;
  const state = api.getState();
  state.buyGapCache = {
    status: "ok",
    items: makeCache().items,
    generatedAt: "2026-05-12T00:00:00.000Z",
    itemCount: 1,
    error: "",
  };
  const before = JSON.stringify(state.database);
  const syncBefore = JSON.stringify(state.syncConfig);
  const backupsBefore = Object.keys(context.localStorage.store).filter((key) => key.startsWith("mangaTracker.backup."));

  const stats = api.getDashboardStats();
  assert(stats.totals.seriesCount === 2, "Serienzahl ist falsch.");
  assert(stats.totals.volumeCount === 8, "Bandzahl ist falsch.");
  assert(stats.totals.ownedCount === 3, "Gekaufte Baende sind falsch.");
  assert(stats.totals.readOwnedCount === 2, "Gelesene gekaufte Baende sind falsch.");
  assert(stats.totals.readingProgressPercent === 67, "Lesefortschritt wurde falsch gerundet.");

  assert(stats.collection.missingCount === 1, "Fehlende Baende wurden falsch gezaehlt.");
  assert(stats.collection.buyableLocalCount === 2, "Lokale Kaufkandidaten wurden falsch gezaehlt.");
  assert(stats.collection.derivedBuyableGapCount === 1, "Ableitbare kaufbare Luecke fehlt.");
  assert(stats.collection.upcomingCount === 2, "Kommende Baende wurden falsch gezaehlt.");
  assert(stats.collection.unknownOpenCount === 1, "Offene Baende ohne Release-Datum wurden falsch gezaehlt.");

  assert(stats.releases.nextRelease.id === "alpha-004", "Naechster Release ist falsch.");
  assert(stats.releases.releasesNext30Days.length === 1, "30-Tage-Releases wurden falsch gezaehlt.");
  assert(stats.releases.releasesNext30Days[0].id === "alpha-004", "Falscher 30-Tage-Release.");

  assert(stats.publishers.topPublisher.publisher === "manga_cult", "Top Verlag ist falsch.");
  assert(stats.publishers.topPublisher.label === "Manga Cult", "Publisher-Label fehlt.");
  assert(stats.publishers.volumeCounts.find((row) => row.publisher === "egmont").count === 3, "Publisher-Fallback ist falsch.");

  assert(stats.editions.counts.find((row) => row.editionType === "standard").count === 4, "Standard-Edition zaehlt leere editionType nicht.");
  assert(stats.editions.counts.find((row) => row.editionType === "limited").count === 2, "Limited-Edition wurde falsch gezaehlt.");
  assert(stats.editions.counts.find((row) => row.editionType === "boxset").count === 1, "Boxset wurde falsch gezaehlt.");

  assert(stats.dataQuality.readWithoutOwnedCount === 1, "read=true ohne owned wurde nicht erkannt.");
  assert(stats.dataQuality.volumesWithoutReleaseDateCount === 1, "Fehlendes Release-Datum wurde nicht erkannt.");
  assert(stats.dataQuality.duplicateVolumeNumberCount === 1, "Doppelte Bandnummer wurde nicht erkannt.");
  assert(JSON.stringify(state.database) === before, "getDashboardStats hat Daten veraendert.");
  assert(JSON.stringify(state.syncConfig) === syncBefore, "getDashboardStats hat Sync-State veraendert.");
  const backupsAfterStats = Object.keys(context.localStorage.store).filter((key) => key.startsWith("mangaTracker.backup."));
  assert(JSON.stringify(backupsAfterStats) === JSON.stringify(backupsBefore), "getDashboardStats hat Backups erzeugt.");

  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert(!indexHtml.includes('data-tab="collectionGaps"'), "Sammelluecken-Tab ist noch sichtbar.");

  const appSource = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  assert(appSource.includes("function pullFromCloud") && appSource.includes("function pushToCloud"), "JSONBin Sync-Funktionen fehlen unerwartet.");
  assert(appSource.includes("function exportObsidianZip"), "Obsidian Export fehlt unerwartet.");
  assert(appSource.includes("mangaTracker.supabaseMeta.v1"), "Supabase Meta-Speicher fehlt.");

  const supabaseApi = context.window.mangaTrackerPhase8;
  context.localStorage.setItem("mangaTracker.supabaseMeta.v1", "{kaputt");
  const recoveredMeta = supabaseApi.loadSupabaseMeta();
  assert(recoveredMeta.lastStatus === "not-configured", "Kaputte Supabase Meta-Werte fallen nicht auf Defaults zurueck.");
  supabaseApi.saveSupabaseMeta({
    lastPushAt: "2026-05-13T10:00:00.000Z",
    lastError: "Testfehler",
    lastUserEmail: "user@example.test",
    autoPushEnabled: true,
    lastStatus: "ok",
  });
  const storedMeta = JSON.parse(context.localStorage.getItem("mangaTracker.supabaseMeta.v1"));
  assert(storedMeta.autoPushEnabled === true, "Supabase Auto-Push-Meta wird nicht gespeichert.");
  assert(storedMeta.lastError === "Testfehler", "Supabase Fehler-Meta wird nicht gespeichert.");
  assert(supabaseApi.maskSecret("sb_publishable_1234567890abcdef").includes("..."), "Supabase Key wird nicht maskiert.");
  assert(supabaseApi.getSupabaseKeyType("sb_publishable_abc") === "publishable", "Publishable Key-Typ wird nicht erkannt.");
  assert(supabaseApi.getSupabaseKeyType("aaa.bbb.ccc") === "legacy anon JWT", "Legacy anon JWT Key-Typ wird nicht erkannt.");

  const collectionSections = api.getCollectionSections();
  assert(collectionSections.unread.length === 1 && collectionSections.unread[0].id === "alpha-002", "Sammlung trennt ungelesene Baende falsch.");
  assert(collectionSections.read.length === 2 && collectionSections.read.some((volume) => volume.id === "alpha-001") && collectionSections.read.some((volume) => volume.id === "beta-001"), "Sammlung trennt gelesene Baende falsch.");

  const unreadCard = api.renderVolumeCard(collectionSections.unread[0], "collection");
  const readCard = api.renderVolumeCard(collectionSections.read[0], "collection");
  assert(unreadCard.includes("Als gelesen markieren"), "Ungelesene Baende zeigen keine passende Aktion.");
  assert(readCard.includes("Als ungelesen markieren"), "Gelesene Baende zeigen keine passende Aktion.");

  const formHtml = api.renderVolumeForm("beta-001").innerHTML;
  assert(!formHtml.includes('name="editionType"'), "Band-bearbeiten-Formular zeigt weiterhin ein Edition-Feld.");
  assert(!formHtml.includes(">Edition</label>"), "Band-bearbeiten-Formular zeigt weiterhin ein Edition-Label.");

  const fakeForm = {
    dataset: { id: "beta-001" },
    elements: {
      seriesId: { value: "beta" },
      volumeNumber: { value: "1" },
      title: { value: "Beta" },
      subtitle: { value: "" },
      isbn: { value: "" },
      isbn13: { value: "" },
      publisher: { value: "egmont" },
      releaseDate: { value: "2025-03-01" },
      releaseSource: { value: "" },
      releaseConfidence: { value: "" },
      coverUrl: { value: "" },
      coverSource: { value: "" },
      coverConfidence: { value: "" },
      coverCheckedAt: { value: "" },
      coverHash: { value: "" },
      coverManuallySet: { checked: false },
      owned: { checked: true },
      boughtAt: { value: "" },
      read: { checked: true },
      readAt: { value: "" },
      price: { value: "" },
      shopUrl: { value: "" },
      editionFingerprint: { value: "" },
      notes: { value: "" },
    },
  };
  api.handleVolumeSubmit(fakeForm);
  const beta = state.database.volumes.find((volume) => volume.id === "beta-001");
  assert(beta.editionType === "limited", "Bestehender editionType-Wert wurde beim Bearbeiten nicht erhalten.");
  assert(JSON.stringify(state.syncConfig) === syncBefore, "JSONBin Sync-State wurde durch UI-Workflow veraendert.");

  const backupsAfter = Object.keys(context.localStorage.store).filter((key) => key.startsWith("mangaTracker.backup."));
  assert(JSON.stringify(backupsAfter) === JSON.stringify(backupsBefore), "UI-Workflow-Test hat unerwartet Backups erzeugt.");

  state.database.debugData = { shouldNotSync: true };
  const payloadReport = api.getSyncPayloadSizeReport();
  assert(payloadReport.totalBytes > 0, "Sync-Payload-Groesse ist nicht messbar.");
  assert(payloadReport.seriesCount === 2, "Sync-Payload-Groesse zaehlt Serien falsch.");
  assert(payloadReport.volumeCount === 8, "Sync-Payload-Groesse zaehlt Baende falsch.");
  assert(payloadReport.backupsBytes === 0, "Backups duerfen nicht Teil der Sync-Payload sein.");

  state.syncConfig.enabled = true;
  state.syncConfig.binId = "test-bin";
  state.syncConfig.accessKey = "test-key";
  state.syncInProgress = false;
  let capturedPushBody = "";
  context.fetch = async (url, options) => {
    capturedPushBody = options.body;
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "Forbidden: invalid access key" }),
    };
  };
  await api.pushToCloud();
  assert(!JSON.parse(capturedPushBody).debugData, "Sync-Payload enthaelt versehentliche Hilfsdaten.");
  assert(state.syncMessage.includes("JSONBin Push fehlgeschlagen: 403 - Forbidden: invalid access key"), "JSONBin Push-Fehler zeigt den Response-Text nicht im Sync-Status.");

  state.database.volumes[0].notes = "x".repeat(98 * 1024);
  let fetchCalledForLargePayload = false;
  context.fetch = async () => {
    fetchCalledForLargePayload = true;
    return {
      ok: true,
      json: async () => ({}),
      text: async () => "",
    };
  };
  const largePushResult = await api.pushToCloud();
  assert(largePushResult.reason === "payload-too-large", "Grosse Sync-Payload wurde nicht vorab geblockt.");
  assert(fetchCalledForLargePayload === false, "Grosse Sync-Payload wurde trotzdem an JSONBin gesendet.");
  assert(state.syncMessage.includes("über der 95-KB-Sicherheitsgrenze"), "Grosse Sync-Payload bekommt keine klare Warnung.");

  console.log("Phase 7 Dashboard-Stats Tests erfolgreich.");
})();

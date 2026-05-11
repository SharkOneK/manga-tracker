(function () {
  "use strict";

  const STORAGE_KEY = "mangaTracker.database.v1";
  const BACKUP_PREFIX = "mangaTracker.backup.";
  const SYNC_CONFIG_KEY = "mangaTracker.syncConfig.v1";
  const SYNC_SESSION_KEY = "mangaTracker.syncAccessKey.session";
  const SYNC_CONFLICTS_KEY = "mangaTracker.syncConflicts.v1";
  const JSONBIN_API_ROOT = "https://api.jsonbin.io/v3";
  const TODAY = new Date().toISOString().slice(0, 10);
  const app = document.querySelector("#app");
  const tabs = document.querySelector("#tabs");
  const storageStatus = document.querySelector("#storageStatus");

  const statusValues = ["planned", "reading", "paused", "completed", "dropped"];
  const collectionStatusValues = ["wishlist", "collecting", "complete", "missing_volumes", "sold"];
  const publisherValues = ["carlsen", "tokyopop_de", "egmont", "manga_cult", "altraverse", "panini_de", "cross_cult", "other"];
  const editionTypeValues = ["standard", "deluxe", "collector", "limited", "boxset", "other"];
  const statusLabels = {
    planned: "Geplant",
    reading: "Lese ich",
    paused: "Pausiert",
    completed: "Abgeschlossen",
    dropped: "Abgebrochen",
  };
  const collectionStatusLabels = {
    wishlist: "Wunschliste",
    collecting: "Sammle ich",
    complete: "Vollständig",
    missing_volumes: "Fehlende Bände",
    sold: "Verkauft",
  };
  const publisherLabels = {
    carlsen: "Carlsen Manga",
    tokyopop_de: "TOKYOPOP Deutschland",
    egmont: "Egmont Manga",
    manga_cult: "Manga Cult",
    altraverse: "altraverse",
    panini_de: "Panini Manga",
    cross_cult: "Cross Cult Manga",
    other: "Sonstiger Verlag",
  };
  const publisherAliases = {
    carlsen: "carlsen",
    "carlsen manga": "carlsen",
    "carlsen verlag": "carlsen",
    tokyopop: "tokyopop_de",
    "tokyopop deutschland": "tokyopop_de",
    egmont: "egmont",
    "egmont manga": "egmont",
    "manga cult": "manga_cult",
    altraverse: "altraverse",
    panini: "panini_de",
    "panini manga": "panini_de",
    "panini deutschland": "panini_de",
    "cross cult": "cross_cult",
    "cross cult manga": "cross_cult",
    other: "other",
  };

  const state = {
    activeTab: "dashboard",
    database: loadDatabase(),
    syncConfig: loadSyncConfig(),
    syncStatus: "offline-ready",
    syncMessage: "",
    syncInProgress: false,
    syncRetryTimer: null,
    editingSeriesId: null,
    editingVolumeId: null,
    notice: "",
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyDatabase() {
    return {
      schemaVersion: 1,
      updatedAt: nowIso(),
      series: [],
      volumes: [],
    };
  }

  function loadDatabase() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const empty = createEmptyDatabase();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(empty));
      return empty;
    }

    try {
      const parsed = JSON.parse(raw);
      const validation = validateDatabase(parsed);
      if (!validation.valid) {
        console.warn("Ungültige Datenbank im localStorage:", validation.errors);
        return createEmptyDatabase();
      }
      const migration = migratePublisherValues(parsed);
      if (migration.changed) {
        backupDatabaseSnapshot(parsed, "publisher-migration");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migration.database));
      }
      return normalizeDatabase(migration.database);
    } catch (error) {
      console.warn("Datenbank konnte nicht gelesen werden:", error);
      return createEmptyDatabase();
    }
  }

  function loadSyncConfig() {
    const defaults = {
      enabled: false,
      binId: "",
      persistKey: false,
      accessKey: "",
      lastSyncAt: null,
      lastSyncStatus: "not-configured",
      pendingPush: false,
    };

    try {
      const stored = JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY) || "{}");
      const sessionKey = sessionStorage.getItem(SYNC_SESSION_KEY) || "";
      return {
        ...defaults,
        ...stored,
        accessKey: stored.persistKey ? String(stored.accessKey || "") : sessionKey,
      };
    } catch (error) {
      console.warn("Sync-Konfiguration konnte nicht gelesen werden:", error);
      return defaults;
    }
  }

  function saveSyncConfig() {
    const configForLocalStorage = {
      enabled: Boolean(state.syncConfig.enabled),
      binId: state.syncConfig.binId.trim(),
      persistKey: Boolean(state.syncConfig.persistKey),
      accessKey: state.syncConfig.persistKey ? state.syncConfig.accessKey : "",
      lastSyncAt: state.syncConfig.lastSyncAt,
      lastSyncStatus: state.syncConfig.lastSyncStatus,
      pendingPush: Boolean(state.syncConfig.pendingPush),
    };

    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(configForLocalStorage));
    if (state.syncConfig.persistKey) {
      sessionStorage.removeItem(SYNC_SESSION_KEY);
    } else if (state.syncConfig.accessKey) {
      sessionStorage.setItem(SYNC_SESSION_KEY, state.syncConfig.accessKey);
    } else {
      sessionStorage.removeItem(SYNC_SESSION_KEY);
    }
  }

  function isSyncConfigured() {
    return Boolean(state.syncConfig.enabled && state.syncConfig.binId.trim() && state.syncConfig.accessKey.trim());
  }

  function setSyncStatus(status, message = "") {
    state.syncStatus = status;
    state.syncMessage = message;
    state.syncConfig.lastSyncStatus = status;
    saveSyncConfig();
    updateStorageStatus();
  }

  function saveDatabase(options = {}) {
    const { sync = true } = options;
    state.database.updatedAt = nowIso();
    saveLocalDatabase();
    updateStorageStatus();
    if (sync) queuePushToCloud();
  }

  function saveLocalDatabase() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.database));
  }

  function backupDatabaseSnapshot(database, reason = "backup") {
    const backupKey = `${BACKUP_PREFIX}${reason}.${nowIso()}`;
    localStorage.setItem(backupKey, JSON.stringify(database));
    return backupKey;
  }

  function normalizeDatabase(database) {
    return {
      schemaVersion: 1,
      updatedAt: normalizeTimestamp(database.updatedAt),
      series: Array.isArray(database.series) ? database.series.map(normalizeSeries) : [],
      volumes: Array.isArray(database.volumes) ? database.volumes.map(normalizeVolume) : [],
    };
  }

  function normalizeSeries(series) {
    return {
      id: String(series.id || slugify(series.title || "serie")),
      title: String(series.title || ""),
      originalTitle: String(series.originalTitle || ""),
      type: String(series.type || "manga"),
      status: statusValues.includes(series.status) ? series.status : "planned",
      collectionStatus: collectionStatusValues.includes(series.collectionStatus) ? series.collectionStatus : "wishlist",
      publisher: normalizePublisher(series.publisher),
      imprint: String(series.imprint || ""),
      authors: normalizeStringArray(series.authors),
      artists: normalizeStringArray(series.artists),
      genres: normalizeStringArray(series.genres),
      tags: normalizeStringArray(series.tags),
      language: String(series.language || "de"),
      country: String(series.country || "DE"),
      coverUrl: String(series.coverUrl || ""),
      notes: String(series.notes || ""),
      favorite: Boolean(series.favorite),
      archived: Boolean(series.archived),
      dates: {
        started: series.dates?.started || null,
        finished: series.dates?.finished || null,
        lastUpdated: normalizeTimestamp(series.dates?.lastUpdated),
        lastReleaseCheck: series.dates?.lastReleaseCheck || null,
      },
      links: {
        publisher: String(series.links?.publisher || ""),
        shop: String(series.links?.shop || ""),
        anilist: String(series.links?.anilist || ""),
        mangaupdates: String(series.links?.mangaupdates || ""),
        mangaPassion: String(series.links?.mangaPassion || ""),
      },
    };
  }

  function labelFor(labels, value) {
    return labels[value] || value;
  }

  function statusLabel(value) {
    return labelFor(statusLabels, value);
  }

  function collectionStatusLabel(value) {
    return labelFor(collectionStatusLabels, value);
  }

  function normalizePublisher(value) {
    const publisher = String(value || "").trim();
    if (publisherValues.includes(publisher)) return publisher;
    const normalized = publisher.toLowerCase().replace(/\s+/g, " ");
    return publisherAliases[normalized] || "other";
  }

  function getPublisherLabel(value) {
    return labelFor(publisherLabels, value);
  }

  function migratePublisherValues(database) {
    const migratedDatabase = {
      ...database,
      series: Array.isArray(database?.series) ? database.series.map((series) => ({
        ...series,
        publisher: normalizePublisher(series?.publisher),
      })) : [],
      volumes: Array.isArray(database?.volumes) ? database.volumes.map((volume) => ({
        ...volume,
        publisher: normalizePublisher(volume?.publisher),
      })) : [],
    };
    const originalSeries = Array.isArray(database?.series) ? database.series : [];
    const originalVolumes = Array.isArray(database?.volumes) ? database.volumes : [];
    const seriesChanged = migratedDatabase.series.some((series, index) => series.publisher !== String(originalSeries[index]?.publisher || ""));
    const volumesChanged = migratedDatabase.volumes.some((volume, index) => volume.publisher !== String(originalVolumes[index]?.publisher || ""));

    return {
      database: migratedDatabase,
      changed: seriesChanged || volumesChanged,
    };
  }

  function normalizeVolume(volume) {
    return {
      id: String(volume.id || `${volume.seriesId || "serie"}-${String(volume.volumeNumber || 1).padStart(3, "0")}`),
      seriesId: String(volume.seriesId || ""),
      volumeNumber: Number(volume.volumeNumber || 1),
      title: String(volume.title || ""),
      subtitle: String(volume.subtitle || ""),
      isbn: String(volume.isbn || ""),
      publisher: normalizePublisher(volume.publisher),
      releaseDate: String(volume.releaseDate || ""),
      coverUrl: String(volume.coverUrl || ""),
      coverSource: String(volume.coverSource || ""),
      coverManuallySet: Boolean(volume.coverManuallySet),
      owned: Boolean(volume.owned),
      boughtAt: volume.boughtAt || null,
      read: Boolean(volume.read),
      readAt: volume.readAt || null,
      price: volume.price === null || volume.price === "" || Number.isNaN(Number(volume.price)) ? null : Number(volume.price),
      shopUrl: String(volume.shopUrl || ""),
      editionType: editionTypeValues.includes(volume.editionType) ? volume.editionType : "standard",
      notes: String(volume.notes || ""),
      createdAt: volume.createdAt || TODAY,
      updatedAt: normalizeTimestamp(volume.updatedAt),
    };
  }

  function normalizeTimestamp(value) {
    if (!value) return nowIso();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  function validateDatabase(database) {
    const errors = [];
    if (!database || typeof database !== "object") errors.push("Root muss ein Objekt sein.");
    if (database?.schemaVersion !== 1) errors.push("schemaVersion muss 1 sein.");
    if (!Array.isArray(database?.series)) errors.push("series muss ein Array sein.");
    if (!Array.isArray(database?.volumes)) errors.push("volumes muss ein Array sein.");

    const seriesIds = new Set();
    if (Array.isArray(database?.series)) {
      database.series.forEach((series, index) => {
        if (!series.id) errors.push(`series[${index}].id fehlt.`);
        if (!series.title) errors.push(`series[${index}].title fehlt.`);
        if (series.id && seriesIds.has(series.id)) errors.push(`Doppelte Serien-ID: ${series.id}`);
        if (series.id) seriesIds.add(series.id);
      });
    }

    const volumeIds = new Set();
    if (Array.isArray(database?.volumes)) {
      database.volumes.forEach((volume, index) => {
        if (!volume.id) errors.push(`volumes[${index}].id fehlt.`);
        if (!volume.seriesId) errors.push(`volumes[${index}].seriesId fehlt.`);
        if (volume.seriesId && !seriesIds.has(volume.seriesId)) errors.push(`Unbekannte seriesId bei Band ${volume.id || index}.`);
        if (volume.id && volumeIds.has(volume.id)) errors.push(`Doppelte Band-ID: ${volume.id}`);
        if (volume.id) volumeIds.add(volume.id);
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async function initSync() {
    if (!state.syncConfig.enabled) {
      setSyncStatus("disabled", "JSONBin Sync ist deaktiviert.");
      render();
      return;
    }

    if (!isSyncConfigured()) {
      setSyncStatus("missing-config", "JSONBin Sync ist aktiviert, aber Bin-ID oder X-Access-Key fehlt.");
      render();
      return;
    }

    await pullFromCloud();
  }

  async function pullFromCloud() {
    if (!isSyncConfigured() || state.syncInProgress) return { ok: false, reason: "not-ready" };
    state.syncInProgress = true;
    setSyncStatus("syncing", "Synchronisiere mit JSONBin...");
    render();

    try {
      const response = await fetch(`${JSONBIN_API_ROOT}/b/${encodeURIComponent(state.syncConfig.binId.trim())}/latest`, {
        method: "GET",
        headers: {
          "X-Access-Key": state.syncConfig.accessKey.trim(),
          "X-Bin-Meta": "false",
        },
      });

      if (!response.ok) {
        throw new Error(`JSONBin Pull fehlgeschlagen: ${response.status}`);
      }

      const payload = await response.json();
      const cloudDatabase = payload?.record && payload?.metadata ? payload.record : payload;
      const validation = validateDatabase(cloudDatabase);
      if (!validation.valid) {
        throw new Error(`Cloud-Daten sind ungültig: ${validation.errors.join(" ")}`);
      }

      const cloudMigration = migratePublisherValues(cloudDatabase);
      const result = resolveConflict(state.database, normalizeDatabase(cloudMigration.database));
      if (result.winner === "cloud") {
        createBackupBeforeSync("cloud-won");
        state.database = result.database;
        saveLocalDatabase();
        logConflict(result);
        setNotice("Cloud-Daten waren neuer und wurden lokal übernommen.");
      } else if (result.winner === "local") {
        logConflict(result);
        await pushToCloud({ silent: true });
        setNotice("Lokale Daten waren neuer und wurden in JSONBin gespeichert.");
      } else if (state.syncConfig.pendingPush) {
        await pushToCloud({ silent: true });
      }

      state.syncConfig.pendingPush = false;
      state.syncConfig.lastSyncAt = nowIso();
      setSyncStatus("ok", "JSONBin Sync abgeschlossen.");
      saveSyncConfig();
      render();
      return { ok: true, winner: result.winner };
    } catch (error) {
      console.warn(error);
      state.syncConfig.pendingPush = true;
      setSyncStatus("error", `${error.message}. Die App arbeitet lokal weiter.`);
      saveSyncConfig();
      scheduleSyncRetry();
      render();
      return { ok: false, error };
    } finally {
      state.syncInProgress = false;
    }
  }

  async function pushToCloud(options = {}) {
    const { silent = false } = options;
    if (!isSyncConfigured()) return { ok: false, reason: "not-configured" };
    if (state.syncInProgress && !silent) return { ok: false, reason: "busy" };

    if (!silent) {
      state.syncInProgress = true;
      setSyncStatus("syncing", "Speichere in JSONBin...");
      render();
    }

    try {
      const response = await fetch(`${JSONBIN_API_ROOT}/b/${encodeURIComponent(state.syncConfig.binId.trim())}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Key": state.syncConfig.accessKey.trim(),
          "X-Bin-Versioning": "true",
        },
        body: JSON.stringify(state.database),
      });

      if (!response.ok) {
        throw new Error(`JSONBin Push fehlgeschlagen: ${response.status}`);
      }

      state.syncConfig.pendingPush = false;
      state.syncConfig.lastSyncAt = nowIso();
      setSyncStatus("ok", "Lokal gespeichert und mit JSONBin synchronisiert.");
      saveSyncConfig();
      if (!silent) render();
      return { ok: true };
    } catch (error) {
      console.warn(error);
      state.syncConfig.pendingPush = true;
      setSyncStatus("error", `${error.message}. Lokal gespeichert, Cloud-Sync wird später erneut versucht.`);
      saveSyncConfig();
      scheduleSyncRetry();
      if (!silent) render();
      return { ok: false, error };
    } finally {
      if (!silent) state.syncInProgress = false;
    }
  }

  function queuePushToCloud() {
    if (!state.syncConfig.enabled) return;
    if (!isSyncConfigured()) {
      state.syncConfig.pendingPush = true;
      setSyncStatus("missing-config", "Lokal gespeichert. Für JSONBin fehlen Bin-ID oder X-Access-Key.");
      return;
    }
    pushToCloud({ silent: true });
  }

  function scheduleSyncRetry() {
    if (!state.syncConfig.enabled || state.syncRetryTimer) return;
    state.syncRetryTimer = window.setTimeout(() => {
      state.syncRetryTimer = null;
      if (state.syncConfig.pendingPush) {
        pushToCloud({ silent: true });
      } else {
        pullFromCloud();
      }
    }, 30000);
  }

  function resolveConflict(localDatabase, cloudDatabase) {
    const localUpdatedAt = Date.parse(localDatabase.updatedAt || "");
    const cloudUpdatedAt = Date.parse(cloudDatabase.updatedAt || "");
    const localTime = Number.isNaN(localUpdatedAt) ? 0 : localUpdatedAt;
    const cloudTime = Number.isNaN(cloudUpdatedAt) ? 0 : cloudUpdatedAt;

    if (cloudTime > localTime) {
      return {
        winner: "cloud",
        database: cloudDatabase,
        localUpdatedAt: localDatabase.updatedAt,
        cloudUpdatedAt: cloudDatabase.updatedAt,
        resolvedAt: nowIso(),
      };
    }

    if (localTime > cloudTime) {
      return {
        winner: "local",
        database: localDatabase,
        localUpdatedAt: localDatabase.updatedAt,
        cloudUpdatedAt: cloudDatabase.updatedAt,
        resolvedAt: nowIso(),
      };
    }

    return {
      winner: "equal",
      database: localDatabase,
      localUpdatedAt: localDatabase.updatedAt,
      cloudUpdatedAt: cloudDatabase.updatedAt,
      resolvedAt: nowIso(),
    };
  }

  function createBackupBeforeSync(reason = "sync") {
    const backupKey = `${BACKUP_PREFIX}sync.${reason}.${nowIso()}`;
    localStorage.setItem(backupKey, JSON.stringify(state.database));
    return backupKey;
  }

  function logConflict(result) {
    if (result.winner === "equal") return;
    const logs = JSON.parse(localStorage.getItem(SYNC_CONFLICTS_KEY) || "[]");
    logs.unshift({
      winner: result.winner,
      localUpdatedAt: result.localUpdatedAt,
      cloudUpdatedAt: result.cloudUpdatedAt,
      resolvedAt: result.resolvedAt,
    });
    localStorage.setItem(SYNC_CONFLICTS_KEY, JSON.stringify(logs.slice(0, 50)));
    console.info("JSONBin Sync-Konflikt gelöst:", result);
  }

  function setNotice(message) {
    state.notice = message;
    render();
  }

  function updateStorageStatus() {
    const syncLabel = state.syncConfig.enabled ? `JSONBin: ${state.syncConfig.lastSyncStatus}` : "JSONBin aus";
    storageStatus.textContent = `localStorage · ${formatDateTime(state.database.updatedAt)} · ${syncLabel}`;
  }

  function seriesById(seriesId) {
    return state.database.series.find((series) => series.id === seriesId);
  }

  function volumesForSeries(seriesId) {
    return state.database.volumes
      .filter((volume) => volume.seriesId === seriesId)
      .sort((a, b) => a.volumeNumber - b.volumeNumber);
  }

  function slugify(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "manga";
  }

  function uniqueId(base, existingIds) {
    let id = base;
    let counter = 2;
    while (existingIds.has(id)) {
      id = `${base}-${counter}`;
      counter += 1;
    }
    return id;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDate(value) {
    if (!value) return "ohne Datum";
    return new Intl.DateTimeFormat("de-DE").format(new Date(`${value}T00:00:00`));
  }

  function formatDateTime(value) {
    if (!value) return "unbekannt";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat("de-DE", {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(parsed);
  }

  function fieldValue(form, name) {
    return form.elements[name]?.value.trim() || "";
  }

  function checkedValue(form, name) {
    return Boolean(form.elements[name]?.checked);
  }

  function render() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab);
    });

    updateStorageStatus();
    app.innerHTML = "";
    if (state.notice) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.textContent = state.notice;
      app.append(notice);
    }

    const view = {
      dashboard: renderDashboard,
      series: renderSeriesView,
      collection: renderCollectionView,
      buy: renderBuyView,
      calendar: renderCalendarView,
      importExport: renderImportExportView,
      settings: renderSettingsView,
    }[state.activeTab];

    app.append(view());
  }

  function viewHeader(title, description, actionHtml = "") {
    return `
      <div class="view-header">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
        </div>
        <div>${actionHtml}</div>
      </div>
    `;
  }

  function emptyState(title, text) {
    const template = document.querySelector("#emptyStateTemplate");
    const node = template.content.cloneNode(true);
    node.querySelector("h2").textContent = title;
    node.querySelector("p").textContent = text;
    return node;
  }

  function renderDashboard() {
    const wrapper = document.createElement("section");
    const volumes = state.database.volumes;
    const owned = volumes.filter((volume) => volume.owned);
    const read = owned.filter((volume) => volume.read);
    const buyable = volumes.filter((volume) => !volume.owned && volume.releaseDate && volume.releaseDate <= TODAY);
    const upcoming = volumes.filter((volume) => volume.releaseDate && volume.releaseDate > TODAY);

    wrapper.innerHTML = `
      ${viewHeader("Dashboard", "Überblick über Serien, gekaufte Bände, Lesestand und anstehende physische Releases.")}
      <div class="stats-grid">
        <div class="stat"><strong>${state.database.series.length}</strong><span>Serien</span></div>
        <div class="stat"><strong>${volumes.length}</strong><span>Einzelbände</span></div>
        <div class="stat"><strong>${owned.length}</strong><span>gekauft</span></div>
        <div class="stat"><strong>${read.length}</strong><span>gelesen</span></div>
        <div class="stat"><strong>${buyable.length}</strong><span>kaufbereit</span></div>
        <div class="stat"><strong>${upcoming.length}</strong><span>kommend</span></div>
      </div>
    `;

    if (!state.database.series.length && !state.database.volumes.length) {
      wrapper.append(emptyState("Noch keine Daten", "Lege im Reiter Serien deine erste Serie an und füge anschließend Einzelbände hinzu."));
      return wrapper;
    }

    const nextReleases = upcoming
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
      .slice(0, 6);
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.innerHTML = nextReleases.map(renderVolumeCard).join("");
    wrapper.append(grid);
    return wrapper;
  }

  function renderSeriesView() {
    const wrapper = document.createElement("section");
    wrapper.innerHTML = `
      ${viewHeader("Serien", "Verwalte Serien-Stammdaten und füge physische Einzelbände hinzu.", '<button type="button" class="button" data-action="new-series">Neue Serie</button>')}
      <div id="seriesFormMount"></div>
      <div class="grid" id="seriesGrid"></div>
    `;

    const formMount = wrapper.querySelector("#seriesFormMount");
    if (state.editingSeriesId !== null) {
      formMount.append(renderSeriesForm(state.editingSeriesId));
    }

    const grid = wrapper.querySelector("#seriesGrid");
    if (!state.database.series.length) {
      grid.append(emptyState("Keine Serien", "Erstelle eine Serie, damit du danach Einzelbände erfassen kannst."));
      return wrapper;
    }

    grid.innerHTML = state.database.series
      .sort((a, b) => a.title.localeCompare(b.title, "de"))
      .map((series) => renderSeriesCard(series))
      .join("");
    return wrapper;
  }

  function renderSeriesForm(seriesId) {
    const isNew = seriesId === "__new";
    const series = isNew ? normalizeSeries({}) : seriesById(seriesId);
    const form = document.createElement("form");
    form.className = "form-panel";
    form.dataset.form = "series";
    form.innerHTML = `
      <h3>${isNew ? "Serie anlegen" : "Serie bearbeiten"}</h3>
      <div class="form-grid">
        ${textField("title", "Titel", series.title, true)}
        ${textField("originalTitle", "Originaltitel", series.originalTitle)}
        ${textField("type", "Typ", series.type)}
        ${selectField("publisher", "Verlag", publisherValues, series.publisher, getPublisherLabel)}
        ${textField("imprint", "Imprint", series.imprint)}
        ${selectField("status", "Status", statusValues, series.status, statusLabel)}
        ${selectField("collectionStatus", "Sammlungsstatus", collectionStatusValues, series.collectionStatus, collectionStatusLabel)}
        ${textField("authors", "Autoren, kommagetrennt", series.authors.join(", "))}
        ${textField("artists", "Artists, kommagetrennt", series.artists.join(", "))}
        ${textField("genres", "Genres, kommagetrennt", series.genres.join(", "))}
        ${textField("tags", "Tags, kommagetrennt", series.tags.join(", "))}
        ${textField("language", "Sprache", series.language)}
        ${textField("country", "Land", series.country)}
        ${textField("coverUrl", "Cover-URL", series.coverUrl)}
        ${textField("started", "Gestartet am", series.dates.started || "", false, "date")}
        ${textField("finished", "Beendet am", series.dates.finished || "", false, "date")}
        ${textField("publisherLink", "Publisher-Link", series.links.publisher)}
        ${textField("shopLink", "Shop-Link", series.links.shop)}
        ${textField("anilistLink", "AniList-Link", series.links.anilist)}
        ${textField("mangaupdatesLink", "MangaUpdates-Link", series.links.mangaupdates)}
        ${textField("mangaPassionLink", "Manga Passion-Link", series.links.mangaPassion)}
        ${checkboxField("favorite", "Favorit", series.favorite)}
        ${checkboxField("archived", "Archiviert", series.archived)}
        ${textareaField("notes", "Notizen", series.notes)}
      </div>
      <div class="actions">
        <button type="submit" class="button">${isNew ? "Serie speichern" : "Änderungen speichern"}</button>
        <button type="button" class="secondary-button" data-action="cancel-series">Abbrechen</button>
      </div>
    `;
    return form;
  }

  function renderSeriesCard(series) {
    const volumes = volumesForSeries(series.id);
    const owned = volumes.filter((volume) => volume.owned).length;
    return `
      <article class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${escapeHtml(series.title)}</div>
            <div class="muted">${escapeHtml(getPublisherLabel(series.publisher))}</div>
          </div>
          ${renderCover(series.coverUrl, series.title)}
        </div>
        <div class="meta">
          <span>${escapeHtml(statusLabel(series.status))}</span>
          <span>${escapeHtml(collectionStatusLabel(series.collectionStatus))}</span>
          <span>${owned}/${volumes.length} gekauft</span>
        </div>
        <p class="muted">${escapeHtml(series.notes || "")}</p>
        <div class="actions">
          <button type="button" class="secondary-button" data-action="edit-series" data-id="${escapeHtml(series.id)}">Bearbeiten</button>
          <button type="button" class="button" data-action="new-volume" data-id="${escapeHtml(series.id)}">Band hinzufügen</button>
          <button type="button" class="danger-button" data-action="delete-series" data-id="${escapeHtml(series.id)}">Löschen</button>
        </div>
        ${renderVolumeTable(volumes)}
      </article>
    `;
  }

  function renderVolumeTable(volumes) {
    if (!volumes.length) {
      return '<p class="muted">Noch keine Einzelbände für diese Serie.</p>';
    }
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Band</th>
              <th>Release</th>
              <th>Status</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${volumes.map((volume) => `
              <tr>
                <td>${escapeHtml(volume.volumeNumber)} · ${escapeHtml(volume.title)}</td>
                <td>${escapeHtml(formatDate(volume.releaseDate))}</td>
                <td>${volume.owned ? "gekauft" : "offen"} · ${volume.read ? "gelesen" : "ungelesen"}</td>
                <td>
                  <button type="button" class="secondary-button" data-action="edit-volume" data-id="${escapeHtml(volume.id)}">Bearbeiten</button>
                  <button type="button" class="danger-button" data-action="delete-volume" data-id="${escapeHtml(volume.id)}">Löschen</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderCollectionView() {
    const wrapper = document.createElement("section");
    const owned = state.database.volumes.filter((volume) => volume.owned).sort(volumeSort);
    wrapper.innerHTML = viewHeader("Sammlung", "Alle gekauften Einzelbände mit Lesestatus.");
    if (!owned.length) {
      wrapper.append(emptyState("Noch keine gekauften Bände", "Im Kaufen-Reiter erscheinen erschienene Bände, die du als gekauft markieren kannst."));
      return wrapper;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.innerHTML = owned.map((volume) => renderVolumeCard(volume, "collection")).join("");
    wrapper.append(grid);
    return wrapper;
  }

  function renderBuyView() {
    const wrapper = document.createElement("section");
    const buyable = state.database.volumes
      .filter((volume) => !volume.owned && volume.releaseDate && volume.releaseDate <= TODAY)
      .sort(volumeSort);

    wrapper.innerHTML = viewHeader("Kaufen", "Erschienene Bände und heutige Releases, die noch nicht in deiner Sammlung sind.");
    if (!buyable.length) {
      wrapper.append(emptyState("Nichts offen", "Sobald ein erfasster Band erschienen und noch nicht gekauft ist, landet er hier."));
      return wrapper;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.innerHTML = buyable.map((volume) => renderVolumeCard(volume, "buy")).join("");
    wrapper.append(grid);
    return wrapper;
  }

  function renderCalendarView() {
    const wrapper = document.createElement("section");
    const upcoming = state.database.volumes
      .filter((volume) => volume.releaseDate && volume.releaseDate > TODAY)
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));

    wrapper.innerHTML = viewHeader("Kalender", "Kommende Releases aus deinen vorhandenen Daten.");
    if (!upcoming.length) {
      wrapper.append(emptyState("Keine kommenden Releases", "Trage Release-Daten bei Einzelbänden ein, damit sie hier erscheinen."));
      return wrapper;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.innerHTML = upcoming.map((volume) => renderVolumeCard(volume)).join("");
    wrapper.append(grid);
    return wrapper;
  }

  function renderImportExportView() {
    const wrapper = document.createElement("section");
    wrapper.innerHTML = `
      ${viewHeader("Import/Export", "Sichere deine lokale Datenbank, importiere JSON und exportiere Obsidian-kompatible Markdown-Dateien.")}
      <div class="grid">
        <section class="card">
          <h3>JSON Export</h3>
          <p class="muted">Exportiert die vollständige Datenbank inklusive Serien und Einzelbänden.</p>
          <div class="actions">
            <button type="button" class="button" data-action="export-json">JSON exportieren</button>
          </div>
        </section>
        <section class="card">
          <h3>JSON Import</h3>
          <p class="muted">Vor dem Import wird automatisch ein Backup im localStorage gespeichert. Bei gültigem Import werden die aktuellen Daten ersetzt.</p>
          <div class="actions">
            <label class="secondary-button" for="jsonImport">JSON auswählen</label>
            <input id="jsonImport" type="file" accept="application/json,.json" hidden>
          </div>
        </section>
        <section class="card">
          <h3>Obsidian Export</h3>
          <p class="muted">Erstellt eine ZIP-Datei mit einer Markdown-Datei pro Serie und gültigem YAML Frontmatter.</p>
          <div class="actions">
            <button type="button" class="button" data-action="export-obsidian">Markdown ZIP exportieren</button>
          </div>
        </section>
      </div>
    `;
    return wrapper;
  }

  function renderSettingsView() {
    const backups = Object.keys(localStorage).filter((key) => key.startsWith(BACKUP_PREFIX)).sort().reverse();
    const conflicts = JSON.parse(localStorage.getItem(SYNC_CONFLICTS_KEY) || "[]");
    const wrapper = document.createElement("section");
    wrapper.innerHTML = `
      ${viewHeader("Einstellungen", "localStorage bleibt der lokale Cache. JSONBin kann als zentrale Cloud-Datenquelle synchronisiert werden.")}
      <section class="card">
        <div class="settings-list">
          <div><strong>Schema-Version</strong><span>${state.database.schemaVersion}</span></div>
          <div><strong>Letzte Aktualisierung</strong><span>${escapeHtml(state.database.updatedAt)}</span></div>
          <div><strong>Serien</strong><span>${state.database.series.length}</span></div>
          <div><strong>Einzelbände</strong><span>${state.database.volumes.length}</span></div>
          <div><strong>Backups</strong><span>${backups.length}</span></div>
          <div><strong>Sync</strong><span>${escapeHtml(state.syncConfig.enabled ? state.syncConfig.lastSyncStatus : "deaktiviert")}</span></div>
          <div><strong>Letzter Sync</strong><span>${escapeHtml(state.syncConfig.lastSyncAt ? formatDateTime(state.syncConfig.lastSyncAt) : "nie")}</span></div>
          <div><strong>Offener Cloud-Push</strong><span>${state.syncConfig.pendingPush ? "ja" : "nein"}</span></div>
          <div><strong>Konflikte</strong><span>${conflicts.length}</span></div>
        </div>
      </section>
      <form class="form-panel" data-form="sync">
        <h3>JSONBin Sync</h3>
        <p class="muted">Der X-Access-Key wird standardmäßig nur für diese Sitzung gespeichert. Verwende einen Key mit bins.read und bins.update, ohne Create/Delete-Rechte.</p>
        ${state.syncMessage ? `<div class="notice">${escapeHtml(state.syncMessage)}</div>` : ""}
        <div class="form-grid">
          ${checkboxField("syncEnabled", "JSONBin Sync aktivieren", state.syncConfig.enabled)}
          ${textField("syncBinId", "JSONBin Bin-ID", state.syncConfig.binId)}
          ${textField("syncAccessKey", "X-Access-Key", state.syncConfig.accessKey, false, "password")}
          ${checkboxField("syncPersistKey", "Key dauerhaft auf diesem Gerät speichern", state.syncConfig.persistKey)}
        </div>
        <div class="actions">
          <button type="submit" class="button">Sync-Einstellungen speichern</button>
          <button type="button" class="secondary-button" data-action="sync-now">Jetzt synchronisieren</button>
          <button type="button" class="secondary-button" data-action="push-now">Jetzt in Cloud speichern</button>
        </div>
      </form>
    `;
    return wrapper;
  }

  function renderVolumeCard(volume, context = "") {
    const series = seriesById(volume.seriesId);
    const actions = [];
    if (context === "buy") {
      actions.push(`<button type="button" class="button" data-action="mark-owned" data-id="${escapeHtml(volume.id)}">Gekauft</button>`);
    }
    if (context === "collection") {
      actions.push(volume.read
        ? `<button type="button" class="secondary-button" data-action="mark-unread" data-id="${escapeHtml(volume.id)}">Ungelesen</button>`
        : `<button type="button" class="button" data-action="mark-read" data-id="${escapeHtml(volume.id)}">Gelesen</button>`);
    }
    actions.push(`<button type="button" class="secondary-button" data-action="edit-volume" data-id="${escapeHtml(volume.id)}">Bearbeiten</button>`);

    return `
      <article class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${escapeHtml(series?.title || volume.title)} Band ${escapeHtml(volume.volumeNumber)}</div>
            <div class="muted">${escapeHtml(volume.subtitle || volume.title || "")}</div>
          </div>
          ${renderCover(volume.coverUrl || series?.coverUrl || "", volume.title)}
        </div>
        <div class="meta">
          <span>${escapeHtml(getPublisherLabel(volume.publisher || series?.publisher || "other"))}</span>
          <span>${escapeHtml(formatDate(volume.releaseDate))}</span>
          <span>${volume.owned ? `gekauft ${volume.boughtAt ? formatDate(volume.boughtAt) : ""}` : "nicht gekauft"}</span>
          <span>${volume.read ? "gelesen" : "ungelesen"}</span>
        </div>
        <div class="actions">${actions.join("")}</div>
      </article>
    `;
  }

  function renderCover(url, alt) {
    if (!url) return '<div class="cover"><div class="cover-placeholder">Cover</div></div>';
    return `<div class="cover"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"></div>`;
  }

  function renderVolumeForm(volumeId, seriesId = "") {
    const isNew = volumeId === "__new";
    const volume = isNew ? normalizeVolume({ seriesId, publisher: seriesById(seriesId)?.publisher || "" }) : state.database.volumes.find((item) => item.id === volumeId);
    const form = document.createElement("form");
    form.className = "form-panel";
    form.dataset.form = "volume";
    form.dataset.id = volumeId;
    form.innerHTML = `
      <h3>${isNew ? "Band anlegen" : "Band bearbeiten"}</h3>
      <div class="form-grid">
        ${selectSeriesField(volume.seriesId)}
        ${textField("volumeNumber", "Bandnummer", volume.volumeNumber, true, "text", "", "numeric")}
        ${textField("title", "Titel", volume.title, true)}
        ${textField("subtitle", "Untertitel", volume.subtitle)}
        ${textField("isbn", "ISBN", volume.isbn)}
        ${selectField("publisher", "Verlag", publisherValues, volume.publisher, getPublisherLabel)}
        ${textField("releaseDate", "Release-Datum", volume.releaseDate, false, "date")}
        ${textField("coverUrl", "Cover-URL", volume.coverUrl)}
        ${textField("coverSource", "Cover-Quelle", volume.coverSource)}
        ${textField("price", "Preis", volume.price ?? "", false, "text", "", "decimal")}
        ${textField("shopUrl", "Shop-URL", volume.shopUrl)}
        ${selectField("editionType", "Edition", editionTypeValues, volume.editionType)}
        ${checkboxField("owned", "Gekauft", volume.owned)}
        ${textField("boughtAt", "Gekauft am", volume.boughtAt || "", false, "date")}
        ${checkboxField("read", "Gelesen", volume.read)}
        ${textField("readAt", "Gelesen am", volume.readAt || "", false, "date")}
        ${checkboxField("coverManuallySet", "Cover manuell gesetzt", volume.coverManuallySet)}
        ${textareaField("notes", "Notizen", volume.notes)}
      </div>
      <div class="actions">
        <button type="submit" class="button">${isNew ? "Band speichern" : "Änderungen speichern"}</button>
        <button type="button" class="secondary-button" data-action="cancel-volume">Abbrechen</button>
      </div>
    `;
    return form;
  }

  function textField(name, label, value = "", required = false, type = "text", step = "", inputmode = "") {
    return `
      <div class="field">
        <label for="${name}">${label}</label>
        <input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? "required" : ""} ${step ? `step="${step}"` : ""} ${inputmode ? `inputmode="${inputmode}"` : ""}>
      </div>
    `;
  }

  function textareaField(name, label, value = "") {
    return `
      <div class="field field-wide">
        <label for="${name}">${label}</label>
        <textarea id="${name}" name="${name}">${escapeHtml(value)}</textarea>
      </div>
    `;
  }

  function checkboxField(name, label, checked) {
    return `
      <div class="field">
        <label for="${name}">${label}</label>
        <input id="${name}" name="${name}" type="checkbox" ${checked ? "checked" : ""}>
      </div>
    `;
  }

  function selectField(name, label, values, selected, getLabel = (value) => value) {
    return `
      <div class="field">
        <label for="${name}">${label}</label>
        <select id="${name}" name="${name}">
          ${values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(getLabel(value))}</option>`).join("")}
        </select>
      </div>
    `;
  }

  function selectSeriesField(selected) {
    return `
      <div class="field">
        <label for="seriesId">Serie</label>
        <select id="seriesId" name="seriesId" required>
          ${state.database.series.map((series) => `<option value="${escapeHtml(series.id)}" ${series.id === selected ? "selected" : ""}>${escapeHtml(series.title)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  function volumeSort(a, b) {
    const seriesA = seriesById(a.seriesId)?.title || "";
    const seriesB = seriesById(b.seriesId)?.title || "";
    return seriesA.localeCompare(seriesB, "de") || a.volumeNumber - b.volumeNumber;
  }

  function handleSeriesSubmit(form) {
    const isNew = state.editingSeriesId === "__new";
    const existingIds = new Set(state.database.series.map((series) => series.id));
    const current = isNew ? null : seriesById(state.editingSeriesId);
    const title = fieldValue(form, "title");
    const id = current?.id || uniqueId(slugify(title), existingIds);
    const payload = normalizeSeries({
      id,
      title,
      originalTitle: fieldValue(form, "originalTitle"),
      type: fieldValue(form, "type") || "manga",
      status: fieldValue(form, "status"),
      collectionStatus: fieldValue(form, "collectionStatus"),
      publisher: fieldValue(form, "publisher"),
      imprint: fieldValue(form, "imprint"),
      authors: fieldValue(form, "authors"),
      artists: fieldValue(form, "artists"),
      genres: fieldValue(form, "genres"),
      tags: fieldValue(form, "tags"),
      language: fieldValue(form, "language") || "de",
      country: fieldValue(form, "country") || "DE",
      coverUrl: fieldValue(form, "coverUrl"),
      notes: fieldValue(form, "notes"),
      favorite: checkedValue(form, "favorite"),
      archived: checkedValue(form, "archived"),
      dates: {
        started: fieldValue(form, "started") || null,
        finished: fieldValue(form, "finished") || null,
        lastUpdated: nowIso(),
        lastReleaseCheck: current?.dates?.lastReleaseCheck || null,
      },
      links: {
        publisher: fieldValue(form, "publisherLink"),
        shop: fieldValue(form, "shopLink"),
        anilist: fieldValue(form, "anilistLink"),
        mangaupdates: fieldValue(form, "mangaupdatesLink"),
        mangaPassion: fieldValue(form, "mangaPassionLink"),
      },
    });

    if (isNew) {
      state.database.series.push(payload);
    } else {
      state.database.series = state.database.series.map((series) => series.id === payload.id ? payload : series);
    }
    state.editingSeriesId = null;
    saveDatabase();
    setNotice("Serie gespeichert.");
  }

  function handleVolumeSubmit(form) {
    const volumeId = form.dataset.id;
    const isNew = volumeId === "__new";
    const current = isNew ? null : state.database.volumes.find((volume) => volume.id === volumeId);
    const seriesId = fieldValue(form, "seriesId");
    const volumeNumber = Number(fieldValue(form, "volumeNumber") || 1);
    const existingIds = new Set(state.database.volumes.map((volume) => volume.id));
    const baseId = `${seriesId}-${String(volumeNumber).padStart(3, "0")}`;
    const id = current?.id || uniqueId(baseId, existingIds);
    const owned = checkedValue(form, "owned");
    const read = checkedValue(form, "read");

    const payload = normalizeVolume({
      id,
      seriesId,
      volumeNumber,
      title: fieldValue(form, "title"),
      subtitle: fieldValue(form, "subtitle"),
      isbn: fieldValue(form, "isbn"),
      publisher: fieldValue(form, "publisher"),
      releaseDate: fieldValue(form, "releaseDate"),
      coverUrl: fieldValue(form, "coverUrl"),
      coverSource: fieldValue(form, "coverSource"),
      coverManuallySet: checkedValue(form, "coverManuallySet"),
      owned,
      boughtAt: fieldValue(form, "boughtAt") || (owned && !current?.boughtAt ? TODAY : null),
      read,
      readAt: fieldValue(form, "readAt") || (read && !current?.readAt ? TODAY : null),
      price: fieldValue(form, "price") || null,
      shopUrl: fieldValue(form, "shopUrl"),
      editionType: fieldValue(form, "editionType"),
      notes: fieldValue(form, "notes"),
      createdAt: current?.createdAt || TODAY,
      updatedAt: nowIso(),
    });

    if (isNew) {
      state.database.volumes.push(payload);
    } else {
      state.database.volumes = state.database.volumes.map((volume) => volume.id === id ? payload : volume);
    }
    state.editingVolumeId = null;
    saveDatabase();
    setNotice("Band gespeichert.");
  }

  function openVolumeForm(volumeId, seriesId = "") {
    const existing = document.querySelector("[data-form='volume']");
    if (existing) existing.remove();
    const form = renderVolumeForm(volumeId, seriesId);
    app.insertBefore(form, app.children[state.notice ? 1 : 0] || app.firstChild);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function markVolume(volumeId, updates) {
    state.database.volumes = state.database.volumes.map((volume) => {
      if (volume.id !== volumeId) return volume;
      return normalizeVolume({ ...volume, ...updates, updatedAt: nowIso() });
    });
    saveDatabase();
    render();
  }

  function deleteSeries(seriesId) {
    if (!confirm("Serie und alle zugehörigen Bände löschen?")) return;
    state.database.series = state.database.series.filter((series) => series.id !== seriesId);
    state.database.volumes = state.database.volumes.filter((volume) => volume.seriesId !== seriesId);
    saveDatabase();
    setNotice("Serie gelöscht.");
  }

  function deleteVolume(volumeId) {
    if (!confirm("Band löschen?")) return;
    state.database.volumes = state.database.volumes.filter((volume) => volume.id !== volumeId);
    saveDatabase();
    setNotice("Band gelöscht.");
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    downloadText(`manga-tracker-${TODAY}.json`, JSON.stringify(state.database, null, 2), "application/json");
  }

  function backupCurrentDatabase() {
    return backupDatabaseSnapshot(state.database);
  }

  async function importJson(file) {
    const backupKey = backupCurrentDatabase();
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const validation = validateDatabase(parsed);
      if (!validation.valid) {
        setNotice(`Import abgebrochen. Backup erhalten: ${backupKey}. Fehler: ${validation.errors.join(" ")}`);
        return;
      }
      state.database = normalizeDatabase(migratePublisherValues(parsed).database);
      saveDatabase();
      setNotice(`Import erfolgreich. Backup erhalten: ${backupKey}.`);
    } catch (error) {
      setNotice(`Import fehlgeschlagen. Backup erhalten: ${backupKey}.`);
      console.error(error);
    }
  }

  function handleSyncSubmit(form) {
    state.syncConfig.enabled = checkedValue(form, "syncEnabled");
    state.syncConfig.binId = fieldValue(form, "syncBinId");
    state.syncConfig.accessKey = fieldValue(form, "syncAccessKey");
    state.syncConfig.persistKey = checkedValue(form, "syncPersistKey");
    state.syncConfig.pendingPush = state.syncConfig.pendingPush || false;
    saveSyncConfig();

    if (!state.syncConfig.enabled) {
      setSyncStatus("disabled", "JSONBin Sync ist deaktiviert.");
      setNotice("Sync-Einstellungen gespeichert.");
      return;
    }

    if (!isSyncConfigured()) {
      setSyncStatus("missing-config", "JSONBin Sync ist aktiviert, aber Bin-ID oder X-Access-Key fehlt.");
      setNotice("Sync-Einstellungen gespeichert. Für JSONBin fehlen noch Daten.");
      return;
    }

    setNotice("Sync-Einstellungen gespeichert. Synchronisierung wird gestartet.");
    initSync();
  }

  function yamlValue(value) {
    if (Array.isArray(value)) return `[${value.map(yamlValue).join(", ")}]`;
    if (value === null || value === undefined || value === "") return "null";
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function seriesToMarkdown(series) {
    const volumes = volumesForSeries(series.id);
    const frontmatter = [
      "---",
      `id: ${yamlValue(series.id)}`,
      `title: ${yamlValue(series.title)}`,
      `originalTitle: ${yamlValue(series.originalTitle)}`,
      `type: ${yamlValue(series.type)}`,
      `status: ${yamlValue(series.status)}`,
      `collectionStatus: ${yamlValue(series.collectionStatus)}`,
      `publisher: ${yamlValue(getPublisherLabel(series.publisher))}`,
      `imprint: ${yamlValue(series.imprint)}`,
      `authors: ${yamlValue(series.authors)}`,
      `artists: ${yamlValue(series.artists)}`,
      `genres: ${yamlValue(series.genres)}`,
      `tags: ${yamlValue(series.tags)}`,
      `language: ${yamlValue(series.language)}`,
      `country: ${yamlValue(series.country)}`,
      `coverUrl: ${yamlValue(series.coverUrl)}`,
      `favorite: ${yamlValue(series.favorite)}`,
      `archived: ${yamlValue(series.archived)}`,
      `updatedAt: ${yamlValue(state.database.updatedAt)}`,
      "---",
    ].join("\n");

    const body = [
      `# ${series.title}`,
      "",
      "## Links",
      `- Verlag: ${series.links.publisher || ""}`,
      `- Shop: ${series.links.shop || ""}`,
      `- AniList: ${series.links.anilist || ""}`,
      `- MangaUpdates: ${series.links.mangaupdates || ""}`,
      `- Manga Passion: ${series.links.mangaPassion || ""}`,
      "",
      "## Bände",
      ...volumes.map((volume) => `- Band ${volume.volumeNumber}: ${volume.title}${volume.subtitle ? ` - ${volume.subtitle}` : ""} | Release: ${volume.releaseDate || ""} | Gekauft: ${volume.owned ? "ja" : "nein"} | Gelesen: ${volume.read ? "ja" : "nein"}`),
      "",
      "## Notizen",
      series.notes || "",
      "",
    ].join("\n");

    return `${frontmatter}\n\n${body}`;
  }

  async function exportObsidianZip() {
    if (!state.database.series.length) {
      setNotice("Keine Serien für den Obsidian Export vorhanden.");
      return;
    }
    const files = state.database.series.map((series) => ({
      name: `${slugify(series.title)}.md`,
      content: seriesToMarkdown(series),
    }));
    try {
      const zipBlob = createZip(files);
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `manga-tracker-obsidian-${TODAY}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      const combined = files.map((file) => `<!-- ${file.name} -->\n\n${file.content}`).join("\n\n");
      downloadText(`manga-tracker-obsidian-${TODAY}.md`, combined, "text/markdown");
    }
  }

  function createZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const contentBytes = encoder.encode(file.content);
      const crc = crc32(contentBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, 0, true);
      localView.setUint16(12, 0, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, contentBytes.length, true);
      localView.setUint32(22, contentBytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, contentBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, 0, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, contentBytes.length, true);
      centralView.setUint32(24, contentBytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + contentBytes.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const endHeader = new Uint8Array(22);
    const endView = new DataView(endHeader.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, endHeader], { type: "application/zip" });
  }

  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let c = index;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.activeTab = button.dataset.tab;
    state.notice = "";
    state.editingSeriesId = null;
    state.editingVolumeId = null;
    render();
  });

  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;

    if (action === "new-series") {
      state.editingSeriesId = "__new";
      render();
    }
    if (action === "edit-series") {
      state.editingSeriesId = id;
      render();
    }
    if (action === "cancel-series") {
      state.editingSeriesId = null;
      render();
    }
    if (action === "new-volume") openVolumeForm("__new", id);
    if (action === "edit-volume") openVolumeForm(id);
    if (action === "cancel-volume") button.closest("form").remove();
    if (action === "delete-series") deleteSeries(id);
    if (action === "delete-volume") deleteVolume(id);
    if (action === "mark-owned") markVolume(id, { owned: true, boughtAt: TODAY });
    if (action === "mark-read") markVolume(id, { read: true, readAt: TODAY });
    if (action === "mark-unread") markVolume(id, { read: false, readAt: null });
    if (action === "export-json") exportJson();
    if (action === "export-obsidian") exportObsidianZip();
    if (action === "sync-now") pullFromCloud();
    if (action === "push-now") pushToCloud();
  });

  app.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.form === "series") handleSeriesSubmit(form);
    if (form.dataset.form === "volume") handleVolumeSubmit(form);
    if (form.dataset.form === "sync") handleSyncSubmit(form);
  });

  app.addEventListener("change", (event) => {
    if (event.target.id === "jsonImport" && event.target.files[0]) {
      importJson(event.target.files[0]);
    }
  });

  window.addEventListener("online", () => {
    if (!state.syncConfig.enabled) return;
    if (state.syncConfig.pendingPush) {
      pushToCloud({ silent: true });
    } else {
      pullFromCloud();
    }
  });

  render();
  initSync();
})();

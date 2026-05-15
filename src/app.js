(function () {
  "use strict";

  const STORAGE_KEY = "mangaTracker.database.v1";
  const BACKUP_PREFIX = "mangaTracker.backup.";
  const SUPABASE_CONFIG_KEY = "mangaTracker.supabaseConfig.v1";
  const SUPABASE_META_KEY = "mangaTracker.supabaseMeta.v1";
  const SUPABASE_CONFLICTS_KEY = "mangaTracker.supabaseConflicts.v1";
  const RELEASE_CONFLICTS_KEY = "mangaTracker.releaseConflicts.v1";
  const SUPABASE_TABLE = "manga_tracker_databases";
  const TODAY = todayLocalDate();
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
    appMode: "loading",
    showFirstTimeDialog: false,
    savePending: false,
    saveError: false,
    supabaseSaveTimer: null,
    database: loadDatabase(),
    supabaseConfig: loadSupabaseConfig(),
    supabaseMeta: loadSupabaseMeta(),
    supabaseClient: null,
    supabaseUser: null,
    supabaseStatus: "not-configured",
    supabaseMessage: "",
    supabaseInProgress: false,
    supabaseConflict: null,
    editingSeriesId: null,
    editingVolumeId: null,
    releasePreview: null,
    coverPreview: null,
    releaseCache: {
      seriesId: "",
      status: "idle",
      message: "",
      generatedAt: null,
      itemCount: null,
      error: "",
    },
    buyGapCache: {
      status: "idle",
      items: [],
      generatedAt: null,
      itemCount: null,
      error: "",
    },
    notice: "",
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function todayLocalDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(empty));
      return empty;
    }

    try {
      const parsed = JSON.parse(raw);
      const validation = validateDatabase(parsed);
      if (!validation.valid) {
        console.warn("Ungültige Datenbank im localStorage:", validation.errors);
        return createEmptyDatabase();
      }
      const migration = migrateDatabase(parsed);
      if (migration.changed) {
        backupDatabaseSnapshot(parsed, "release-model-migration");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migration.database));
      }
      return normalizeDatabase(migration.database);
    } catch (error) {
      console.warn("Datenbank konnte nicht gelesen werden:", error);
      return createEmptyDatabase();
    }
  }

  function loadSupabaseConfig() {
    const defaults = {
      enabled: false,
      url: "",
      publicKey: "",
      loginEmail: "",
      lastSyncAt: null,
      lastSyncStatus: "not-configured",
      pendingPush: false,
    };

    try {
      const stored = JSON.parse(localStorage.getItem(SUPABASE_CONFIG_KEY) || "{}");
      return {
        ...defaults,
        ...stored,
        publicKey: String(stored.publicKey || stored.anonKey || ""),
      };
    } catch (error) {
      console.warn("Supabase-Konfiguration konnte nicht gelesen werden:", error);
      return defaults;
    }
  }

  function saveSupabaseConfig() {
    const configForLocalStorage = {
      enabled: Boolean(state.supabaseConfig.enabled),
      url: state.supabaseConfig.url.trim(),
      publicKey: state.supabaseConfig.publicKey.trim(),
      loginEmail: state.supabaseConfig.loginEmail.trim(),
      lastSyncAt: state.supabaseConfig.lastSyncAt,
      lastSyncStatus: state.supabaseConfig.lastSyncStatus,
      pendingPush: Boolean(state.supabaseConfig.pendingPush),
    };
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(configForLocalStorage));
  }

  function createDefaultSupabaseMeta() {
    return {
      lastPushAt: null,
      lastPullAt: null,
      lastSyncAt: null,
      lastRemoteUpdatedAt: null,
      lastError: "",
      lastUserEmail: "",
      lastKnownLocalUpdatedAt: "",
      autoPushEnabled: false,
      lastStatus: "not-configured",
    };
  }

  function loadSupabaseMeta() {
    const defaults = createDefaultSupabaseMeta();
    try {
      const stored = JSON.parse(localStorage.getItem(SUPABASE_META_KEY) || "{}");
      return {
        ...defaults,
        lastPushAt: normalizeNullableTimestamp(stored.lastPushAt),
        lastPullAt: normalizeNullableTimestamp(stored.lastPullAt),
        lastSyncAt: normalizeNullableTimestamp(stored.lastSyncAt),
        lastRemoteUpdatedAt: normalizeNullableTimestamp(stored.lastRemoteUpdatedAt),
        lastError: String(stored.lastError || ""),
        lastUserEmail: String(stored.lastUserEmail || ""),
        lastKnownLocalUpdatedAt: normalizeNullableTimestamp(stored.lastKnownLocalUpdatedAt) || "",
        autoPushEnabled: Boolean(stored.autoPushEnabled),
        lastStatus: String(stored.lastStatus || defaults.lastStatus),
      };
    } catch (error) {
      console.warn("Supabase-Metadaten konnten nicht gelesen werden:", error);
      return defaults;
    }
  }

  function saveSupabaseMeta(meta = state.supabaseMeta) {
    const nextMeta = {
      ...createDefaultSupabaseMeta(),
      ...meta,
      lastPushAt: normalizeNullableTimestamp(meta.lastPushAt),
      lastPullAt: normalizeNullableTimestamp(meta.lastPullAt),
      lastSyncAt: normalizeNullableTimestamp(meta.lastSyncAt),
      lastRemoteUpdatedAt: normalizeNullableTimestamp(meta.lastRemoteUpdatedAt),
      lastError: String(meta.lastError || ""),
      lastUserEmail: String(meta.lastUserEmail || ""),
      lastKnownLocalUpdatedAt: normalizeNullableTimestamp(meta.lastKnownLocalUpdatedAt) || "",
      autoPushEnabled: Boolean(meta.autoPushEnabled),
      lastStatus: String(meta.lastStatus || "not-configured"),
    };
    state.supabaseMeta = nextMeta;
    localStorage.setItem(SUPABASE_META_KEY, JSON.stringify(nextMeta));
    return nextMeta;
  }

  function updateSupabaseMeta(patch = {}) {
    return saveSupabaseMeta({
      ...state.supabaseMeta,
      ...patch,
    });
  }

  function clearSupabaseError() {
    updateSupabaseMeta({ lastError: "" });
  }

  function setSupabaseError(message) {
    const text = String(message || "Unbekannter Supabase-Fehler.");
    updateSupabaseMeta({
      lastError: text,
      lastStatus: "error",
    });
    return text;
  }

  function normalizeNullableTimestamp(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  function isSupabaseConfigured() {
    return Boolean(state.supabaseConfig.enabled && state.supabaseConfig.url.trim() && state.supabaseConfig.publicKey.trim());
  }

  function setSupabaseStatus(status, message = "") {
    state.supabaseStatus = status;
    state.supabaseMessage = message;
    state.supabaseConfig.lastSyncStatus = status;
    saveSupabaseConfig();
    updateSupabaseMeta({
      lastStatus: status,
    });
    updateStorageStatus();
  }

  function resetSupabaseClient() {
    state.supabaseClient = null;
    state.supabaseUser = null;
  }

  function saveSupabaseFormValues(form) {
    if (!form) return;
    state.supabaseConfig.enabled = checkedValue(form, "supabaseEnabled");
    state.supabaseConfig.url = fieldValue(form, "supabaseUrl");
    state.supabaseConfig.publicKey = fieldValue(form, "supabasePublicKey");
    state.supabaseConfig.loginEmail = fieldValue(form, "supabaseLoginEmail");
    resetSupabaseClient();
    saveSupabaseConfig();
    saveSupabaseMeta();
  }

  function getSupabaseClient() {
    if (!isSupabaseConfigured()) {
      setSupabaseStatus("missing-config", "Supabase URL oder Public Key fehlt.");
      return null;
    }
    if (!window.supabase?.createClient) {
      setSupabaseStatus("missing-client", "Supabase JS konnte nicht geladen werden. Die App arbeitet lokal weiter.");
      return null;
    }
    if (state.supabaseClient) return state.supabaseClient;
    state.supabaseClient = window.supabase.createClient(
      state.supabaseConfig.url.trim(),
      state.supabaseConfig.publicKey.trim(),
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
    state.supabaseClient.auth.onAuthStateChange((_event, session) => {
      state.supabaseUser = session?.user || null;
      if (state.supabaseUser) {
        updateSupabaseMeta({
          lastUserEmail: state.supabaseUser.email || "",
          lastStatus: "signed-in",
        });
      }
      render();
    });
    return state.supabaseClient;
  }

  function byteSize(value) {
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
  }

  function formatKb(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function sumLocalStorageBytes(predicate) {
    return Object.keys(localStorage)
      .filter(predicate)
      .reduce((sum, key) => sum + byteSize(localStorage.getItem(key) || ""), 0);
  }

  function saveDatabase(options = {}) {
    const { sync = true } = options;

    if (state.appMode !== "cloud") {
      setNotice("Bearbeitung blockiert — bitte anmelden und Cloud-Daten laden.");
      return;
    }

    state.database.updatedAt = nowIso();
    saveLocalDatabase();
    if (sync) {
      state.savePending = true;
      state.saveError = false;
    }
    updateStorageStatus();
    render();
    if (sync) {
      scheduleDebouncedSupabaseSave();
    }
  }

  function scheduleDebouncedSupabaseSave() {
    if (state.supabaseSaveTimer) clearTimeout(state.supabaseSaveTimer);
    state.supabaseSaveTimer = setTimeout(async () => {
      state.supabaseSaveTimer = null;
      const result = await supabasePush({ silent: true });
      if (result.ok) {
        state.savePending = false;
        state.saveError = false;
        saveLocalDatabase();
      } else if (result.reason !== "conflict" && result.reason !== "busy") {
        state.savePending = false;
        state.saveError = true;
      }
      updateStorageStatus();
      render();
    }, 3000);
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED") {
        console.error("localStorage voll – Daten konnten nicht gespeichert werden.", key);
        setNotice("Speicher voll! Bitte alte Backups löschen oder einen Export durchführen.");
      } else {
        throw e;
      }
    }
  }

  function saveLocalDatabase() {
    safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state.database));
  }

  function backupDatabaseSnapshot(database, reason = "backup") {
    const backupKey = `${BACKUP_PREFIX}${reason}.${nowIso()}`;
    safeLocalStorageSet(backupKey, JSON.stringify(database));
    return backupKey;
  }

  function normalizeDatabase(database) {
    const series = Array.isArray(database.series) ? database.series.map(normalizeSeries) : [];
    const seriesLookup = new Map(series.map((item) => [item.id, item]));
    return {
      schemaVersion: 1,
      updatedAt: normalizeTimestamp(database.updatedAt),
      series,
      volumes: Array.isArray(database.volumes) ? database.volumes.map((volume) => normalizeVolume(volume, seriesLookup.get(String(volume?.seriesId || "")))) : [],
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

  function migrateDatabase(database) {
    const migratedDatabase = {
      ...database,
      series: Array.isArray(database?.series) ? database.series.map((series) => ({
        ...series,
        publisher: normalizePublisher(series?.publisher),
      })) : [],
      volumes: [],
    };
    const originalSeries = Array.isArray(database?.series) ? database.series : [];
    const originalVolumes = Array.isArray(database?.volumes) ? database.volumes : [];
    const seriesLookup = new Map(migratedDatabase.series.map((series) => [String(series.id || ""), normalizeSeries(series)]));
    migratedDatabase.volumes = originalVolumes.map((volume) => {
      const series = seriesLookup.get(String(volume?.seriesId || ""));
      const migratedVolume = {
        ...volume,
        publisher: normalizePublisher(volume?.publisher || series?.publisher),
      };
      const normalized = normalizeVolume(migratedVolume, series);
      return {
        ...migratedVolume,
        releaseSource: normalized.releaseSource,
        releaseConfidence: normalized.releaseConfidence,
        coverConfidence: normalized.coverConfidence,
        coverCheckedAt: normalized.coverCheckedAt,
        coverHash: normalized.coverHash,
        isbn13: normalized.isbn13,
        editionFingerprint: normalized.editionFingerprint,
      };
    });
    const seriesChanged = migratedDatabase.series.some((series, index) => series.publisher !== String(originalSeries[index]?.publisher || ""));
    const volumesChanged = migratedDatabase.volumes.some((volume, index) => {
      const original = originalVolumes[index] || {};
      return volume.publisher !== String(original.publisher || "")
        || volume.releaseSource !== String(original.releaseSource || "")
        || volume.releaseConfidence !== normalizeConfidence(original.releaseConfidence)
        || volume.coverConfidence !== normalizeConfidence(original.coverConfidence)
        || volume.coverCheckedAt !== String(original.coverCheckedAt || "")
        || volume.coverHash !== String(original.coverHash || "")
        || volume.isbn13 !== String(original.isbn13 || normalizeIsbn13(original.isbn) || "")
        || volume.editionFingerprint !== String(original.editionFingerprint || "");
    });

    return {
      database: migratedDatabase,
      changed: seriesChanged || volumesChanged,
    };
  }

  function prepareImportedDatabase(rawData) {
    const database = isLegacyMangaDatabase(rawData) ? migrateLegacyMangaDatabase(rawData) : rawData;
    return migrateDatabase(database).database;
  }

  function isLegacyMangaDatabase(rawData) {
    return Array.isArray(rawData?.manga) && rawData.series === undefined;
  }

  function migrateLegacyMangaDatabase(rawData) {
    const existingSeriesIds = new Set();
    const existingVolumeIds = new Set();
    const migratedAt = nowIso();
    const series = [];
    const volumes = [];

    rawData.manga.forEach((manga, index) => {
      if (!manga || typeof manga !== "object") {
        throw new Error(`manga[${index}] muss ein Objekt sein.`);
      }

      const title = String(manga.title || "").trim();
      if (!title) {
        throw new Error(`manga[${index}].title fehlt.`);
      }

      const baseSeriesId = String(manga.id || slugify(title));
      const seriesId = uniqueId(baseSeriesId, existingSeriesIds);
      existingSeriesIds.add(seriesId);
      const publisher = normalizePublisher(manga.publisher);
      const links = manga.links && typeof manga.links === "object" ? manga.links : {};

      series.push({
        id: seriesId,
        title,
        originalTitle: String(manga.originalTitle || ""),
        type: String(manga.type || "manga"),
        status: manga.status,
        collectionStatus: manga.collectionStatus,
        publisher,
        imprint: String(manga.imprint || ""),
        authors: normalizeStringArray(manga.author),
        artists: normalizeStringArray(manga.artist),
        genres: normalizeStringArray(manga.genres),
        tags: normalizeStringArray(manga.tags),
        language: String(manga.release?.language || "de"),
        country: String(manga.release?.country || "DE"),
        coverUrl: String(links.cover || ""),
        notes: String(manga.notes || ""),
        favorite: Boolean(manga.favorite),
        archived: Boolean(manga.archived),
        dates: manga.dates || {},
        links,
      });

      const ownedCount = positiveInteger(manga.volumes?.owned);
      const readCount = positiveInteger(manga.volumes?.read);
      const bandCount = manga.bands && typeof manga.bands === "object" ? Object.keys(manga.bands).length : 0;
      const baseTotal = positiveInteger(manga.volumes?.total) || ownedCount || bandCount || 1;
      const nextVolume = positiveInteger(manga.release?.nextVolume);
      const total = Math.max(baseTotal, nextVolume || 0);

      for (let volumeNumber = 1; volumeNumber <= total; volumeNumber += 1) {
        const legacyBandStatus = String(manga.bands?.[volumeNumber] || "");
        const bandCover = manga.bandCovers?.[volumeNumber];
        let owned = legacyBandStatus === "completed" || legacyBandStatus === "owned" || legacyBandStatus === "reading";
        let read = legacyBandStatus === "completed";

        if (volumeNumber <= ownedCount) owned = true;
        if (volumeNumber <= readCount) read = true;

        const releaseDate = nextVolume === volumeNumber && manga.release?.nextDate ? String(manga.release.nextDate) : null;
        let volumeId = `${seriesId}-${String(volumeNumber).padStart(3, "0")}`;
        volumeId = uniqueId(volumeId, existingVolumeIds);
        existingVolumeIds.add(volumeId);

        volumes.push({
          id: volumeId,
          seriesId,
          volumeNumber,
          title,
          publisher,
          releaseDate,
          coverUrl: String(bandCover || links.cover || ""),
          coverSource: bandCover ? "legacy-bandCovers" : "legacy-series-cover",
          coverManuallySet: false,
          owned,
          boughtAt: null,
          read,
          readAt: read ? manga.dates?.finished || null : null,
          createdAt: migratedAt,
          updatedAt: migratedAt,
        });
      }
    });

    return {
      schemaVersion: 1,
      updatedAt: normalizeTimestamp(rawData.updatedAt),
      series,
      volumes,
    };
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function normalizeVolume(volume, series = null) {
    const isbn = String(volume.isbn || "");
    const isbn13 = String(normalizeIsbn13(volume.isbn13) || normalizeIsbn13(isbn) || volume.isbn13 || "");
    const normalizedVolume = {
      id: String(volume.id || `${volume.seriesId || "serie"}-${String(volume.volumeNumber || 1).padStart(3, "0")}`),
      seriesId: String(volume.seriesId || ""),
      volumeNumber: Number(volume.volumeNumber || 1),
      title: String(volume.title || ""),
      subtitle: String(volume.subtitle || ""),
      isbn,
      isbn13,
      publisher: normalizePublisher(volume.publisher || series?.publisher),
      releaseDate: String(volume.releaseDate || ""),
      releaseSource: String(volume.releaseSource || ""),
      releaseConfidence: normalizeConfidence(volume.releaseConfidence),
      coverUrl: String(volume.coverUrl || ""),
      coverSource: String(volume.coverSource || ""),
      coverConfidence: normalizeConfidence(volume.coverConfidence),
      coverCheckedAt: String(volume.coverCheckedAt || ""),
      coverHash: String(volume.coverHash || ""),
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
    normalizedVolume.editionFingerprint = String(volume.editionFingerprint || createEditionFingerprint(normalizedVolume, series));
    return normalizedVolume;
  }

  function normalizeConfidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  }

  function normalizeIsbn13(value) {
    const digits = String(value || "").replace(/[^0-9Xx]/g, "");
    return /^\d{13}$/.test(digits) ? digits : "";
  }

  function normalizeTitleForFingerprint(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function createEditionFingerprint(volume, series) {
    const publisher = normalizePublisher(volume?.publisher || series?.publisher || "");
    const title = normalizeTitleForFingerprint(series?.title || volume?.title || "");
    const volumeNumber = Number(volume?.volumeNumber || 1);
    const editionType = editionTypeValues.includes(volume?.editionType) ? volume.editionType : "standard";
    const isbn13 = String(volume?.isbn13 || normalizeIsbn13(volume?.isbn) || "");
    return [publisher, title, volumeNumber, editionType, isbn13].filter((part) => part !== "").join("|");
  }

  function createCacheEditionFingerprint(item) {
    const publisher = normalizePublisher(item?.publisher || "");
    const title = normalizeTitleForFingerprint(item?.seriesTitle || item?.title || "");
    const volumeNumber = Number(item?.volumeNumber || 1);
    const editionType = normalizeEditionType(item?.editionType || "", item?.seriesTitle || item?.title || "");
    const isbn13 = normalizeIsbn13(item?.isbn13 || "");
    return [publisher, title, volumeNumber, editionType, isbn13].filter((part) => part !== "").join("|");
  }

  function canUpdateCover(volume, incomingCover) {
    if (volume?.coverManuallySet) return false;
    if (!incomingCover?.coverUrl) return false;
    if (!volume?.coverUrl) return true;
    return normalizeConfidence(incomingCover.coverConfidence) > normalizeConfidence(volume.coverConfidence);
  }

  function canPreviewCoverUpdate(volume, candidate) {
    const series = seriesById(volume?.seriesId || "");
    const normalizedVolume = normalizeVolume(volume || {}, series);
    if (!validateCoverCandidate(normalizedVolume, candidate)) return false;
    return canUpdateCover(normalizedVolume, {
      coverUrl: candidate.coverUrl,
      coverConfidence: candidate.confidence,
    }) && normalizedVolume.coverUrl !== candidate.coverUrl;
  }

  function canUpdateReleaseDate(volume, incomingRelease) {
    if (!incomingRelease?.releaseDate) return false;
    if (normalizeConfidence(incomingRelease.releaseConfidence) < normalizeConfidence(volume?.releaseConfidence)) return false;
    return isPlausibleReleaseDate(incomingRelease.releaseDate);
  }

  function isPlausibleReleaseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const parsed = Date.parse(`${value}T00:00:00`);
    if (Number.isNaN(parsed)) return false;
    const year = new Date(parsed).getUTCFullYear();
    return year >= 1950 && year <= 2100;
  }

  function normalizeEditionType(value, title = "") {
    const normalized = String(value || "").trim().toLowerCase().replace(/[_\s-]+/g, " ");
    if (editionTypeValues.includes(normalized)) return normalized;
    const haystack = `${normalized} ${String(title || "").toLowerCase()}`;
    if (/\bbox\s*set\b|\bboxset\b|\bschuber\b/.test(haystack)) return "boxset";
    if (/\blimited\b|\blimited edition\b|\bsonderausgabe\b/.test(haystack)) return "limited";
    if (/\bcollector\b|\bcollectors\b|\bcollector'?s\b/.test(haystack)) return "collector";
    if (/\bdeluxe\b|\bdeluxe edition\b/.test(haystack)) return "deluxe";
    if (/\bother\b/.test(haystack)) return "other";
    return "standard";
  }

  function normalizeExternalConfidence(value, fallback = 70) {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return normalizeConfidence(number <= 1 ? number * 100 : number);
  }

  function normalizeReleaseDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (isPlausibleReleaseDate(raw)) return raw;

    const germanMatch = raw.match(/^(\d{1,2})\.\s*([A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df]+)\s+(\d{4})$/);
    const months = {
      januar: "01",
      februar: "02",
      maerz: "03",
      marz: "03",
      april: "04",
      mai: "05",
      juni: "06",
      juli: "07",
      august: "08",
      september: "09",
      oktober: "10",
      november: "11",
      dezember: "12",
    };
    if (germanMatch) {
      const day = germanMatch[1].padStart(2, "0");
      const monthKey = germanMatch[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const month = months[monthKey];
      const date = month ? `${germanMatch[3]}-${month}-${day}` : "";
      return isPlausibleReleaseDate(date) ? date : "";
    }

    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return "";
    const date = todayLocalDate(new Date(parsed));
    return isPlausibleReleaseDate(date) ? date : "";
  }

  function logReleaseConflict(conflict) {
    const conflicts = getReleaseConflicts();
    conflicts.unshift({
      id: String(conflict.id || `release-conflict-${Date.now()}`),
      volumeId: String(conflict.volumeId || ""),
      seriesId: String(conflict.seriesId || ""),
      type: String(conflict.type || "release_date_conflict"),
      oldValue: String(conflict.oldValue || ""),
      newValue: String(conflict.newValue || ""),
      source: String(conflict.source || ""),
      createdAt: conflict.createdAt || nowIso(),
    });
    localStorage.setItem(RELEASE_CONFLICTS_KEY, JSON.stringify(conflicts.slice(0, 100)));
  }

  function getReleaseConflicts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RELEASE_CONFLICTS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn("Release-Konflikte konnten nicht gelesen werden:", error);
      return [];
    }
  }

  function clearReleaseConflicts() {
    localStorage.setItem(RELEASE_CONFLICTS_KEY, JSON.stringify([]));
  }

  function normalizeMangaPassionImport(rawData) {
    const root = Array.isArray(rawData) ? { volumes: rawData } : rawData || {};
    const volumes = Array.isArray(root.volumes) ? root.volumes
      : Array.isArray(root.items) ? root.items
        : Array.isArray(root.releases) ? root.releases
          : [];

    return {
      source: String(root.source || "manga-passion"),
      seriesTitle: String(root.series?.title || root.title || ""),
      seriesUrl: String(root.series?.mangaPassionUrl || root.series?.url || root.mangaPassionUrl || root.url || ""),
      volumes: volumes.map((item, index) => {
        const title = String(item.title || item.name || "");
        const volumeNumber = positiveInteger(item.volumeNumber || item.volume || item.band || item.number);
        const editionType = normalizeEditionType(item.editionType || item.edition || item.format, title);
        return {
          id: String(item.id || item.mangaPassionId || item.url || `manga-passion-${index + 1}`),
          title,
          subtitle: String(item.subtitle || ""),
          volumeNumber,
          publisher: normalizePublisher(item.publisher || item.verlag || ""),
          releaseDate: normalizeReleaseDate(item.releaseDate || item.release || item.veroeffentlichung || item.veroffentlichung || ""),
          releaseConfidence: normalizeExternalConfidence(item.releaseConfidence || item.confidence, 80),
          isbn13: normalizeIsbn13(item.isbn13 || item.isbn || ""),
          coverUrl: String(item.coverUrl || item.cover || item.image || ""),
          coverConfidence: normalizeExternalConfidence(item.coverConfidence || item.confidence, 75),
          editionType,
          sourceUrl: String(item.mangaPassionUrl || item.url || ""),
          format: String(item.format || ""),
        };
      }).filter((item) => item.volumeNumber > 0),
    };
  }

  function previewReleaseUpdateForSeries(seriesId, mangaPassionData) {
    const series = seriesById(seriesId);
    if (!series) throw new Error("Serie nicht gefunden.");

    const imported = normalizeMangaPassionImport(mangaPassionData);
    const localVolumes = volumesForSeries(seriesId);
    const rows = imported.volumes
      .filter((incoming) => shouldConsiderIncomingEdition(incoming, localVolumes))
      .map((incoming) => createReleasePreviewRow(series, localVolumes, incoming))
      .filter((row) => row.changes.length > 0 || row.status === "conflict");

    return {
      seriesId,
      seriesTitle: series.title,
      source: imported.source,
      sourceUrl: imported.seriesUrl || series.links.mangaPassion || "",
      createdAt: nowIso(),
      rows,
    };
  }

  function validateReleaseCache(cacheData) {
    const errors = [];
    const blockedUserDataKeys = new Set([
      "accessKey",
      "apiKey",
      "boughtAt",
      "email",
      "notes",
      "owned",
      "read",
      "readAt",
      "token",
      "user",
      "username",
    ]);

    if (!cacheData || typeof cacheData !== "object" || Array.isArray(cacheData)) {
      return { valid: false, errors: ["Release-Cache muss ein Objekt sein."] };
    }
    if (!Object.prototype.hasOwnProperty.call(cacheData, "schemaVersion")) {
      errors.push("schemaVersion fehlt.");
    }
    if (!Array.isArray(cacheData.items)) {
      errors.push("items muss ein Array sein.");
    }

    collectBlockedKeys(cacheData, blockedUserDataKeys).forEach((key) => {
      errors.push(`Nicht erlaubtes Nutzerdaten-Feld gefunden: ${key}.`);
    });

    if (Array.isArray(cacheData.items)) {
      cacheData.items.forEach((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          errors.push(`items[${index}] muss ein Objekt sein.`);
          return;
        }
        if (!String(item.seriesTitle || "").trim()) errors.push(`items[${index}].seriesTitle fehlt.`);
        if (!String(item.publisher || "").trim()) errors.push(`items[${index}].publisher fehlt.`);
        if (!positiveInteger(item.volumeNumber)) errors.push(`items[${index}].volumeNumber fehlt oder ist ungueltig.`);
        if (item.releaseDate && !normalizeReleaseDate(item.releaseDate)) errors.push(`items[${index}].releaseDate ist ungueltig.`);
        if (item.isbn13 && !normalizeIsbn13(item.isbn13)) errors.push(`items[${index}].isbn13 ist ungueltig.`);
        if (item.coverUrl && !isSafePublicUrl(item.coverUrl)) errors.push(`items[${index}].coverUrl ist ungueltig.`);
      });
    }

    return { valid: errors.length === 0, errors };
  }

  function collectBlockedKeys(value, blockedKeys, path = "") {
    const found = [];
    if (!value || typeof value !== "object") return found;
    Object.keys(value).forEach((key) => {
      const nextPath = path ? `${path}.${key}` : key;
      if (blockedKeys.has(key)) found.push(nextPath);
      found.push(...collectBlockedKeys(value[key], blockedKeys, nextPath));
    });
    return found;
  }

  function isSafePublicUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:";
    } catch (error) {
      return false;
    }
  }

  function filterReleaseCacheForSeries(cacheData, series) {
    const seriesTitle = normalizeTitleForFingerprint(series.title);
    const originalTitle = normalizeTitleForFingerprint(series.originalTitle);
    const seriesPublisher = normalizePublisher(series.publisher);
    const items = cacheData.items.filter((item) => {
      const itemTitle = normalizeTitleForFingerprint(item.seriesTitle);
      const titleMatches = itemTitle === seriesTitle || (originalTitle && itemTitle === originalTitle);
      const publisherMatches = normalizePublisher(item.publisher) === seriesPublisher || seriesPublisher === "other";
      return titleMatches && publisherMatches;
    });

    return {
      schemaVersion: cacheData.schemaVersion,
      generatedAt: cacheData.generatedAt || null,
      source: "release-cache",
      url: "./data/release-cache.json",
      itemCount: cacheData.itemCount ?? cacheData.items.length,
      items,
    };
  }

  async function readReleaseCacheFile() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch("./data/release-cache.json", { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      throw new Error(`Release-Cache konnte nicht geladen werden: HTTP ${response.status}`);
    }
    let cacheData;
    try {
      cacheData = await response.json();
    } catch {
      throw new Error("Release-Cache ist beschädigt (ungültiges JSON).");
    }
    const validation = validateReleaseCache(cacheData);
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }
    return cacheData;
  }

  function normalizeReleaseCacheItem(item, index = 0) {
    const title = String(item.seriesTitle || item.title || "");
    const editionType = normalizeEditionType(item.editionType || "", title);
    return {
      id: String(item.id || item.sourceUrl || `${title}-${item.volumeNumber || index + 1}-${editionType}`),
      seriesTitle: title,
      publisher: normalizePublisher(item.publisher || ""),
      volumeNumber: positiveInteger(item.volumeNumber),
      releaseDate: normalizeReleaseDate(item.releaseDate || item.release || ""),
      coverUrl: String(item.coverUrl || ""),
      editionType,
      isbn13: normalizeIsbn13(item.isbn13 || ""),
      confidence: normalizeExternalConfidence(item.confidence, 0),
      editionFingerprint: String(item.editionFingerprint || createCacheEditionFingerprint(item)),
      sourceUrl: String(item.sourceUrl || item.mangaPassionUrl || item.url || "./data/release-cache.json"),
    };
  }

  function validateCoverCandidate(volume, candidate) {
    if (!volume || !candidate) return false;
    if (!candidate.coverUrl || !isSafePublicUrl(candidate.coverUrl)) return false;
    if (normalizeConfidence(candidate.confidence) < 70) return false;
    if (normalizePublisher(candidate.publisher) !== normalizePublisher(volume.publisher)) return false;
    if (candidate.editionType !== normalizeEditionType(volume.editionType || "standard", volume.title)) return false;
    return true;
  }

  function getCoverCandidateBlockReason(volume, candidate) {
    if (!volume) return "local_volume_missing";
    if (!candidate) return "cache_candidate_missing";
    if (!candidate.coverUrl) return "cache_cover_url_missing";
    if (!isSafePublicUrl(candidate.coverUrl)) return "cache_cover_url_invalid";
    if (normalizeConfidence(candidate.confidence) < 70) return "cache_confidence_below_70";
    if (normalizePublisher(candidate.publisher) !== normalizePublisher(volume.publisher)) return "publisher_mismatch";
    if (candidate.editionType !== normalizeEditionType(volume.editionType || "standard", volume.title)) return "edition_mismatch";
    if (volume.coverManuallySet) return "local_cover_manually_set";
    if (volume.coverUrl && normalizeConfidence(candidate.confidence) <= normalizeConfidence(volume.coverConfidence)) return "local_cover_confidence_not_higher";
    if (volume.coverUrl === candidate.coverUrl) return "same_cover_url";
    return "";
  }

  function createCoverMatchDebugEntry(series, volume, candidate) {
    const localVolume = normalizeVolume(volume, series);
    const localPublisher = normalizePublisher(localVolume.publisher || series.publisher);
    const localFingerprint = createEditionFingerprint(localVolume, series);
    const cacheTitle = normalizeTitleForFingerprint(candidate.seriesTitle);
    const seriesTitle = normalizeTitleForFingerprint(series.title);
    const originalTitle = normalizeTitleForFingerprint(series.originalTitle);
    const titleMatches = cacheTitle === seriesTitle || (originalTitle && cacheTitle === originalTitle);
    const matchByIsbn = Boolean(candidate.isbn13 && localVolume.isbn13 && candidate.isbn13 === localVolume.isbn13);
    const matchByFingerprint = Boolean(candidate.editionFingerprint && candidate.editionFingerprint === localFingerprint);
    const matchByFallback = Boolean(titleMatches
      && candidate.publisher === localPublisher
      && candidate.volumeNumber === localVolume.volumeNumber
      && candidate.editionType === localVolume.editionType);
    const blockReason = getCoverCandidateBlockReason(localVolume, candidate);

    return {
      localVolumeId: localVolume.id,
      localVolumeNumber: localVolume.volumeNumber,
      localPublisher,
      localEditionType: localVolume.editionType,
      localIsbn13: localVolume.isbn13,
      localFingerprint,
      cacheVolumeNumber: candidate.volumeNumber,
      cachePublisher: candidate.publisher,
      cacheEditionType: candidate.editionType,
      cacheIsbn13: candidate.isbn13,
      matchByIsbn,
      matchByFingerprint,
      matchByFallback,
      blocked: Boolean(blockReason),
      blockReason,
    };
  }

  function matchCoverCandidates(series, volume, cacheItems) {
    const normalizedVolume = normalizeVolume(volume, series);
    const title = normalizeTitleForFingerprint(series.title);
    const originalTitle = normalizeTitleForFingerprint(series.originalTitle);
    const volumePublisher = normalizePublisher(normalizedVolume.publisher || series.publisher);
    const volumeFingerprint = createEditionFingerprint(normalizedVolume, series);

    return cacheItems
      .map(normalizeReleaseCacheItem)
      .filter((candidate) => validateCoverCandidate({ ...normalizedVolume, publisher: volumePublisher }, candidate))
      .filter((candidate) => {
        if (candidate.isbn13 && normalizedVolume.isbn13 && candidate.isbn13 === normalizedVolume.isbn13) return true;
        if (candidate.editionFingerprint && candidate.editionFingerprint === volumeFingerprint) return true;
        const candidateTitle = normalizeTitleForFingerprint(candidate.seriesTitle);
        const titleMatches = candidateTitle === title || (originalTitle && candidateTitle === originalTitle);
        return titleMatches
          && candidate.publisher === volumePublisher
          && candidate.volumeNumber === normalizedVolume.volumeNumber
          && candidate.editionType === normalizedVolume.editionType;
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  function createCoverPreview(series, volume, candidate) {
    return {
      id: `${volume.id}:cover:${String(candidate.coverUrl).slice(0, 48)}`,
      volumeId: volume.id,
      volumeNumber: volume.volumeNumber,
      editionType: volume.editionType,
      source: "release-cache",
      sourceUrl: candidate.sourceUrl || "./data/release-cache.json",
      confidence: normalizeConfidence(candidate.confidence),
      oldCoverUrl: volume.coverUrl,
      newCoverUrl: candidate.coverUrl,
      oldCoverConfidence: normalizeConfidence(volume.coverConfidence),
      selected: true,
      local: volume,
      incoming: candidate,
      seriesTitle: series.title,
    };
  }

  async function previewCoverUpdateForSeries(seriesId) {
    const series = seriesById(seriesId);
    if (!series) return;

    state.releasePreview = null;
    state.coverPreview = null;
    state.releaseCache = {
      seriesId,
      status: "loading",
      message: "Release-Cache wird fuer Cover geprueft...",
      generatedAt: null,
      itemCount: null,
      error: "",
    };
    render();

    try {
      const cacheData = await readReleaseCacheFile();
      const normalizedCacheItems = cacheData.items.map(normalizeReleaseCacheItem);
      const rows = volumesForSeries(seriesId)
        .map((volume) => {
          normalizedCacheItems.forEach((candidate) => {
            console.info("Cover-Cache-Matching", createCoverMatchDebugEntry(series, volume, candidate));
          });
          const [candidate] = matchCoverCandidates(series, volume, normalizedCacheItems);
          return candidate && canPreviewCoverUpdate(volume, candidate)
            ? createCoverPreview(series, volume, candidate)
            : null;
        })
        .filter(Boolean);

      state.releaseCache = {
        seriesId,
        status: "ok",
        message: createCoverCacheResultMessage(rows, normalizedCacheItems, volumesForSeries(seriesId)),
        generatedAt: cacheData.generatedAt || null,
        itemCount: cacheData.itemCount ?? cacheData.items.length,
        error: "",
      };
      state.coverPreview = {
        seriesId,
        seriesTitle: series.title,
        source: "release-cache",
        sourceUrl: "./data/release-cache.json",
        createdAt: nowIso(),
        cacheMetadata: {
          generatedAt: cacheData.generatedAt || null,
          itemCount: cacheData.itemCount ?? cacheData.items.length,
        },
        rows,
      };
      setNotice(createCoverCacheNotice(rows, normalizedCacheItems, volumesForSeries(seriesId)));
    } catch (error) {
      state.coverPreview = null;
      state.releaseCache = {
        seriesId,
        status: "error",
        message: "Release-Cache konnte nicht fuer Cover verwendet werden.",
        generatedAt: null,
        itemCount: null,
        error: error.message,
      };
      setNotice("Cover-Pruefung konnte den Release-Cache nicht laden.");
      console.error(error);
    }
  }

  async function loadBuyGapCache() {
    state.buyGapCache = {
      ...state.buyGapCache,
      status: "loading",
      error: "",
    };

    try {
      const cacheData = await readReleaseCacheFile();
      state.buyGapCache = {
        status: "ok",
        items: Array.isArray(cacheData.items) ? cacheData.items.map(normalizeReleaseCacheItem) : [],
        generatedAt: cacheData.generatedAt || null,
        itemCount: cacheData.itemCount ?? cacheData.items.length,
        error: "",
      };
      if (state.activeTab === "buy") render();
    } catch (error) {
      state.buyGapCache = {
        status: "error",
        items: [],
        generatedAt: null,
        itemCount: null,
        error: error.message,
      };
      if (state.activeTab === "buy") render();
    }
  }

  function createCoverCacheResultMessage(rows, cacheItems, localVolumes) {
    if (rows.length) return `${rows.length} Cover-Vorschlaege aus dem Release-Cache gefunden.`;
    if (!cacheItems.length) return "Keine Cover-Vorschlaege im Release-Cache gefunden.";
    return [
      "Cache-Eintraege gefunden, aber kein passender lokaler Band vorhanden. Pruefe Bandnummer, Edition oder ISBN.",
      `Cache-Baende: ${formatVolumeNumberList(cacheItems.map((item) => item.volumeNumber))}`,
      `Lokale Bandnummern: ${formatVolumeNumberList(localVolumes.map((volume) => volume.volumeNumber))}`,
    ].join(" ");
  }

  function createCoverCacheNotice(rows, cacheItems, localVolumes) {
    if (rows.length) return "Cover-Vorschau erstellt. Bitte pruefe die Auswahl.";
    if (!cacheItems.length) return "Keine uebernehmbaren Cover-Vorschlaege im Cache gefunden.";
    return createCoverCacheResultMessage(rows, cacheItems, localVolumes);
  }

  function formatVolumeNumberList(values) {
    const unique = Array.from(new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0))).sort((a, b) => a - b);
    return unique.length ? unique.join(", ") : "keine";
  }

  function updateCoverPreviewSelection(input) {
    if (!state.coverPreview) return;
    const rowId = input.dataset.coverRowId;
    state.coverPreview.rows = state.coverPreview.rows.map((row) => row.id === rowId ? { ...row, selected: input.checked } : row);
  }

  function applySelectedCoverPreview(seriesId = "") {
    const preview = state.coverPreview;
    if (!preview || (seriesId && preview.seriesId !== seriesId)) return;
    const selectedRows = preview.rows.filter((row) => row.selected && row.confidence >= 70);

    if (!selectedRows.length) {
      setNotice("Keine ausgewaehlten Cover mit ausreichender Confidence.");
      return;
    }

    const selectedByVolumeId = new Map(selectedRows.map((row) => [row.volumeId, row]));
    const backupKey = backupDatabaseSnapshot(state.database, "release-cache-cover-preview");
    let applied = 0;

    state.database.volumes = state.database.volumes.map((volume) => {
      const row = selectedByVolumeId.get(volume.id);
      if (!row) return volume;
      if (!canUpdateCover(volume, { coverUrl: row.newCoverUrl, coverConfidence: row.confidence })) return volume;
      const next = { ...volume };
      if (next.coverUrl && next.coverUrl !== row.newCoverUrl) {
        logReleaseConflict({
          volumeId: next.id,
          seriesId: next.seriesId,
          type: "cover_changed",
          oldValue: next.coverUrl,
          newValue: row.newCoverUrl,
          source: "release-cache",
        });
      }
      next.coverUrl = row.newCoverUrl;
      next.coverSource = "release-cache";
      next.coverConfidence = row.confidence;
      next.coverCheckedAt = TODAY;
      applied += 1;
      return normalizeVolume({ ...next, updatedAt: nowIso() }, seriesById(next.seriesId));
    });

    state.coverPreview = null;
    saveDatabase();
    setNotice(`${applied} Cover aktualisiert. Backup: ${backupKey}.`);
  }

  function shouldConsiderIncomingEdition(incoming, localVolumes) {
    if (incoming.editionType !== "standard") {
      return localVolumes.some((volume) => volume.volumeNumber === incoming.volumeNumber && volume.editionType === incoming.editionType);
    }
    return true;
  }

  function createReleasePreviewRow(series, localVolumes, incoming) {
    const candidates = localVolumes.filter((volume) => volume.editionType === incoming.editionType);
    const isbnMatch = incoming.isbn13 ? candidates.find((volume) => volume.isbn13 && volume.isbn13 === incoming.isbn13) : null;
    const numberMatch = candidates.find((volume) => volume.volumeNumber === incoming.volumeNumber);
    const localVolume = isbnMatch || numberMatch || null;
    const confidence = calculateReleaseMatchConfidence(series, localVolume, incoming, Boolean(isbnMatch));
    const changes = localVolume
      ? createExistingVolumeChanges(localVolume, incoming)
      : createNewVolumeChanges(series, incoming);

    return {
      id: `${series.id}:${incoming.id}:${incoming.editionType}`,
      status: confidence >= 70 ? (localVolume ? "update" : "new") : "conflict",
      confidence,
      volumeId: localVolume?.id || "",
      volumeNumber: incoming.volumeNumber,
      editionType: incoming.editionType,
      sourceUrl: incoming.sourceUrl,
      incoming,
      local: localVolume,
      changes,
    };
  }

  function calculateReleaseMatchConfidence(series, localVolume, incoming, isbnMatched) {
    if (isbnMatched) return 100;
    let score = 40;
    if (localVolume && localVolume.volumeNumber === incoming.volumeNumber) score += 25;
    if (incoming.publisher && incoming.publisher === normalizePublisher(localVolume?.publisher || series.publisher)) score += 15;
    if (normalizeTitleForFingerprint(incoming.title).includes(normalizeTitleForFingerprint(series.title))) score += 10;
    if (incoming.sourceUrl || series.links.mangaPassion) score += 5;
    if (incoming.releaseDate || incoming.isbn13 || incoming.coverUrl) score += 5;
    return normalizeConfidence(score);
  }

  function createExistingVolumeChanges(volume, incoming) {
    const changes = [];
    const incomingRelease = {
      releaseDate: incoming.releaseDate,
      releaseConfidence: incoming.releaseConfidence,
    };
    if (incoming.releaseDate && incoming.releaseDate !== volume.releaseDate && canUpdateReleaseDate(volume, incomingRelease)) {
      changes.push(createPreviewChange(volume.id, "releaseDate", volume.releaseDate, incoming.releaseDate, incoming.releaseConfidence));
    }
    if (!volume.isbn13 && incoming.isbn13) {
      changes.push(createPreviewChange(volume.id, "isbn13", volume.isbn13, incoming.isbn13, incoming.releaseConfidence));
    }
    if (canUpdateCover(volume, incoming) && incoming.coverUrl !== volume.coverUrl) {
      changes.push(createPreviewChange(volume.id, "coverUrl", volume.coverUrl, incoming.coverUrl, incoming.coverConfidence));
    }
    return changes;
  }

  function createNewVolumeChanges(series, incoming) {
    const baseId = `${series.id}-${String(incoming.volumeNumber).padStart(3, "0")}`;
    return [
      {
        id: `${baseId}:create`,
        volumeId: "",
        field: "createVolume",
        label: "Neuer Band",
        oldValue: "",
        newValue: `Band ${incoming.volumeNumber}`,
        confidence: incoming.releaseConfidence,
        selected: true,
      },
      incoming.releaseDate ? createPreviewChange("", "releaseDate", "", incoming.releaseDate, incoming.releaseConfidence) : null,
      incoming.isbn13 ? createPreviewChange("", "isbn13", "", incoming.isbn13, incoming.releaseConfidence) : null,
      incoming.coverUrl ? createPreviewChange("", "coverUrl", "", incoming.coverUrl, incoming.coverConfidence) : null,
    ].filter(Boolean);
  }

  function createPreviewChange(volumeId, field, oldValue, newValue, confidence) {
    const labels = {
      releaseDate: "Release-Datum",
      isbn13: "ISBN-13",
      coverUrl: "Cover",
    };
    return {
      id: `${volumeId || "new"}:${field}:${String(newValue).slice(0, 48)}`,
      volumeId,
      field,
      label: labels[field] || field,
      oldValue: String(oldValue || ""),
      newValue: String(newValue || ""),
      confidence: normalizeConfidence(confidence),
      selected: true,
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

  function getSupabaseConflicts() {
    try {
      return JSON.parse(localStorage.getItem(SUPABASE_CONFLICTS_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function logSupabaseConflict(result, cloudDatabase = null) {
    const logs = getSupabaseConflicts();
    let cloudBackupKey = "";
    if (cloudDatabase) {
      cloudBackupKey = backupDatabaseSnapshot(cloudDatabase, "supabase-cloud-conflict");
    }
    logs.unshift({
      type: result.type || "conflict",
      localUpdatedAt: result.localUpdatedAt,
      cloudUpdatedAt: result.cloudUpdatedAt,
      cloudRowUpdatedAt: result.cloudRowUpdatedAt,
      cloudBackupKey,
      resolvedAt: nowIso(),
    });
    localStorage.setItem(SUPABASE_CONFLICTS_KEY, JSON.stringify(logs.slice(0, 50)));
  }

  function buildSupabaseConflict(comparison, cloudDatabase, source = "check") {
    return {
      id: `supabase-conflict-${nowIso()}`,
      source,
      localUpdatedAt: comparison.localUpdatedAt,
      cloudUpdatedAt: comparison.cloudUpdatedAt,
      cloudRowUpdatedAt: comparison.cloudRowUpdatedAt,
      cloudDatabase,
      createdAt: nowIso(),
    };
  }

  function showSupabaseConflict(comparison, cloudDatabase, source = "check") {
    const conflict = buildSupabaseConflict(comparison, cloudDatabase, source);
    state.supabaseConflict = conflict;
    logSupabaseConflict({ ...comparison, type: `supabase-${source}-conflict` }, cloudDatabase);
    updateSupabaseMeta({
      lastRemoteUpdatedAt: comparison.cloudRowUpdatedAt || comparison.cloudUpdatedAt || null,
      lastStatus: "conflict",
    });
    setSupabaseStatus("conflict", "Es gibt unterschiedliche Datenstaende. Bitte bewusst auswaehlen.");
    return conflict;
  }

  function clearSupabaseConflict() {
    state.supabaseConflict = null;
  }

  async function supabaseGetCurrentUser() {
    const client = getSupabaseClient();
    if (!client) return null;
    const { data, error } = await client.auth.getUser();
    if (error) {
      state.supabaseUser = null;
      setSupabaseError(`Login konnte nicht gelesen werden: ${error.message}`);
      setSupabaseStatus("auth-error", `Supabase Login konnte nicht gelesen werden: ${error.message}`);
      return null;
    }
    state.supabaseUser = data.user || null;
    if (state.supabaseUser) {
      updateSupabaseMeta({
        lastUserEmail: state.supabaseUser.email || "",
        lastStatus: "signed-in",
      });
    }
    return state.supabaseUser;
  }

  async function supabaseSignIn(email) {
    state.supabaseConfig.loginEmail = String(email || "").trim();
    saveSupabaseConfig();
    const client = getSupabaseClient();
    if (!client) return { ok: false, reason: "not-configured" };
    if (!state.supabaseConfig.loginEmail) {
      setSupabaseStatus("missing-email", "Bitte eine Login-E-Mail eintragen.");
      render();
      return { ok: false, reason: "missing-email" };
    }
    const redirectTo = window.location.href.split("#")[0].split("?")[0];
    setSupabaseStatus("auth-pending", "Magic Link wird gesendet...");
    render();
    const { error } = await client.auth.signInWithOtp({
      email: state.supabaseConfig.loginEmail,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setSupabaseError(`Login fehlgeschlagen: ${error.message}`);
      setSupabaseStatus("auth-error", `Login fehlgeschlagen: ${error.message}`);
      render();
      return { ok: false, error };
    }
    clearSupabaseError();
    setSupabaseStatus("auth-link-sent", "Magic Link gesendet. Bitte E-Mail oeffnen und danach diese Seite erneut pruefen.");
    render();
    return { ok: true };
  }

  async function supabaseSignOut() {
    const client = getSupabaseClient();
    if (!client) return { ok: false, reason: "not-configured" };
    const { error } = await client.auth.signOut();
    if (error) {
      setSupabaseError(`Logout fehlgeschlagen: ${error.message}`);
      setSupabaseStatus("auth-error", `Logout fehlgeschlagen: ${error.message}`);
      render();
      return { ok: false, error };
    }
    state.supabaseUser = null;
    updateSupabaseMeta({ lastStatus: "signed-out" });
    setSupabaseStatus("signed-out", "Von Supabase abgemeldet.");
    render();
    return { ok: true };
  }

  async function getSupabaseCloudRow() {
    const user = await supabaseGetCurrentUser();
    if (!user) {
      updateSupabaseMeta({ lastStatus: "not-signed-in" });
      setSupabaseStatus("not-signed-in", "Bitte zuerst bei Supabase anmelden.");
      return { ok: false, reason: "not-signed-in" };
    }
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(SUPABASE_TABLE)
      .select("id,user_id,schema_version,database,updated_at,created_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      setSupabaseError(`Cloud-Daten konnten nicht gelesen werden: ${error.message}`);
      setSupabaseStatus("error", `Supabase Cloud-Daten konnten nicht gelesen werden: ${error.message}`);
      return { ok: false, error };
    }
    updateSupabaseMeta({
      lastRemoteUpdatedAt: data?.updated_at || null,
      lastUserEmail: user.email || state.supabaseMeta.lastUserEmail,
    });
    return { ok: true, user, row: data || null };
  }

  function compareLocalWithSupabaseRow(row) {
    const localUpdatedAt = Date.parse(state.database.updatedAt || "");
    const cloudUpdatedAt = Date.parse(row?.updated_at || "");
    const localTime = Number.isNaN(localUpdatedAt) ? 0 : localUpdatedAt;
    const cloudTime = Number.isNaN(cloudUpdatedAt) ? 0 : cloudUpdatedAt;
    return {
      localTime,
      cloudTime,
      localUpdatedAt: state.database.updatedAt,
      cloudUpdatedAt: row?.database?.updatedAt || "",
      cloudRowUpdatedAt: row?.updated_at || "",
    };
  }

  async function supabasePush(options = {}) {
    const { force = false, silent = false } = options;
    if (state.supabaseInProgress) return { ok: false, reason: "busy" };
    const validation = validateDatabase(state.database);
    if (!validation.valid) {
      setSupabaseStatus("error", `Lokale Daten sind ungueltig: ${validation.errors.join(" ")}`);
      render();
      return { ok: false, reason: "invalid-local" };
    }
    state.supabaseInProgress = true;
    if (!silent) {
      setSupabaseStatus("syncing", "Speichere lokale Daten bewusst in Supabase...");
      render();
    }
    try {
      const cloud = await getSupabaseCloudRow();
      if (!cloud.ok) return cloud;
      if (cloud.row) {
        const comparison = compareLocalWithSupabaseRow(cloud.row);
        if (comparison.cloudTime !== comparison.localTime && !force) {
          const cloudDatabase = normalizeDatabase(migrateDatabase(cloud.row.database).database);
          showSupabaseConflict(comparison, cloudDatabase, "push");
          render();
          return { ok: false, reason: "conflict-cloud-newer" };
        }
      }
      const client = getSupabaseClient();
      const payload = {
        user_id: cloud.user.id,
        schema_version: state.database.schemaVersion,
        database: {
          schemaVersion: state.database.schemaVersion,
          updatedAt: state.database.updatedAt,
          series: Array.isArray(state.database.series) ? state.database.series : [],
          volumes: Array.isArray(state.database.volumes) ? state.database.volumes : [],
        },
        updated_at: state.database.updatedAt,
      };
      const { data, error } = await client
        .from(SUPABASE_TABLE)
        .upsert(payload, { onConflict: "user_id" })
        .select("updated_at")
        .single();
      if (error) throw error;
      state.supabaseConfig.pendingPush = false;
      state.supabaseConfig.lastSyncAt = nowIso();
      clearSupabaseError();
      clearSupabaseConflict();
      updateSupabaseMeta({
        lastPushAt: nowIso(),
        lastSyncAt: state.supabaseConfig.lastSyncAt,
        lastRemoteUpdatedAt: data.updated_at,
        lastKnownLocalUpdatedAt: state.database.updatedAt,
        lastUserEmail: cloud.user.email || state.supabaseMeta.lastUserEmail,
        lastStatus: "ok",
      });
      setSupabaseStatus("ok", `In Supabase gespeichert (${formatDateTime(data.updated_at)}).`);
      if (!silent) render();
      return { ok: true, updatedAt: data.updated_at };
    } catch (error) {
      console.warn(error);
      state.supabaseConfig.pendingPush = true;
      setSupabaseError(error.message);
      setSupabaseStatus("error", `${error.message}. Lokal bleibt alles erhalten.`);
      if (!silent) render();
      return { ok: false, error };
    } finally {
      state.supabaseInProgress = false;
    }
  }

  async function supabasePull(options = {}) {
    const { force = false } = options;
    if (state.supabaseInProgress) return { ok: false, reason: "busy" };
    state.supabaseInProgress = true;
    setSupabaseStatus("syncing", "Lade Manga Tracker aus Supabase...");
    render();
    try {
      const cloud = await getSupabaseCloudRow();
      if (!cloud.ok) return cloud;
      if (!cloud.row) {
        setSupabaseStatus("empty", "In Supabase liegt noch kein Datensatz. Lokal bleibt fuehrend; nutze Cloud speichern fuer den ersten Push.");
        render();
        return { ok: true, reason: "empty" };
      }
      const validation = validateDatabase(cloud.row.database);
      if (!validation.valid) {
        throw new Error(`Supabase-Daten sind ungueltig: ${validation.errors.join(" ")}`);
      }
      const cloudDatabase = normalizeDatabase(migrateDatabase(cloud.row.database).database);
      const comparison = compareLocalWithSupabaseRow(cloud.row);
      if (comparison.localTime !== comparison.cloudTime && !force) {
        showSupabaseConflict(comparison, cloudDatabase, "pull");
        render();
        return { ok: false, reason: "conflict" };
      }
      const backupKey = backupDatabaseSnapshot(state.database, "supabase-pull");
      state.database = cloudDatabase;
      saveLocalDatabase();
      updateStorageStatus();
      state.supabaseConfig.pendingPush = false;
      state.supabaseConfig.lastSyncAt = nowIso();
      clearSupabaseError();
      clearSupabaseConflict();
      updateSupabaseMeta({
        lastPullAt: nowIso(),
        lastSyncAt: state.supabaseConfig.lastSyncAt,
        lastRemoteUpdatedAt: cloud.row.updated_at,
        lastKnownLocalUpdatedAt: state.database.updatedAt,
        lastUserEmail: cloud.user.email || state.supabaseMeta.lastUserEmail,
        lastStatus: "ok",
      });
      setSupabaseStatus("ok", `Supabase-Daten geladen. Backup: ${backupKey}.`);
      render();
      return { ok: true, backupKey };
    } catch (error) {
      console.warn(error);
      setSupabaseError(error.message);
      setSupabaseStatus("error", `${error.message}. Lokal bleibt alles erhalten.`);
      render();
      return { ok: false, error };
    } finally {
      state.supabaseInProgress = false;
    }
  }

  async function supabaseSync() {
    return supabaseCheck();
  }

  async function supabaseCheck() {
    if (state.supabaseInProgress) return { ok: false, reason: "busy" };
    state.supabaseInProgress = true;
    setSupabaseStatus("checking", "Pruefe Supabase-Status ohne Daten zu veraendern...");
    render();
    try {
      const cloud = await getSupabaseCloudRow();
      if (!cloud.ok) {
        render();
        return cloud;
      }
      if (!cloud.row) {
        clearSupabaseConflict();
        clearSupabaseError();
        updateSupabaseMeta({
          lastSyncAt: nowIso(),
          lastRemoteUpdatedAt: null,
          lastStatus: "empty",
        });
        setSupabaseStatus("empty", "In Supabase liegt noch kein Datensatz. Cloud speichern legt ihn an.");
        render();
        return { ok: true, reason: "empty" };
      }
      const validation = validateDatabase(cloud.row.database);
      if (!validation.valid) {
        throw new Error(`Supabase-Daten sind ungueltig: ${validation.errors.join(" ")}`);
      }
      const cloudDatabase = normalizeDatabase(migrateDatabase(cloud.row.database).database);
      const comparison = compareLocalWithSupabaseRow(cloud.row);
      updateSupabaseMeta({
        lastSyncAt: nowIso(),
        lastRemoteUpdatedAt: cloud.row.updated_at,
        lastUserEmail: cloud.user.email || state.supabaseMeta.lastUserEmail,
      });
      if (comparison.localTime !== comparison.cloudTime) {
        showSupabaseConflict(comparison, cloudDatabase, "check");
        render();
        return { ok: true, reason: "conflict", comparison };
      }
      clearSupabaseConflict();
      clearSupabaseError();
      updateSupabaseMeta({ lastStatus: "ok" });
      setSupabaseStatus("ok", "Sync geprueft: Supabase und lokale Daten sind gleich.");
      render();
      return { ok: true, reason: "equal" };
    } catch (error) {
      console.warn(error);
      setSupabaseError(error.message);
      setSupabaseStatus("error", `${error.message}. Es wurden keine Manga-Daten veraendert.`);
      render();
      return { ok: false, error };
    } finally {
      state.supabaseInProgress = false;
    }
  }



  async function initSupabase() {
    if (!isSupabaseConfigured()) {
      state.appMode = "setup";
      setSupabaseStatus("missing-config", "Supabase noch nicht eingerichtet. Bitte URL und Public Key in den Einstellungen eintragen.");
      render();
      return;
    }

    await supabaseGetCurrentUser();

    if (!state.supabaseUser) {
      state.appMode = "readonly";
      setSupabaseStatus("signed-out", "Nicht angemeldet. Bitte anmelden um mit deinen Cloud-Daten zu arbeiten.");
      render();
      return;
    }

    state.appMode = "loading";
    setSupabaseStatus("syncing", "Lade Cloud-Daten…");
    render();

    const result = await supabasePull();

    if (result.ok) {
      state.appMode = "cloud";
      setSupabaseStatus("ok", `Cloud-Daten geladen (${state.supabaseUser.email || state.supabaseUser.id}).`);
    } else if (result.reason === "empty") {
      const hasLocalData = state.database.series.length > 0 || state.database.volumes.length > 0;
      if (hasLocalData) {
        state.appMode = "readonly";
        state.showFirstTimeDialog = true;
        setSupabaseStatus("signed-in", "Cloud leer — lokale Daten gefunden. Bitte entscheiden.");
      } else {
        state.appMode = "cloud";
        setSupabaseStatus("ok", "Bereit. Noch keine Cloud-Daten vorhanden.");
      }
    } else if (result.reason === "conflict") {
      state.appMode = "cloud";
    } else {
      state.appMode = "offline";
      setSupabaseStatus("error", "Supabase nicht erreichbar. Letzter lokaler Cache wird angezeigt.");
    }
    render();
  }

  function setNotice(message) {
    state.notice = message;
    render();
  }

  function updateStorageStatus() {
    let saveLabel;
    let stateName = "neutral";
    if (state.savePending) {
      saveLabel = "Speichern läuft…";
      stateName = "saving";
    } else if (state.saveError) {
      saveLabel = "Nicht gespeichert";
      stateName = "error";
    } else if (state.appMode === "cloud") {
      saveLabel = "Cloud gespeichert";
      stateName = "saved";
    } else if (state.appMode === "readonly") {
      saveLabel = "Read-only";
      stateName = "readonly";
    } else if (state.appMode === "offline") {
      saveLabel = "Cloud offline";
      stateName = "offline";
    } else if (state.appMode === "setup") {
      saveLabel = "Setup erforderlich";
      stateName = "setup";
    } else if (state.appMode === "loading") {
      saveLabel = "Lade Cloud-Daten…";
      stateName = "saving";
    } else {
      saveLabel = state.supabaseConfig.enabled ? `Cloud: ${state.supabaseConfig.lastSyncStatus}` : "Cloud aus";
    }
    storageStatus.className = `storage-status is-${stateName}`;
    storageStatus.textContent = saveLabel;
    storageStatus.title = `${formatDateTime(state.database.updatedAt)} · ${saveLabel}`;
  }

  function seriesById(seriesId) {
    return state.database.series.find((series) => series.id === seriesId);
  }

  function volumesForSeries(seriesId) {
    return state.database.volumes
      .filter((volume) => volume.seriesId === seriesId)
      .sort((a, b) => a.volumeNumber - b.volumeNumber);
  }

  function normalizeEditionTypeForAnalysis(value) {
    return editionTypeValues.includes(value) ? value : "standard";
  }

  function isAggregateVolume(volume) {
    const editionType = normalizeEditionTypeForAnalysis(volume?.editionType || "");
    if (editionType === "boxset") return true;
    const text = `${volume?.title || ""} ${volume?.subtitle || ""} ${volume?.notes || ""}`.toLowerCase();
    return /\bbox\s*set\b|\bboxset\b|\bschuber\b|\bomnibus\b|\bsammelband\b|\bsammelbaende\b|\bsammelbände\b/.test(text);
  }

  function isAggregateCacheItem(item) {
    const editionType = normalizeEditionTypeForAnalysis(item?.editionType || "");
    if (editionType === "boxset") return true;
    const text = `${item?.seriesTitle || ""} ${item?.title || ""}`.toLowerCase();
    return /\bbox\s*set\b|\bboxset\b|\bschuber\b|\bomnibus\b|\bsammelband\b|\bsammelbaende\b|\bsammelbände\b/.test(text);
  }

  function analysisVolumeSort(a, b) {
    return a.volumeNumber - b.volumeNumber
      || String(a.releaseDate || "").localeCompare(String(b.releaseDate || ""), "de")
      || String(a.id || "").localeCompare(String(b.id || ""), "de");
  }

  function getAnalysisVolumes(seriesId, editionType = "") {
    const normalizedEditionType = normalizeEditionTypeForAnalysis(editionType);
    return volumesForSeries(seriesId)
      .filter((volume) => normalizeEditionTypeForAnalysis(volume.editionType) === normalizedEditionType)
      .sort(analysisVolumeSort);
  }

  function getSequentialAnalysisVolumes(seriesId, editionType = "") {
    return getAnalysisVolumes(seriesId, editionType).filter((volume) => !isAggregateVolume(volume));
  }

  function getEditionGroups(seriesId) {
    const groups = new Map();
    volumesForSeries(seriesId).forEach((volume) => {
      const editionType = normalizeEditionTypeForAnalysis(volume.editionType);
      if (!groups.has(editionType)) {
        groups.set(editionType, {
          seriesId,
          editionType,
          volumes: [],
          sequentialVolumes: [],
          aggregateVolumes: [],
        });
      }
      const group = groups.get(editionType);
      group.volumes.push(volume);
      if (isAggregateVolume(volume)) {
        group.aggregateVolumes.push(volume);
      } else {
        group.sequentialVolumes.push(volume);
      }
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        volumes: group.volumes.sort(analysisVolumeSort),
        sequentialVolumes: group.sequentialVolumes.sort(analysisVolumeSort),
        aggregateVolumes: group.aggregateVolumes.sort(analysisVolumeSort),
      }))
      .sort((a, b) => editionTypeValues.indexOf(a.editionType) - editionTypeValues.indexOf(b.editionType));
  }

  function getKnownVolumeRange(seriesId, editionType) {
    const numbers = getSequentialAnalysisVolumes(seriesId, editionType)
      .map((volume) => positiveInteger(volume.volumeNumber))
      .filter((volumeNumber) => volumeNumber > 0);
    if (!numbers.length) {
      return {
        seriesId,
        editionType: normalizeEditionTypeForAnalysis(editionType),
        min: 0,
        max: 0,
        volumeNumbers: [],
      };
    }
    const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
    return {
      seriesId,
      editionType: normalizeEditionTypeForAnalysis(editionType),
      min: Math.min(...unique),
      max: Math.max(...unique),
      volumeNumbers: unique,
    };
  }

  function getMissingVolumes(seriesId, editionType) {
    const range = getKnownVolumeRange(seriesId, editionType);
    if (!range.max) return [];
    const known = new Set(range.volumeNumbers);
    const missing = [];
    const start = Math.min(range.min, 1);
    for (let volumeNumber = start; volumeNumber <= range.max; volumeNumber += 1) {
      if (!known.has(volumeNumber)) {
        missing.push({
          id: `${seriesId}:${range.editionType}:${volumeNumber}:missing`,
          seriesId,
          editionType: range.editionType,
          volumeNumber,
          releaseDate: "",
          status: "missing",
          source: "analysis",
          localVolume: null,
        });
      }
    }
    return missing;
  }

  function getReleasedUnowned(seriesId, editionType) {
    const today = todayLocalDate();
    return getSequentialAnalysisVolumes(seriesId, editionType)
      .filter((volume) => !volume.owned && volume.releaseDate && volume.releaseDate <= today)
      .map((volume) => ({
        id: `${volume.id}:released-unowned`,
        seriesId,
        editionType: normalizeEditionTypeForAnalysis(volume.editionType),
        volumeNumber: volume.volumeNumber,
        releaseDate: volume.releaseDate,
        status: "released_unowned",
        source: "local",
        localVolume: volume,
      }));
  }

  function getUpcomingVolumes(seriesId, editionType) {
    const today = todayLocalDate();
    return getSequentialAnalysisVolumes(seriesId, editionType)
      .filter((volume) => volume.releaseDate && volume.releaseDate > today)
      .map((volume) => ({
        id: `${volume.id}:upcoming`,
        seriesId,
        editionType: normalizeEditionTypeForAnalysis(volume.editionType),
        volumeNumber: volume.volumeNumber,
        releaseDate: volume.releaseDate,
        status: "upcoming",
        source: "local",
        localVolume: volume,
      }));
  }

  function getSeriesCollectionSummary(seriesId) {
    const groups = getEditionGroups(seriesId);
    const editions = groups.map((group) => {
      const missing = getMissingVolumes(seriesId, group.editionType);
      const releasedUnowned = getReleasedUnowned(seriesId, group.editionType);
      const upcoming = getUpcomingVolumes(seriesId, group.editionType);
      return {
        seriesId,
        editionType: group.editionType,
        missing,
        releasedUnowned,
        upcoming,
        missingCount: missing.length,
        buyableCount: releasedUnowned.length,
        upcomingCount: upcoming.length,
      };
    });

    return {
      seriesId,
      editions,
      missingCount: editions.reduce((sum, edition) => sum + edition.missingCount, 0),
      buyableCount: editions.reduce((sum, edition) => sum + edition.buyableCount, 0),
      upcomingCount: editions.reduce((sum, edition) => sum + edition.upcomingCount, 0),
    };
  }

  function hasLocalVolumeForGap(seriesId, editionType, volumeNumber) {
    const normalizedEditionType = normalizeEditionTypeForAnalysis(editionType);
    return state.database.volumes.some((volume) => volume.seriesId === seriesId
      && normalizeEditionTypeForAnalysis(volume.editionType) === normalizedEditionType
      && Number(volume.volumeNumber) === Number(volumeNumber));
  }

  function cacheCandidateMatchesGap(series, gap, candidate) {
    const title = normalizeTitleForFingerprint(series.title);
    const originalTitle = normalizeTitleForFingerprint(series.originalTitle);
    const candidateTitle = normalizeTitleForFingerprint(candidate.seriesTitle);
    const titleMatches = candidateTitle === title || (originalTitle && candidateTitle === originalTitle);
    return titleMatches
      && normalizePublisher(candidate.publisher) === normalizePublisher(series.publisher)
      && candidate.volumeNumber === gap.volumeNumber
      && normalizeEditionTypeForAnalysis(candidate.editionType) === normalizeEditionTypeForAnalysis(gap.editionType);
  }

  function createDerivedGapCandidate(series, gap, cacheItems) {
    if (hasLocalVolumeForGap(series.id, gap.editionType, gap.volumeNumber)) return null;
    const today = todayLocalDate();
    const candidates = cacheItems
      .filter((candidate) => !isAggregateCacheItem(candidate))
      .filter((candidate) => cacheCandidateMatchesGap(series, gap, candidate))
      .filter((candidate) => candidate.releaseDate && candidate.releaseDate <= today)
      .filter((candidate) => normalizeConfidence(candidate.confidence) >= 70)
      .sort((a, b) => normalizeConfidence(b.confidence) - normalizeConfidence(a.confidence)
        || String(a.sourceUrl || "").localeCompare(String(b.sourceUrl || ""), "de"));
    const candidate = candidates[0];
    if (!candidate) return null;
    return {
      id: `${series.id}:${gap.editionType}:${gap.volumeNumber}:derived-gap`,
      seriesId: series.id,
      seriesTitle: series.title,
      publisher: normalizePublisher(candidate.publisher || series.publisher),
      editionType: normalizeEditionTypeForAnalysis(gap.editionType),
      volumeNumber: gap.volumeNumber,
      releaseDate: candidate.releaseDate,
      isbn13: candidate.isbn13,
      confidence: normalizeConfidence(candidate.confidence),
      sourceUrl: candidate.sourceUrl,
      source: "release-cache",
      cacheItem: candidate,
    };
  }

  function getBuyTabGapDiagnostics(cacheItems) {
    const gaps = state.database.series.flatMap((series) => {
      const summary = getSeriesCollectionSummary(series.id);
      return summary.editions.flatMap((edition) => edition.missing.map((gap) => ({ series, gap })));
    });
    const usableCacheItems = cacheItems.filter((candidate) => !isAggregateCacheItem(candidate));
    const hasMatchingCacheEntry = gaps.some(({ series, gap }) => usableCacheItems
      .some((candidate) => cacheCandidateMatchesGap(series, gap, candidate)));
    const hasEligibleCacheEntry = gaps.some(({ series, gap }) => usableCacheItems
      .filter((candidate) => cacheCandidateMatchesGap(series, gap, candidate))
      .some((candidate) => candidate.releaseDate
        && candidate.releaseDate <= todayLocalDate()
        && normalizeConfidence(candidate.confidence) >= 70));

    return {
      missingGapCount: gaps.length,
      hasMatchingCacheEntry,
      hasEligibleCacheEntry,
    };
  }

  function getBuyTabAnalysisRows() {
    const today = todayLocalDate();
    const localBuyCandidates = state.database.volumes
      .filter((volume) => !volume.owned && volume.releaseDate && volume.releaseDate <= today)
      .sort(volumeSort);
    const cacheItems = state.buyGapCache.status === "ok" ? state.buyGapCache.items.map(normalizeReleaseCacheItem) : [];
    const gapDiagnostics = getBuyTabGapDiagnostics(cacheItems);
    const derivedGapCandidates = state.database.series.flatMap((series) => {
      const summary = getSeriesCollectionSummary(series.id);
      return summary.editions.flatMap((edition) => edition.missing
        .map((gap) => createDerivedGapCandidate(series, gap, cacheItems))
        .filter(Boolean));
    }).sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, "de")
      || editionTypeValues.indexOf(a.editionType) - editionTypeValues.indexOf(b.editionType)
      || a.volumeNumber - b.volumeNumber);

    return {
      localBuyCandidates,
      derivedGapCandidates,
      gapDiagnostics,
    };
  }

  function addDaysLocalDate(value, days) {
    const parsed = new Date(`${value}T00:00:00`);
    parsed.setDate(parsed.getDate() + days);
    return todayLocalDate(parsed);
  }

  function getDashboardStats() {
    const today = todayLocalDate();
    const next30Days = addDaysLocalDate(today, 30);
    const volumes = state.database.volumes;
    const owned = volumes.filter((volume) => volume.owned);
    const readOwned = volumes.filter((volume) => volume.owned && volume.read);
    const readWithoutOwned = volumes.filter((volume) => !volume.owned && volume.read);
    const localBuyCandidates = volumes.filter((volume) => !volume.owned && volume.releaseDate && volume.releaseDate <= today);
    const upcoming = volumes
      .filter((volume) => volume.releaseDate && volume.releaseDate > today)
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || volumeSort(a, b));
    const releasesNext30Days = upcoming.filter((volume) => volume.releaseDate <= next30Days);
    const summaries = state.database.series.map((series) => getSeriesCollectionSummary(series.id));
    const missingCount = summaries.reduce((sum, summary) => sum + summary.missingCount, 0);
    const upcomingCount = summaries.reduce((sum, summary) => sum + summary.upcomingCount, 0);
    const unknownOpenCount = state.database.series.reduce((sum, series) => {
      return sum + getEditionGroups(series.id).reduce((editionSum, edition) => {
        return editionSum + getUnknownCollectionRows(series.id, edition.editionType).length;
      }, 0);
    }, 0);
    const cacheItems = state.buyGapCache.status === "ok" ? state.buyGapCache.items.map(normalizeReleaseCacheItem) : [];
    const derivedBuyableGapCount = state.database.series.reduce((sum, series) => {
      const summary = getSeriesCollectionSummary(series.id);
      return sum + summary.editions.reduce((editionSum, edition) => {
        return editionSum + edition.missing
          .map((gap) => createDerivedGapCandidate(series, gap, cacheItems))
          .filter(Boolean).length;
      }, 0);
    }, 0);
    const publisherMap = new Map();
    const editionMap = new Map();
    const duplicateMap = new Map();

    volumes.forEach((volume) => {
      const series = seriesById(volume.seriesId);
      const publisher = normalizePublisher(volume.publisher || series?.publisher || "");
      publisherMap.set(publisher, (publisherMap.get(publisher) || 0) + 1);

      const editionType = normalizeEditionTypeForAnalysis(volume.editionType);
      editionMap.set(editionType, (editionMap.get(editionType) || 0) + 1);

      const volumeNumber = positiveInteger(volume.volumeNumber);
      if (volumeNumber > 0) {
        const duplicateKey = `${volume.seriesId}:${editionType}:${volumeNumber}`;
        duplicateMap.set(duplicateKey, (duplicateMap.get(duplicateKey) || 0) + 1);
      }
    });

    const volumeCounts = Array.from(publisherMap.entries())
      .map(([publisher, count]) => ({
        publisher,
        label: getPublisherLabel(publisher),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "de"));
    const editionCounts = Array.from(editionMap.entries())
      .map(([editionType, count]) => ({
        editionType,
        label: editionTypeLabel(editionType),
        count,
      }))
      .sort((a, b) => b.count - a.count || editionTypeValues.indexOf(a.editionType) - editionTypeValues.indexOf(b.editionType));
    const duplicateVolumeNumberCount = Array.from(duplicateMap.values())
      .reduce((sum, count) => sum + Math.max(0, count - 1), 0);

    return {
      totals: {
        seriesCount: state.database.series.length,
        volumeCount: volumes.length,
        ownedCount: owned.length,
        readOwnedCount: readOwned.length,
        readingProgressPercent: owned.length ? Math.round((readOwned.length / owned.length) * 100) : 0,
      },
      collection: {
        missingCount,
        buyableLocalCount: localBuyCandidates.length,
        derivedBuyableGapCount,
        upcomingCount,
        unknownOpenCount,
      },
      releases: {
        nextRelease: upcoming[0] || null,
        releasesNext30Days,
      },
      publishers: {
        topPublisher: volumeCounts[0] || null,
        volumeCounts,
      },
      editions: {
        counts: editionCounts,
      },
      dataQuality: {
        readWithoutOwnedCount: readWithoutOwned.length,
        volumesWithoutReleaseDateCount: volumes.filter((volume) => !volume.releaseDate).length,
        duplicateVolumeNumberCount,
      },
    };
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

  function renderAppModeBanner() {
    if (state.appMode === "cloud") return null;

    const el = document.createElement("div");
    el.className = `notice app-mode-banner is-${state.appMode}`;

    if (state.appMode === "loading") {
      el.textContent = "Lade Cloud-Daten…";
    } else if (state.appMode === "readonly") {
      el.innerHTML = `<strong>Nicht angemeldet</strong> — letzter lokaler Cache (read-only). Bitte anmelden um Änderungen zu speichern.`;
    } else if (state.appMode === "offline") {
      el.innerHTML = `<strong>Supabase nicht erreichbar</strong> — letzter Cache wird angezeigt. Bearbeitung deaktiviert.`;
    } else if (state.appMode === "setup") {
      el.innerHTML = `<strong>Supabase noch nicht eingerichtet</strong> — bitte <button type="button" class="link-button" data-action="go-settings">Einstellungen</button> öffnen und URL und Public Key eintragen.`;
    }
    return el;
  }

  function renderFirstTimeDialog() {
    const el = document.createElement("div");
    el.className = "modal-overlay";
    el.innerHTML = `
      <div class="modal-panel card">
        <h3>Lokale Daten gefunden</h3>
        <p>Du hast lokale Manga-Daten, aber noch keine Cloud-Daten in Supabase. Was soll passieren?</p>
        <div class="actions">
          <button type="button" class="button" data-action="first-time-migrate">Lokale Daten nach Supabase übernehmen</button>
          <button type="button" class="secondary-button" data-action="first-time-readonly">Nur ansehen (kein Upload)</button>
          <button type="button" class="secondary-button" data-action="first-time-cancel">Abbrechen</button>
        </div>
      </div>
    `;
    return el;
  }

  function render() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab);
    });

    updateStorageStatus();
    app.innerHTML = "";

    const banner = renderAppModeBanner();
    if (banner) app.append(banner);

    if (state.notice) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.textContent = state.notice;
      app.append(notice);
    }

    if (state.showFirstTimeDialog) {
      app.append(renderFirstTimeDialog());
    }

    const views = {
      dashboard: renderDashboard,
      series: renderSeriesView,
      collection: renderCollectionView,
      buy: renderBuyView,
      calendar: renderCalendarView,
      importExport: renderImportExportView,
      settings: renderSettingsView,
    };
    const view = views[state.activeTab] || views.dashboard;

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

  function renderStatCard(value, label, detail = "") {
    return `
      <div class="stat">
        <strong>${escapeHtml(value)}</strong>
        <span>${escapeHtml(label)}</span>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </div>
    `;
  }

  function renderBarList(rows) {
    if (!rows.length) return '<p class="muted">Noch keine Daten vorhanden.</p>';
    const max = Math.max(...rows.map((row) => row.count), 1);
    return `
      <div class="bar-list">
        ${rows.map((row) => `
          <div class="bar-row">
            <div class="bar-row-label">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.count)}</strong>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${Math.round((row.count / max) * 100)}%"></div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function formatNextReleaseLabel(volume) {
    if (!volume) return "kein Release";
    const series = seriesById(volume.seriesId);
    return `${series?.title || volume.title} Band ${volume.volumeNumber}`;
  }

  function daysUntilLocalDate(value) {
    if (!value) return null;
    const start = new Date(`${todayLocalDate()}T00:00:00`);
    const end = new Date(`${value}T00:00:00`);
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  }

  function renderDataQualityHints(dataQuality) {
    const hints = [];
    if (dataQuality.readWithoutOwnedCount > 0) {
      hints.push(`${dataQuality.readWithoutOwnedCount} gelesen markiert, aber nicht gekauft`);
    }
    if (dataQuality.volumesWithoutReleaseDateCount > 0) {
      hints.push(`${dataQuality.volumesWithoutReleaseDateCount} Baende ohne Release-Datum`);
    }
    if (dataQuality.duplicateVolumeNumberCount > 0) {
      hints.push(`${dataQuality.duplicateVolumeNumberCount} doppelte Bandnummern in gleicher Serie und Edition`);
    }
    if (!hints.length) return "";
    return `
      <section class="dashboard-section">
        <h3>Datenqualitaet</h3>
        <div class="badge-row">
          ${hints.map((hint) => `<span class="badge badge-warning">${escapeHtml(hint)}</span>`).join("")}
        </div>
      </section>
    `;
  }

  function renderDashboard() {
    const wrapper = document.createElement("section");
    const stats = getDashboardStats();
    const nextReleaseDays = daysUntilLocalDate(stats.releases.nextRelease?.releaseDate);
    const nextReleaseDetail = stats.releases.nextRelease
      ? `${formatDate(stats.releases.nextRelease.releaseDate)}${nextReleaseDays !== null ? ` - in ${nextReleaseDays} Tagen` : ""}`
      : "";

    wrapper.innerHTML = `
      ${viewHeader("Dashboard", "Ueberblick ueber Serien, gekaufte Baende, Lesestand und anstehende physische Releases.")}
      <div class="stats-grid">
        ${renderStatCard(stats.totals.seriesCount, "Serien")}
        ${renderStatCard(stats.totals.volumeCount, "Baende")}
        ${renderStatCard(stats.totals.ownedCount, "gekauft")}
        ${renderStatCard(stats.totals.readOwnedCount, "gelesen")}
        ${renderStatCard(`${stats.totals.readingProgressPercent}%`, "Lesefortschritt")}
        ${renderStatCard(stats.collection.missingCount, "fehlende Baende")}
        ${renderStatCard(stats.collection.buyableLocalCount + stats.collection.derivedBuyableGapCount, "jetzt kaufbar", `${stats.collection.buyableLocalCount} erfasst - ${stats.collection.derivedBuyableGapCount} anlegbar`)}
        ${renderStatCard(stats.collection.upcomingCount, "kommend")}
        ${renderStatCard(formatNextReleaseLabel(stats.releases.nextRelease), "naechster Release", nextReleaseDetail)}
        ${renderStatCard(stats.releases.releasesNext30Days.length, "Releases naechste 30 Tage")}
      </div>
    `;

    if (!state.database.series.length && !state.database.volumes.length) {
      wrapper.append(emptyState("Noch keine Daten", "Lege im Reiter Serien deine erste Serie an und fuege anschliessend Einzelbaende hinzu."));
      return wrapper;
    }

    const insights = document.createElement("section");
    insights.className = "dashboard-section";
    insights.innerHTML = `
      <div class="dashboard-insights">
        <article class="card">
          <h3>Top Verlag</h3>
          <p class="metric-line">${escapeHtml(stats.publishers.topPublisher?.label || "Noch keiner")}</p>
          <p class="muted">${stats.publishers.topPublisher ? `${stats.publishers.topPublisher.count} Baende` : "Noch keine Baende vorhanden."}</p>
        </article>
        <article class="card">
          <h3>Baende pro Verlag</h3>
          ${renderBarList(stats.publishers.volumeCounts)}
        </article>
        <article class="card">
          <h3>Editionen</h3>
          ${renderBarList(stats.editions.counts)}
        </article>
      </div>
      ${renderDataQualityHints(stats.dataQuality)}
    `;
    wrapper.append(insights);

    const nextReleases = state.database.volumes
      .filter((volume) => volume.releaseDate && volume.releaseDate > todayLocalDate())
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
      .slice(0, 6);
    if (nextReleases.length) {
      const section = document.createElement("section");
      section.className = "collection-section";
      section.innerHTML = `<h3>Kommende Releases</h3>`;
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.innerHTML = nextReleases.map((volume) => renderVolumeCard(volume)).join("");
      section.append(grid);
      wrapper.append(section);
    }
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
    const summary = getSeriesCollectionSummary(series.id);
    const collectionState = series.collectionStatus === "complete"
      ? "completed"
      : series.collectionStatus === "wishlist" ? "planned" : "reading";
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
          <span class="status-pill" data-state="${escapeHtml(series.status)}">${escapeHtml(statusLabel(series.status))}</span>
          <span class="status-pill" data-state="${escapeHtml(collectionState)}">${escapeHtml(collectionStatusLabel(series.collectionStatus))}</span>
          <span>${owned}/${volumes.length} gekauft</span>
          ${summary.missingCount ? `<span class="status-pill" data-state="missing">Fehlen: ${summary.missingCount}</span>` : ""}
          ${summary.buyableCount ? `<span class="status-pill" data-state="buy">Kaufbar: ${summary.buyableCount}</span>` : ""}
          ${summary.upcomingCount ? `<span>Kommend: ${summary.upcomingCount}</span>` : ""}
        </div>
        ${series.notes ? `<p class="muted">${escapeHtml(series.notes)}</p>` : ""}
        <div class="actions">
          <button type="button" class="secondary-button" data-action="edit-series" data-id="${escapeHtml(series.id)}">Bearbeiten</button>
          <button type="button" class="button" data-action="new-volume" data-id="${escapeHtml(series.id)}">Band hinzufügen</button>
          <button type="button" class="secondary-button" data-action="preview-cover-cache" data-id="${escapeHtml(series.id)}">Cover prüfen</button>
          <button type="button" class="secondary-button" data-action="load-release-cache" data-id="${escapeHtml(series.id)}">Release-Cache laden</button>
          <label class="secondary-button" for="mangaPassionImport-${escapeHtml(series.id)}">Release-Daten prüfen</label>
          <input id="mangaPassionImport-${escapeHtml(series.id)}" type="file" accept="application/json,.json" data-release-import="${escapeHtml(series.id)}" hidden>
          <button type="button" class="danger-button" data-action="delete-series" data-id="${escapeHtml(series.id)}">Löschen</button>
        </div>
        ${state.releaseCache.seriesId === series.id ? renderReleaseCacheStatus() : ""}
        ${state.coverPreview?.seriesId === series.id ? renderCoverPreview(state.coverPreview) : ""}
        ${state.releasePreview?.seriesId === series.id ? renderReleasePreview(state.releasePreview) : ""}
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
                <td>${escapeHtml(formatDate(volume.releaseDate))}${renderVolumeBadges(volume)}</td>
                <td>
                  <span class="status-pill" data-state="${volume.owned ? "owned" : "missing"}">${volume.owned ? "gekauft" : "offen"}</span>
                  <span class="status-pill" data-state="${volume.read ? "completed" : "reading"}">${volume.read ? "gelesen" : "ungelesen"}</span>
                </td>
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

  function renderReleaseCacheStatus() {
    const status = state.releaseCache;
    const details = [
      `Status: ${status.status}`,
      `generatedAt: ${formatDateTime(status.generatedAt)}`,
      `itemCount: ${status.itemCount ?? "unbekannt"}`,
    ];
    return `
      <section class="release-cache-status ${status.error ? "is-error" : ""}">
        <strong>Release-Cache</strong>
        <p>${escapeHtml(status.message || details.join(" · "))}</p>
        <div class="meta">
          ${details.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
        ${status.error ? `<p class="release-cache-error">${escapeHtml(status.error)}</p>` : ""}
      </section>
    `;
  }

  function renderReleasePreview(preview) {
    if (!preview.rows.length) {
      return '<section class="release-preview"><p class="muted">Keine uebernehmbaren Aenderungen in den geladenen Release-Daten.</p></section>';
    }
    const selectedCount = preview.rows.reduce((sum, row) => sum + row.changes.filter((change) => change.selected && row.confidence >= 70).length, 0);
    return `
      <section class="release-preview">
        <div class="release-preview-header">
          <div>
            <h3>Release-Vorschau</h3>
            ${preview.cacheMetadata ? `<p class="muted">Cache: generatedAt ${escapeHtml(formatDateTime(preview.cacheMetadata.generatedAt))} - itemCount ${escapeHtml(preview.cacheMetadata.itemCount)}</p>` : ""}
            <p class="muted">Quelle: ${escapeHtml(preview.sourceUrl || "manuelle Manga-Passion-JSON-Datei")} · ${escapeHtml(formatDateTime(preview.createdAt))}</p>
          </div>
          <div class="actions">
            <button type="button" class="button" data-action="apply-release-preview">Ausgewählte übernehmen</button>
            <button type="button" class="secondary-button" data-action="clear-release-preview">Vorschau schließen</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Band</th>
                <th>Confidence</th>
                <th>Alt</th>
                <th>Neu</th>
                <th>Auswahl</th>
              </tr>
            </thead>
            <tbody>
              ${preview.rows.map(renderReleasePreviewRow).join("")}
            </tbody>
          </table>
        </div>
        <p class="muted">${selectedCount} Aenderungen ausgewaehlt. Besitz, Lesestatus und manuelle Cover bleiben geschuetzt.</p>
      </section>
    `;
  }

  function renderCoverPreview(preview) {
    if (!preview.rows.length) {
      return '<section class="release-preview"><p class="muted">Keine uebernehmbaren Cover-Vorschlaege im Release-Cache.</p></section>';
    }
    const selectedCount = preview.rows.filter((row) => row.selected && row.confidence >= 70).length;
    return `
      <section class="release-preview">
        <div class="release-preview-header">
          <div>
            <h3>Cover-Vorschau</h3>
            <p class="muted">Quelle: ${escapeHtml(preview.sourceUrl)} - ${escapeHtml(formatDateTime(preview.createdAt))}</p>
            ${preview.cacheMetadata ? `<p class="muted">Cache: generatedAt ${escapeHtml(formatDateTime(preview.cacheMetadata.generatedAt))} - itemCount ${escapeHtml(preview.cacheMetadata.itemCount)}</p>` : ""}
          </div>
          <div class="actions">
            <button type="button" class="button" data-action="apply-cover-preview" data-id="${escapeHtml(preview.seriesId)}">Ausgewaehlte Cover uebernehmen</button>
            <button type="button" class="secondary-button" data-action="clear-cover-preview">Vorschau schliessen</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Band</th>
                <th>Quelle</th>
                <th>Confidence</th>
                <th>Alt</th>
                <th>Neu</th>
                <th>Auswahl</th>
              </tr>
            </thead>
            <tbody>
              ${preview.rows.map(renderCoverPreviewRow).join("")}
            </tbody>
          </table>
        </div>
        <p class="muted">${selectedCount} Cover ausgewaehlt. Manuell gesetzte Cover und Release-Daten bleiben unveraendert.</p>
      </section>
    `;
  }

  function renderCoverPreviewRow(row) {
    return `
      <tr>
        <td><strong>Band ${escapeHtml(row.volumeNumber)}</strong><br><span class="muted">${escapeHtml(editionTypeLabel(row.editionType))}</span></td>
        <td>${escapeHtml(row.source)}<br><span class="muted">${escapeHtml(row.sourceUrl || "./data/release-cache.json")}</span></td>
        <td><span class="badge">${escapeHtml(row.confidence)}%</span></td>
        <td>${renderPreviewValue("coverUrl", row.oldCoverUrl)}</td>
        <td>${renderPreviewValue("coverUrl", row.newCoverUrl)}</td>
        <td>
          <label class="check-row">
            <input type="checkbox" data-cover-change data-cover-row-id="${escapeHtml(row.id)}" ${row.selected ? "checked" : ""}>
            Cover
          </label>
        </td>
      </tr>
    `;
  }

  function renderReleasePreviewRow(row) {
    const localLabel = row.local
      ? `Band ${row.local.volumeNumber} (${editionTypeLabel(row.local.editionType)})`
      : `Neuer Band ${row.volumeNumber} (${editionTypeLabel(row.editionType)})`;
    const status = row.status === "conflict" ? "Konflikt" : row.status === "new" ? "Neu" : "Update";
    return row.changes.map((change, index) => `
      <tr class="${row.status === "conflict" ? "is-conflict" : ""}">
        ${index === 0 ? `<td rowspan="${row.changes.length}"><strong>${escapeHtml(localLabel)}</strong><br><span class="muted">${escapeHtml(status)}</span></td>` : ""}
        ${index === 0 ? `<td rowspan="${row.changes.length}"><span class="badge">${escapeHtml(row.confidence)}%</span></td>` : ""}
        <td>${renderPreviewValue(change.field, change.oldValue)}</td>
        <td>${renderPreviewValue(change.field, change.newValue)}</td>
        <td>
          <label class="check-row">
            <input type="checkbox" data-release-change data-row-id="${escapeHtml(row.id)}" data-change-id="${escapeHtml(change.id)}" ${change.selected && row.confidence >= 70 ? "checked" : ""} ${row.confidence < 70 ? "disabled" : ""}>
            ${escapeHtml(change.label)}
          </label>
        </td>
      </tr>
    `).join("");
  }

  function renderPreviewValue(field, value) {
    if (!value) return '<span class="muted">leer</span>';
    if (field === "releaseDate") return escapeHtml(formatDate(value));
    if (field === "coverUrl") return `<div class="preview-cover">${renderCover(value, "Cover-Vorschau")}<span>${escapeHtml(value)}</span></div>`;
    return escapeHtml(value);
  }

  function editionTypeLabel(value) {
    const labels = {
      standard: "Standard",
      deluxe: "Deluxe",
      collector: "Collector",
      limited: "Limited",
      boxset: "Boxset",
      other: "Andere",
    };
    return labels[value] || value;
  }

  function collectionGapStatusLabel(status) {
    const labels = {
      missing: "Fehlt in Sammlung",
      released_unowned: "Erschienen, nicht gekauft",
      upcoming: "Kommend",
      unknown: "Unbekannt",
    };
    return labels[status] || "Unbekannt";
  }

  function getUnknownCollectionRows(seriesId, editionType) {
    return getSequentialAnalysisVolumes(seriesId, editionType)
      .filter((volume) => !volume.owned && !volume.releaseDate)
      .map((volume) => ({
        id: `${volume.id}:unknown`,
        seriesId,
        editionType: normalizeEditionTypeForAnalysis(volume.editionType),
        volumeNumber: volume.volumeNumber,
        releaseDate: "",
        status: "unknown",
        source: "local",
        localVolume: volume,
      }));
  }

  function getCollectionGapRows() {
    return state.database.series.flatMap((series) => {
      const summary = getSeriesCollectionSummary(series.id);
      return summary.editions.flatMap((edition) => [
        ...edition.missing,
        ...edition.releasedUnowned,
        ...edition.upcoming,
        ...getUnknownCollectionRows(series.id, edition.editionType),
      ].map((row) => ({
        ...row,
        seriesTitle: series.title,
        publisher: series.publisher,
      })));
    }).sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, "de")
      || editionTypeValues.indexOf(a.editionType) - editionTypeValues.indexOf(b.editionType)
      || a.volumeNumber - b.volumeNumber
      || collectionGapStatusLabel(a.status).localeCompare(collectionGapStatusLabel(b.status), "de"));
  }

  function renderDerivedGapCard(row) {
    return `
      <article class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${escapeHtml(row.seriesTitle)} Band ${escapeHtml(row.volumeNumber)}</div>
            <div class="muted">${escapeHtml(editionTypeLabel(row.editionType))}</div>
          </div>
          ${renderCover("", row.seriesTitle)}
        </div>
        <div class="meta">
          <span>${escapeHtml(getPublisherLabel(row.publisher || "other"))}</span>
          <span>${escapeHtml(formatDate(row.releaseDate))}</span>
          <span>Confidence ${escapeHtml(row.confidence)}%</span>
          <span>${escapeHtml(row.source)}</span>
        </div>
        <div class="actions">
          <button type="button" class="button" data-action="create-gap-placeholder" data-id="${escapeHtml(row.id)}">Band anlegen</button>
        </div>
      </article>
    `;
  }

  function getCollectionSections() {
    const unread = state.database.volumes.filter((volume) => volume.owned && volume.read !== true).sort(volumeSort);
    const read = state.database.volumes.filter((volume) => volume.owned && volume.read === true).sort(volumeSort);
    return { unread, read };
  }

  function renderCollectionView() {
    const wrapper = document.createElement("section");
    const { unread, read } = getCollectionSections();
    wrapper.innerHTML = viewHeader("Sammlung", "Alle gekauften Einzelbände mit Lesestatus.");

    const unreadSection = document.createElement("section");
    unreadSection.className = "collection-section";
    unreadSection.innerHTML = "<h3>Ungelesen</h3>";
    if (!unread.length) {
      unreadSection.append(emptyState("Keine ungelesenen Bände", "Alle gekauften Bände sind als gelesen markiert."));
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.innerHTML = unread.map((volume) => renderVolumeCard(volume, "collection")).join("");
      unreadSection.append(grid);
    }
    wrapper.append(unreadSection);

    const readSection = document.createElement("section");
    readSection.className = "collection-section";
    readSection.innerHTML = "<h3>Gelesen</h3>";
    if (!read.length) {
      readSection.append(emptyState("Keine gelesenen Bände", "Gelesene Bände erscheinen hier, sobald du sie markierst."));
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.innerHTML = read.map((volume) => renderVolumeCard(volume, "collection")).join("");
      readSection.append(grid);
    }
    wrapper.append(readSection);
    return wrapper;
  }

  function getBuyGapEmptyMessage(derivedGapCandidates, gapDiagnostics) {
    if (state.buyGapCache.status === "idle" || state.buyGapCache.status === "loading") {
      return "Release-Cache leer/nicht geladen.";
    }
    if (state.buyGapCache.status === "ok" && !state.buyGapCache.items.length) {
      return "Release-Cache leer/nicht geladen.";
    }
    if (state.buyGapCache.status === "ok" && gapDiagnostics.missingGapCount === 0) {
      return "Keine anlegbaren Sammellücken aus Release-Cache.";
    }
    if (state.buyGapCache.status === "ok" && state.buyGapCache.items.length && !gapDiagnostics.hasMatchingCacheEntry) {
      return "Keine passenden Cache-Einträge zur Sammlung.";
    }
    if (state.buyGapCache.status === "ok" && gapDiagnostics.hasMatchingCacheEntry && !gapDiagnostics.hasEligibleCacheEntry) {
      return "Keine anlegbaren Sammellücken aus Release-Cache. Prüfe Release-Datum, Confidence und Edition.";
    }
    if (!derivedGapCandidates.length) {
      return "Keine anlegbaren Sammellücken aus Release-Cache.";
    }
    return "";
  }

  function renderBuyView() {
    const wrapper = document.createElement("section");
    const { localBuyCandidates, derivedGapCandidates, gapDiagnostics } = getBuyTabAnalysisRows();

    wrapper.innerHTML = viewHeader("Kaufen", "Erschienene Bände und heutige Releases, getrennt nach lokalen Einträgen und sicher ableitbaren Sammellücken.");

    const localSection = document.createElement("section");
    localSection.innerHTML = "<h3>Bereits erfasst</h3>";
    if (!localBuyCandidates.length) {
      localSection.append(emptyState("Keine lokalen kaufbaren Bände", "Es gibt keinen lokal erfassten Band mit owned=false und Release-Datum bis heute."));
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.innerHTML = localBuyCandidates.map((volume) => renderVolumeCard(volume, "buy")).join("");
      localSection.append(grid);
    }
    wrapper.append(localSection);

    const gapSection = document.createElement("section");
    gapSection.innerHTML = "<h3>Fehlende Bände anlegen</h3>";
    if (state.buyGapCache.status === "loading") {
      const info = document.createElement("p");
      info.className = "muted";
      info.textContent = "Release-Cache wird für Sammellücken geprüft...";
      gapSection.append(info);
    } else if (state.buyGapCache.status === "error") {
      const info = document.createElement("p");
      info.className = "muted";
      info.textContent = `Release-Cache konnte nicht geladen werden: ${state.buyGapCache.error}`;
      gapSection.append(info);
    } else if (!derivedGapCandidates.length) {
      gapSection.append(emptyState("Keine anlegbaren Sammellücken", getBuyGapEmptyMessage(derivedGapCandidates, gapDiagnostics)));
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.innerHTML = derivedGapCandidates.map(renderDerivedGapCard).join("");
      gapSection.append(grid);
    }
    wrapper.append(gapSection);

    if (state.buyGapCache.status === "idle") loadBuyGapCache();
    return wrapper;
  }

  function renderCalendarView() {
    const wrapper = document.createElement("section");
    const today = todayLocalDate();
    const upcoming = state.database.volumes
      .filter((volume) => volume.releaseDate && volume.releaseDate > today)
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

  function formatOptionalDateTime(value) {
    return value ? formatDateTime(value) : "nie";
  }

  function getSupabaseConnectionLabel() {
    if (!state.supabaseConfig.enabled || !state.supabaseConfig.url.trim() || !state.supabaseConfig.publicKey.trim()) {
      return "Nicht konfiguriert";
    }
    if (!state.supabaseUser) return "Konfiguriert, aber nicht angemeldet";
    return `Angemeldet als ${state.supabaseUser.email || state.supabaseUser.id}`;
  }

  function maskSecret(value) {
    const text = String(value || "").trim();
    if (!text) return "nicht gesetzt";
    if (text.length <= 12) return `${"*".repeat(Math.max(4, text.length))}`;
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
  }

  function getSupabaseKeyType(value = state.supabaseConfig.publicKey) {
    const key = String(value || "").trim();
    if (!key) return "nicht gesetzt";
    if (key.startsWith("sb_publishable_")) return "publishable";
    if (key.split(".").length === 3) return "legacy anon JWT";
    return "unbekannt";
  }

  function getLocalDatabaseSummary() {
    const db = state.database;
    return {
      bytes: byteSize(db),
      seriesCount: Array.isArray(db.series) ? db.series.length : 0,
      volumeCount: Array.isArray(db.volumes) ? db.volumes.length : 0,
      updatedAt: db.updatedAt,
      hasLocalChanges: Boolean(state.supabaseMeta.lastKnownLocalUpdatedAt && state.supabaseMeta.lastKnownLocalUpdatedAt !== db.updatedAt),
    };
  }

  function renderSupabaseDiagnostics(summary) {
    return `
      <details class="diagnostics">
        <summary>Diagnose anzeigen</summary>
        <div class="settings-list">
          <div><strong>Supabase URL gesetzt</strong><span>${state.supabaseConfig.url.trim() ? "ja" : "nein"}</span></div>
          <div><strong>Public Key gesetzt</strong><span>${state.supabaseConfig.publicKey.trim() ? "ja" : "nein"}</span></div>
          <div><strong>Public Key maskiert</strong><span>${escapeHtml(maskSecret(state.supabaseConfig.publicKey))}</span></div>
          <div><strong>Key-Typ</strong><span>${escapeHtml(getSupabaseKeyType())}</span></div>
          <div><strong>User angemeldet</strong><span>${state.supabaseUser ? "ja" : "nein"}</span></div>
          <div><strong>User E-Mail</strong><span>${escapeHtml(state.supabaseUser?.email || state.supabaseMeta.lastUserEmail || "nicht bekannt")}</span></div>
          <div><strong>Letzte Remote updated_at</strong><span>${escapeHtml(formatOptionalDateTime(state.supabaseMeta.lastRemoteUpdatedAt))}</span></div>
          <div><strong>Lokale updatedAt</strong><span>${escapeHtml(formatOptionalDateTime(summary.updatedAt))}</span></div>
          <div><strong>Lokale Datenbankgröße</strong><span>${escapeHtml(formatKb(summary.bytes))}</span></div>
          <div><strong>Serienanzahl</strong><span>${escapeHtml(summary.seriesCount)}</span></div>
          <div><strong>Bändeanzahl</strong><span>${escapeHtml(summary.volumeCount)}</span></div>
        </div>
      </details>
    `;
  }

  function renderSupabaseConflict() {
    const conflict = state.supabaseConflict;
    if (!conflict) return "";
    return `
      <section class="notice conflict-panel">
        <h4>Supabase-Konflikt</h4>
        <p>Es gibt unterschiedliche Datenstaende. Bitte waehle bewusst aus.</p>
        <div class="settings-list">
          <div><strong>Lokaler Stand</strong><span>${escapeHtml(formatOptionalDateTime(conflict.localUpdatedAt))}</span></div>
          <div><strong>Cloud-Stand</strong><span>${escapeHtml(formatOptionalDateTime(conflict.cloudRowUpdatedAt || conflict.cloudUpdatedAt))}</span></div>
        </div>
        <div class="actions">
          <button type="button" class="button" data-action="supabase-conflict-push">Lokale Daten behalten und Cloud ueberschreiben</button>
          <button type="button" class="secondary-button" data-action="supabase-conflict-pull">Cloud laden und lokales Backup behalten</button>
          <button type="button" class="secondary-button" data-action="supabase-conflict-cancel">Abbrechen</button>
        </div>
      </section>
    `;
  }

  function renderSettingsView() {
    const backups = Object.keys(localStorage).filter((key) => key.startsWith(BACKUP_PREFIX)).sort().reverse();
    const supabaseConflicts = getSupabaseConflicts();
    const releaseConflicts = getReleaseConflicts();
    const supabaseSummary = getLocalDatabaseSummary();
    const syncStatusLabel = state.savePending
      ? "Speichern läuft…"
      : state.saveError
        ? "Nicht gespeichert"
        : state.appMode === "cloud"
          ? "Gespeichert"
          : state.appMode;
    const wrapper = document.createElement("section");
    wrapper.innerHTML = `
      ${viewHeader("Einstellungen", "Supabase ist die führende Datenquelle. localStorage dient als Cache und Backup.")}

      <section class="settings-section">
        <h3>Datenbank-Übersicht</h3>
        <p>Aktueller lokaler Cache-Stand.</p>
        <div class="settings-list">
          <div><strong>Schema-Version</strong><span>${state.database.schemaVersion}</span></div>
          <div><strong>Letzte Aktualisierung</strong><span>${escapeHtml(state.database.updatedAt)}</span></div>
          <div><strong>Serien</strong><span>${state.database.series.length}</span></div>
          <div><strong>Einzelbände</strong><span>${state.database.volumes.length}</span></div>
          <div><strong>Backups (localStorage)</strong><span>${backups.length}</span></div>
          <div><strong>Lokale Datenbankgröße</strong><span>${escapeHtml(formatKb(supabaseSummary.bytes))}</span></div>
        </div>
      </section>

      <section class="settings-section">
        <h3>Release-Daten & Cover</h3>
        <p>Phase 4b PoC nutzt nur manuelle Manga-Passion-JSON-Dateien pro Serie. Es gibt keine Webabfrage, keinen Proxy und kein Massenupdate.</p>
        <div class="settings-list">
          <div><strong>Release-Konflikte</strong><span>${releaseConflicts.length}</span></div>
        </div>
        <div class="actions">
          <button type="button" class="secondary-button" data-action="clear-release-conflicts">Konflikte löschen</button>
        </div>
      </section>

      <form class="settings-section" data-form="supabase-sync">
        <h3>Supabase Cloud-Sync</h3>
        <p>Trage Supabase URL und Public/Anon Key ein. Auto-Save speichert Änderungen 3 Sekunden nach der letzten Eingabe.</p>

        <div class="security-warning">
          <strong>Sicherheitshinweis:</strong>
          <span>Niemals einen <code>service_role</code> Key im Browser oder in <code>localStorage</code> speichern. Nur der Public/Anon Key gehört hierhin — RLS schützt den Rest.</span>
        </div>

        ${state.supabaseMessage ? `<div class="notice">${escapeHtml(state.supabaseMessage)}</div>` : ""}
        ${renderSupabaseConflict()}

        <h4>Verbindung & Status</h4>
        <div class="settings-list">
          <div><strong>Verbindung</strong><span>${escapeHtml(getSupabaseConnectionLabel())}</span></div>
          <div><strong>Letzter Status</strong><span>${escapeHtml(state.supabaseMeta.lastStatus || state.supabaseConfig.lastSyncStatus || state.supabaseStatus)}</span></div>
          <div><strong>App-Modus</strong><span>${escapeHtml(state.appMode)}</span></div>
          <div><strong>Cloud-Sync-Status</strong><span>${escapeHtml(syncStatusLabel)}</span></div>
          <div><strong>Angemeldet als</strong><span>${escapeHtml(state.supabaseUser ? (state.supabaseUser.email || state.supabaseUser.id) : "nicht angemeldet")}</span></div>
          <div><strong>User-ID</strong><span>${escapeHtml(state.supabaseUser?.id || "—")}</span></div>
          <div><strong>Lokale Änderungen offen</strong><span>${supabaseSummary.hasLocalChanges ? "ja" : "nein"}</span></div>
          <div><strong>Supabase-Konflikte</strong><span>${supabaseConflicts.length}</span></div>
        </div>

        <h4>Sync-Verlauf</h4>
        <div class="settings-list">
          <div><strong>Letzter Push</strong><span>${escapeHtml(formatOptionalDateTime(state.supabaseMeta.lastPushAt))}</span></div>
          <div><strong>Letzter Pull</strong><span>${escapeHtml(formatOptionalDateTime(state.supabaseMeta.lastPullAt))}</span></div>
          <div><strong>Letzter Sync</strong><span>${escapeHtml(formatOptionalDateTime(state.supabaseMeta.lastSyncAt || state.supabaseConfig.lastSyncAt))}</span></div>
          <div><strong>Letzter Cloud-Stand</strong><span>${escapeHtml(formatOptionalDateTime(state.supabaseMeta.lastRemoteUpdatedAt))}</span></div>
          <div><strong>Letzter Fehler</strong><span>${escapeHtml(state.supabaseMeta.lastError || "keiner")}</span></div>
        </div>

        ${state.saveError ? `<div class="actions"><button type="button" class="button" data-action="supabase-retry-save">Erneut speichern</button></div>` : ""}

        <h4>Konfiguration</h4>
        <div class="form-grid">
          ${checkboxField("supabaseEnabled", "Supabase Cloud-Sync aktivieren", state.supabaseConfig.enabled)}
          ${textField("supabaseUrl", "Supabase Project URL", state.supabaseConfig.url)}
          ${textField("supabasePublicKey", "Supabase Public/Anon Key", state.supabaseConfig.publicKey, false, "password")}
          ${textField("supabaseLoginEmail", "Login E-Mail", state.supabaseConfig.loginEmail, false, "email")}
        </div>
        <div class="actions">
          <button type="submit" class="button">Einstellungen speichern</button>
          <button type="button" class="secondary-button" data-action="supabase-login">Login-Link senden</button>
          <button type="button" class="secondary-button" data-action="supabase-logout">Logout</button>
          <button type="button" class="secondary-button" data-action="supabase-push">Jetzt speichern</button>
          <button type="button" class="secondary-button" data-action="supabase-pull">Cloud-Daten neu laden</button>
          <button type="button" class="secondary-button" data-action="supabase-sync-test">Cloud-Status prüfen</button>
        </div>
        ${renderSupabaseDiagnostics(supabaseSummary)}
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
        ? `<button type="button" class="secondary-button" data-action="mark-unread" data-id="${escapeHtml(volume.id)}">Als ungelesen markieren</button>`
        : `<button type="button" class="button" data-action="mark-read" data-id="${escapeHtml(volume.id)}">Als gelesen markieren</button>`);
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
          <span class="status-pill" data-state="${volume.owned ? "owned" : "missing"}">${volume.owned ? `gekauft${volume.boughtAt ? ` · ${formatDate(volume.boughtAt)}` : ""}` : "nicht gekauft"}</span>
          <span class="status-pill" data-state="${volume.read ? "completed" : "reading"}">${volume.read ? "gelesen" : "ungelesen"}</span>
        </div>
        ${renderVolumeBadges(volume)}
        <div class="actions">${actions.join("")}</div>
      </article>
    `;
  }

  function getVolumeBadges(volume) {
    const conflicts = getReleaseConflicts().filter((conflict) => conflict.volumeId === volume.id);
    const badges = [];
    const today = todayLocalDate();
    if (volume.coverCheckedAt && volume.coverSource && volume.coverConfidence > 0) badges.push({ label: "Neues Cover", variant: "info" });
    if (volume.releaseSource && volume.releaseConfidence > 0) badges.push({ label: "Release geaendert", variant: "info" });
    if (conflicts.length) badges.push({ label: "Release verschoben", variant: "warning" });
    if (!volume.owned && volume.releaseDate && volume.releaseDate > today && volume.shopUrl) badges.push({ label: "Vorbestellbar", variant: "info" });
    if (!volume.owned && volume.releaseDate && volume.releaseDate <= today) badges.push({ label: "Jetzt kaufbar", variant: "warning" });
    return badges;
  }

  function renderVolumeBadges(volume) {
    const badges = getVolumeBadges(volume);
    if (!badges.length) return "";
    return `<div class="badge-row">${badges.map((badge) => {
      const item = typeof badge === "string" ? { label: badge, variant: "info" } : badge;
      return `<span class="badge badge-${escapeHtml(item.variant)}">${escapeHtml(item.label)}</span>`;
    }).join("")}</div>`;
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
        ${textField("isbn13", "ISBN-13", volume.isbn13)}
        ${selectField("publisher", "Verlag", publisherValues, volume.publisher, getPublisherLabel)}
        ${textField("releaseDate", "Release-Datum", volume.releaseDate, false, "date")}
        ${textField("releaseSource", "Release-Quelle", volume.releaseSource)}
        ${textField("releaseConfidence", "Release-Vertrauen", volume.releaseConfidence, false, "number", "1", "numeric")}
        ${textField("coverUrl", "Cover-URL", volume.coverUrl)}
        ${textField("coverSource", "Cover-Quelle", volume.coverSource)}
        ${textField("coverConfidence", "Cover-Vertrauen", volume.coverConfidence, false, "number", "1", "numeric")}
        ${textField("coverCheckedAt", "Cover geprueft am", volume.coverCheckedAt, false, "date")}
        ${textField("coverHash", "Cover-Hash", volume.coverHash)}
        ${textField("editionFingerprint", "Edition-Fingerprint", volume.editionFingerprint)}
        ${textField("price", "Preis", volume.price ?? "", false, "text", "", "decimal")}
        ${textField("shopUrl", "Shop-URL", volume.shopUrl)}
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
      isbn13: fieldValue(form, "isbn13"),
      publisher: fieldValue(form, "publisher"),
      releaseDate: fieldValue(form, "releaseDate"),
      releaseSource: fieldValue(form, "releaseSource"),
      releaseConfidence: fieldValue(form, "releaseConfidence"),
      coverUrl: fieldValue(form, "coverUrl"),
      coverSource: fieldValue(form, "coverSource"),
      coverConfidence: fieldValue(form, "coverConfidence"),
      coverCheckedAt: fieldValue(form, "coverCheckedAt"),
      coverHash: fieldValue(form, "coverHash"),
      coverManuallySet: checkedValue(form, "coverManuallySet"),
      owned,
      boughtAt: fieldValue(form, "boughtAt") || (owned && !current?.boughtAt ? TODAY : null),
      read,
      readAt: fieldValue(form, "readAt") || (read && !current?.readAt ? TODAY : null),
      price: fieldValue(form, "price") || null,
      shopUrl: fieldValue(form, "shopUrl"),
      editionType: current?.editionType || "standard",
      editionFingerprint: fieldValue(form, "editionFingerprint"),
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

  function createPlaceholderFromGap(rowId) {
    const { derivedGapCandidates } = getBuyTabAnalysisRows();
    const row = derivedGapCandidates.find((candidate) => candidate.id === rowId);
    if (!row) {
      setNotice("Sammelluecken-Vorschlag ist nicht mehr verfuegbar.");
      return;
    }
    if (hasLocalVolumeForGap(row.seriesId, row.editionType, row.volumeNumber)) {
      setNotice("Dieser Band existiert bereits lokal.");
      return;
    }

    const series = seriesById(row.seriesId);
    if (!series) {
      setNotice("Serie fuer Sammelluecke nicht gefunden.");
      return;
    }

    const backupKey = backupDatabaseSnapshot(state.database, "derived-gap-analysis");
    const existingIds = new Set(state.database.volumes.map((volume) => volume.id));
    const baseId = `${row.seriesId}-${String(row.volumeNumber).padStart(3, "0")}`;
    const id = uniqueId(baseId, existingIds);
    const placeholder = normalizeVolume({
      id,
      seriesId: row.seriesId,
      volumeNumber: row.volumeNumber,
      title: series.title,
      subtitle: "",
      isbn13: row.isbn13 || "",
      publisher: row.publisher || series.publisher,
      releaseDate: row.releaseDate,
      releaseSource: "derived-gap-analysis",
      releaseConfidence: row.confidence,
      coverUrl: "",
      coverSource: "",
      coverConfidence: 0,
      coverCheckedAt: "",
      coverManuallySet: false,
      owned: false,
      boughtAt: null,
      read: false,
      readAt: null,
      editionType: row.editionType,
      shopUrl: row.sourceUrl || "",
      notes: "Aus Sammelluecken-Analyse angelegt",
      createdAt: TODAY,
      updatedAt: nowIso(),
    }, series);

    state.database.volumes.push(placeholder);
    logReleaseConflict({
      volumeId: placeholder.id,
      seriesId: placeholder.seriesId,
      type: "derived_placeholder_created",
      oldValue: "",
      newValue: `Band ${placeholder.volumeNumber} (${editionTypeLabel(placeholder.editionType)})`,
      source: "derived-gap-analysis",
    });
    saveDatabase();
    setNotice(`Band ${placeholder.volumeNumber} angelegt. Backup: ${backupKey}.`);
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
      const prepared = prepareImportedDatabase(parsed);
      const validation = validateDatabase(prepared);
      if (!validation.valid) {
        setNotice(`Import abgebrochen. Backup erhalten: ${backupKey}. Fehler: ${validation.errors.join(" ")}`);
        return;
      }
      state.database = normalizeDatabase(prepared);
      saveLocalDatabase();
      updateStorageStatus();
      if (state.appMode === "cloud") {
        setNotice(`Import lokal geladen. Backup: ${backupKey}. Speichere nach Supabase…`);
        render();
        const result = await supabasePush({ force: true });
        if (result.ok) {
          state.savePending = false;
          state.saveError = false;
          setNotice(`Import erfolgreich und nach Supabase gespeichert. Backup: ${backupKey}.`);
        } else {
          state.saveError = true;
          setNotice(`Import lokal gespeichert, aber Supabase-Upload fehlgeschlagen. Backup: ${backupKey}. Bitte erneut speichern.`);
        }
      } else {
        setNotice(`Import erfolgreich (lokal). Backup: ${backupKey}. Bitte anmelden um nach Supabase zu speichern.`);
      }
      render();
    } catch (error) {
      setNotice(`Import fehlgeschlagen. Backup erhalten: ${backupKey}.`);
      console.error(error);
    }
  }

  async function importMangaPassionPreviewJson(file, seriesId) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      state.coverPreview = null;
      state.releasePreview = previewReleaseUpdateForSeries(seriesId, parsed);
      const count = state.releasePreview.rows.reduce((sum, row) => sum + row.changes.length, 0);
      setNotice(count ? "Release-Vorschau erstellt. Bitte pruefe die Auswahl." : "Keine uebernehmbaren Release-Aenderungen gefunden.");
    } catch (error) {
      state.releasePreview = null;
      setNotice("Manga-Passion-JSON konnte nicht gelesen werden.");
      console.error(error);
    }
  }

  async function loadReleaseCachePreview(seriesId) {
    const series = seriesById(seriesId);
    if (!series) return;

    state.releasePreview = null;
    state.coverPreview = null;
    state.releaseCache = {
      seriesId,
      status: "loading",
      message: "Release-Cache wird geladen...",
      generatedAt: null,
      itemCount: null,
      error: "",
    };
    render();

    try {
      const cacheData = await readReleaseCacheFile();
      const filteredCache = filterReleaseCacheForSeries(cacheData, series);
      state.releaseCache = {
        seriesId,
        status: "ok",
        message: `${filteredCache.items.length} passende Cache-Eintraege gefunden.`,
        generatedAt: filteredCache.generatedAt,
        itemCount: filteredCache.itemCount,
        error: "",
      };

      state.releasePreview = previewReleaseUpdateForSeries(seriesId, filteredCache);
      state.releasePreview.cacheMetadata = {
        generatedAt: filteredCache.generatedAt,
        itemCount: filteredCache.itemCount,
      };
      const count = state.releasePreview.rows.reduce((sum, row) => sum + row.changes.length, 0);
      setNotice(count ? "Release-Vorschau aus Cache erstellt. Bitte pruefe die Auswahl." : "Keine uebernehmbaren Release-Aenderungen im Cache gefunden.");
    } catch (error) {
      state.releasePreview = null;
      state.releaseCache = {
        seriesId,
        status: "error",
        message: "Release-Cache konnte nicht verwendet werden.",
        generatedAt: null,
        itemCount: null,
        error: error.message,
      };
      setNotice("Release-Cache konnte nicht geladen werden.");
      console.error(error);
    }
  }

  function updateReleasePreviewSelection(input) {
    if (!state.releasePreview) return;
    const rowId = input.dataset.rowId;
    const changeId = input.dataset.changeId;
    state.releasePreview.rows = state.releasePreview.rows.map((row) => {
      if (row.id !== rowId) return row;
      return {
        ...row,
        changes: row.changes.map((change) => change.id === changeId ? { ...change, selected: input.checked } : change),
      };
    });
  }

  function applySelectedReleasePreview() {
    const preview = state.releasePreview;
    if (!preview) return;
    const selectedRows = preview.rows
      .map((row) => ({ ...row, changes: row.changes.filter((change) => change.selected) }))
      .filter((row) => row.changes.length > 0 && row.confidence >= 70);

    if (!selectedRows.length) {
      setNotice("Keine ausgewaehlten Aenderungen mit ausreichender Confidence.");
      return;
    }

    const backupKey = backupDatabaseSnapshot(state.database, "manga-passion-release-preview");
    const existingIds = new Set(state.database.volumes.map((volume) => volume.id));
    let applied = 0;

    selectedRows.forEach((row) => {
      const createSelected = row.changes.some((change) => change.field === "createVolume");
      if (!row.local && createSelected) {
        const newVolume = createVolumeFromReleasePreview(row, existingIds);
        state.database.volumes.push(newVolume);
        existingIds.add(newVolume.id);
        applied += 1;
        return;
      }

      if (!row.local) return;
      state.database.volumes = state.database.volumes.map((volume) => {
        if (volume.id !== row.local.id) return volume;
        const next = { ...volume };
        row.changes.forEach((change) => {
          if (change.field === "releaseDate") {
            if (next.releaseDate && next.releaseDate !== change.newValue) {
              logReleaseConflict({
                volumeId: next.id,
                seriesId: next.seriesId,
                type: "release_date_changed",
                oldValue: next.releaseDate,
                newValue: change.newValue,
                source: "manga-passion-json",
              });
            }
            next.releaseDate = change.newValue;
            next.releaseSource = "manga-passion-json";
            next.releaseConfidence = change.confidence;
          }
          if (change.field === "isbn13" && !next.isbn13) {
            next.isbn13 = change.newValue;
          }
          if (change.field === "coverUrl" && canUpdateCover(next, { coverUrl: change.newValue, coverConfidence: change.confidence })) {
            if (next.coverUrl && next.coverUrl !== change.newValue) {
              logReleaseConflict({
                volumeId: next.id,
                seriesId: next.seriesId,
                type: "cover_changed",
                oldValue: next.coverUrl,
                newValue: change.newValue,
                source: "manga-passion-json",
              });
            }
            next.coverUrl = change.newValue;
            next.coverSource = "manga-passion-json";
            next.coverConfidence = change.confidence;
            next.coverCheckedAt = TODAY;
          }
        });
        applied += 1;
        return normalizeVolume({ ...next, updatedAt: nowIso() }, seriesById(next.seriesId));
      });
    });

    const series = seriesById(preview.seriesId);
    if (series) {
      series.dates.lastReleaseCheck = TODAY;
    }
    state.releasePreview = null;
    saveDatabase();
    setNotice(`${applied} Band-Eintraege aktualisiert. Backup: ${backupKey}.`);
  }

  function createVolumeFromReleasePreview(row, existingIds) {
    const series = seriesById(state.releasePreview.seriesId);
    const incoming = row.incoming;
    const baseId = `${series.id}-${String(incoming.volumeNumber).padStart(3, "0")}`;
    const id = uniqueId(baseId, existingIds);
    const selected = new Map(row.changes.map((change) => [change.field, change]));
    return normalizeVolume({
      id,
      seriesId: series.id,
      volumeNumber: incoming.volumeNumber,
      title: series.title,
      subtitle: incoming.subtitle,
      isbn13: selected.get("isbn13")?.newValue || "",
      publisher: incoming.publisher || series.publisher,
      releaseDate: selected.get("releaseDate")?.newValue || "",
      releaseSource: selected.has("releaseDate") ? "manga-passion-json" : "",
      releaseConfidence: selected.get("releaseDate")?.confidence || 0,
      coverUrl: selected.get("coverUrl")?.newValue || "",
      coverSource: selected.has("coverUrl") ? "manga-passion-json" : "",
      coverConfidence: selected.get("coverUrl")?.confidence || 0,
      coverCheckedAt: selected.has("coverUrl") ? TODAY : "",
      coverManuallySet: false,
      owned: false,
      boughtAt: null,
      read: false,
      readAt: null,
      editionType: incoming.editionType,
      shopUrl: incoming.sourceUrl,
      createdAt: TODAY,
      updatedAt: nowIso(),
    }, series);
  }

  function handleSupabaseSubmit(form) {
    state.supabaseConfig.pendingPush = state.supabaseConfig.pendingPush || false;
    saveSupabaseFormValues(form);

    if (!state.supabaseConfig.enabled) {
      setSupabaseStatus("disabled", "Supabase Cloud-Sync ist deaktiviert.");
      setNotice("Supabase-Einstellungen gespeichert.");
      return;
    }

    if (!isSupabaseConfigured()) {
      setSupabaseStatus("missing-config", "Supabase Cloud-Sync ist aktiviert, aber URL oder Public Key fehlt.");
      setNotice("Supabase-Einstellungen gespeichert. Es fehlen noch Konfigurationsdaten.");
      return;
    }

    setNotice("Supabase-Einstellungen gespeichert.");
    initSupabase();
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
      ...volumes.map((volume) => [
        `- Band ${volume.volumeNumber}: ${volume.title}${volume.subtitle ? ` - ${volume.subtitle}` : ""}`,
        `Release: ${volume.releaseDate || ""}`,
        `ISBN-13: ${volume.isbn13 || ""}`,
        `edition_type: ${volume.editionType || "standard"}`,
        volume.releaseSource ? `release_source: ${volume.releaseSource}` : "",
        volume.coverSource ? `cover_source: ${volume.coverSource}` : "",
        `Gekauft: ${volume.owned ? "ja" : "nein"}`,
        `Gelesen: ${volume.read ? "ja" : "nein"}`,
      ].filter(Boolean).join(" | ")),
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
    state.releasePreview = null;
    state.coverPreview = null;
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
    if (action === "create-gap-placeholder") createPlaceholderFromGap(id);
    if (action === "mark-read") markVolume(id, { read: true, readAt: TODAY });
    if (action === "mark-unread") markVolume(id, { read: false, readAt: null });
    if (action === "export-json") exportJson();
    if (action === "export-obsidian") exportObsidianZip();
    if (action === "clear-release-conflicts") {
      clearReleaseConflicts();
      setNotice("Release-Konflikte geloescht.");
    }
    if (action === "load-release-cache") loadReleaseCachePreview(id);
    if (action === "apply-release-preview") applySelectedReleasePreview();
    if (action === "clear-release-preview") {
      state.releasePreview = null;
      setNotice("Release-Vorschau geschlossen.");
    }
    if (action === "preview-cover-cache") previewCoverUpdateForSeries(id);
    if (action === "apply-cover-preview") applySelectedCoverPreview(id);
    if (action === "clear-cover-preview") {
      state.coverPreview = null;
      setNotice("Cover-Vorschau geschlossen.");
    }
    if (action === "supabase-login") {
      const form = button.closest("form");
      saveSupabaseFormValues(form);
      supabaseSignIn(state.supabaseConfig.loginEmail);
    }
    if (action === "supabase-logout") {
      saveSupabaseFormValues(button.closest("form"));
      supabaseSignOut();
    }
    if (action === "supabase-push") {
      saveSupabaseFormValues(button.closest("form"));
      supabasePush();
    }
    if (action === "supabase-retry-save") {
      state.saveError = false;
      state.savePending = true;
      updateStorageStatus();
      scheduleDebouncedSupabaseSave();
      render();
    }
    if (action === "supabase-pull") {
      saveSupabaseFormValues(button.closest("form"));
      supabasePull();
    }
    if (action === "supabase-sync-test") {
      saveSupabaseFormValues(button.closest("form"));
      supabaseSync();
    }
    if (action === "supabase-conflict-push") {
      supabasePush({ force: true });
    }
    if (action === "supabase-conflict-pull") {
      supabasePull({ force: true });
    }
    if (action === "supabase-conflict-cancel") {
      clearSupabaseConflict();
      setSupabaseStatus("conflict-cancelled", "Konflikt abgebrochen. Es wurden keine Daten veraendert.");
      render();
    }
    if (action === "first-time-migrate") {
      state.showFirstTimeDialog = false;
      const backupKey = backupDatabaseSnapshot(state.database, "before-first-cloud-upload");
      supabasePush({ force: true }).then((result) => {
        if (result.ok) {
          state.appMode = "cloud";
          setNotice(`Lokale Daten erfolgreich nach Supabase übernommen. Backup: ${backupKey}.`);
        } else {
          state.appMode = "readonly";
          setNotice(`Upload nach Supabase fehlgeschlagen. Backup: ${backupKey}. Bitte erneut versuchen.`);
        }
        render();
      });
      render();
    }
    if (action === "first-time-readonly") {
      state.showFirstTimeDialog = false;
      state.appMode = "readonly";
      setNotice("Ansichtsmodus — keine Daten wurden hochgeladen. Zum Exportieren: Import/Export-Tab.");
      render();
    }
    if (action === "first-time-cancel") {
      state.showFirstTimeDialog = false;
      state.appMode = "readonly";
      setNotice("Abgebrochen. Bitte ab- und wieder anmelden um die Entscheidung erneut zu treffen.");
      render();
    }
    if (action === "go-settings") {
      state.activeTab = "settings";
      render();
    }
  });

  app.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.form === "series") handleSeriesSubmit(form);
    if (form.dataset.form === "volume") handleVolumeSubmit(form);
    if (form.dataset.form === "supabase-sync") handleSupabaseSubmit(form);
  });

  app.addEventListener("change", (event) => {
    if (event.target.id === "jsonImport" && event.target.files[0]) {
      importJson(event.target.files[0]);
    }
    if (event.target.matches("[data-release-import]") && event.target.files[0]) {
      importMangaPassionPreviewJson(event.target.files[0], event.target.dataset.releaseImport);
      event.target.value = "";
    }
    if (event.target.matches("[data-release-change]")) {
      updateReleasePreviewSelection(event.target);
      render();
    }
    if (event.target.matches("[data-cover-change]")) {
      updateCoverPreviewSelection(event.target);
      render();
    }
  });

  window.mangaTrackerPhase5 = {
    previewCoverUpdateForSeries,
    applySelectedCoverPreview,
    matchCoverCandidates,
    validateCoverCandidate,
    createCoverPreview,
    getState: () => state,
  };

  window.mangaTrackerPhase6 = {
    todayLocalDate,
    getEditionGroups,
    getKnownVolumeRange,
    getMissingVolumes,
    getReleasedUnowned,
    getUpcomingVolumes,
    getSeriesCollectionSummary,
    getCollectionGapRows,
    getBuyTabAnalysisRows,
    getBuyGapEmptyMessage,
    createPlaceholderFromGap,
    loadBuyGapCache,
    getState: () => state,
  };

  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unbehandelte Promise-Ablehnung:", event.reason);
  });

  render();
  initSupabase();
})();

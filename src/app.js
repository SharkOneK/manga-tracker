// ─── Palette & Utilities (defined in src/utils.js) ────────────────────────
const PALETTE = window.MangaTrackerUtils.PALETTE;
function colorFor(str) { return window.MangaTrackerUtils.colorFor(str); }

// ─── Storage ──────────────────────────────────────────────────────────────
let db = (() => {
  try { return JSON.parse(localStorage.getItem('mtDE') || '{"m":[]}'); }
  catch { return { m: [] }; }
})();
function uid() { return window.MangaTrackerUtils.uid(); }

// ─── Supabase Cloud Sync (adapter defined in src/supabase.js) ────────────
const SupabaseAdapter = window.MangaTrackerSupabase;

SupabaseAdapter.adoptOwnerIfPresent();

const _ownerState = SupabaseAdapter.getOwnerState();
let _collId     = _ownerState.collId;
let _ownerToken = _ownerState.ownerToken;

function supaHead(write = false) {
  return SupabaseAdapter.headers(_ownerToken, write);
}

let _syncTimer = null;
// Seeding-Flag: während Boot-Seeds keine localStorage-Schreiboperationen ausführen
let _seeding = false;
// Seed-Termine: von upsertManga() befüllt, dienen nur noch als Fallback für leere Felder
// → die geplante Aufgabe aktualisiert nur den HTML-Seed, kein JSONBin-Zugriff nötig
// Phase 15g: SEED_DATES bleiben Fallback; release-cache.json hat erst nach
//   Nutzerbestätigung (applySelectedReleaseUpdates) Priorität für nextDate.
const SEED_DATES = {};
// Seed-Genres: werden nach Cloud-Load auf Einträge ohne Genres angewandt,
// damit neue HTML-Genres auch in der bereits in der Cloud existierenden Sammlung greifen
const SEED_GENRES = {};
let seedDirty = false;

function isEmptySeedField(value) {
  return value === null || value === undefined || value === '';
}

function setIfEmpty(target, field, value) {
  if (value === undefined || value === null) return false;
  if (!isEmptySeedField(target[field])) return false;
  target[field] = value;
  return true;
}

function setNextDateIfEmpty(target, value) {
  if (value === null || value === undefined || value === '') return false;
  if (!isEmptySeedField(target.nextDate)) return false;
  target.nextDate = value;
  return true;
}

function setSyncStatus(icon, tip) {
  const el = document.getElementById('sync-dot');
  if (el) { el.textContent = icon; el.title = tip; }
}

function saveLoc() { localStorage.setItem('mtDE', JSON.stringify(db)); }

function persist() {
  if (_seeding) return; // Seeds werden gebündelt am Ende geschrieben
  if (!canEditLocal()) return; // Öffentliche Ansicht: niemals lokal schreiben
  saveLoc();
  if (!canWriteCloud()) {
    // Lokaler Modus ohne Cloud-Sync: nur lokal speichern
    return;
  }
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(pushCloud, 1500);
}

// Returns null if entry is valid, or a description string if not.
function entryError(m) {
  if (m === null || typeof m !== 'object') return 'kein Objekt';
  if (typeof m.id !== 'string' || !m.id) return 'id fehlt oder leer';
  if (typeof m.title !== 'string' || !m.title.trim()) return 'title fehlt oder leer';
  return null;
}

function validateDatabase(candidate) {
  const target = (candidate !== undefined) ? candidate : db;
  if (!target || !Array.isArray(target.m)) return false;
  for (let i = 0; i < target.m.length; i++) {
    const err = entryError(target.m[i]);
    if (err) {
      console.error(`validateDatabase: Eintrag ${i} ungültig – ${err}`, target.m[i]);
      return false;
    }
  }
  return true;
}

async function pushCloud() {
  if (!canWriteCloud()) return;
  // Phase 51: _ownerToken may be absent on a signed-in fresh browser; canWriteCloud()
  // already guarantees either a token or a valid session. patchCollection picks the path.
  if (!_collId) return;
  if (!validateDatabase()) { setSyncStatus('⚠️', 'Daten ungültig – Sync übersprungen'); return; }
  setSyncStatus('🔄', 'Synchronisiert…');
  try {
    await SupabaseAdapter.patchCollection(_collId, _ownerToken, db, buildPublicCollectionData(db));
    setSyncStatus('☁️', 'Cloud-Sync aktiv');
  } catch(e) {
    setSyncStatus('⚠️', 'Sync fehlgeschlagen');
  }
}

async function loadFromCloud() {
  if (!_collId) { setSyncStatus('💾', 'Lokal – keine Sammlung verbunden'); return; }
  setSyncStatus('🔄', 'Lade aus Cloud…');
  try {
    const record = await SupabaseAdapter.fetchCollection(_collId, _ownerToken);
    if (record && Array.isArray(record.m) && record.m.length > 0) {
      // Validierung VOR Übernahme: kaputte Cloud-Daten dürfen lokale Sammlung nicht überschreiben
      if (!validateDatabase(record)) {
        setSyncStatus('⚠️', 'Cloud-Daten ungültig – lokale Sammlung behalten');
        toast('⚠️ Cloud-Sync abgebrochen: ungültige Einträge gefunden (Details in der Browser-Konsole)');
        console.error('loadFromCloud: Cloud-Record abgelehnt, lokale Daten bleiben erhalten');
        return;
      }
      // Smart Re-Render: nur wenn sich die Cloud-Daten von den lokalen unterscheiden
      const before = JSON.stringify(db);
      db = record;
      let genresAdded = false;
      // Seed-Termine nur als Fallback anwenden: Cloud-/Nutzerdaten behalten Vorrang
      db.m.forEach(m => {
        const titleLc = m.title.toLowerCase();
        const dateKey = Object.keys(SEED_DATES).find(k => titleLc.includes(k));
        if (dateKey) {
          const s = SEED_DATES[dateKey];
          setNextDateIfEmpty(m, s.nextDate);
          setIfEmpty(m, 'total', s.total);
          setIfEmpty(m, 'ongoing', s.ongoing);
        }
        // Seed-Genres anwenden, wenn der Cloud-Eintrag noch keine hat
        if (!m.genres || !m.genres.length) {
          const genreKey = Object.keys(SEED_GENRES).find(k => titleLc.includes(k));
          if (genreKey) {
            m.genres = [...SEED_GENRES[genreKey]];
            genresAdded = true;
          }
        }
        // Bands-Migration falls Cloud-Daten noch im alten Format
        if (!m.bands) {
          m.bands = {};
          const n = Number(m.owned)||0, cur = Number(m.current)||0, st = m.status||'owned';
          for (let i = 1; i <= n; i++) {
            if (st === 'completed')        m.bands[i] = 'completed';
            else if (st === 'reading') {
              if (cur > 0 && i < cur)        m.bands[i] = 'completed';
              else if (cur > 0 && i === cur) m.bands[i] = 'reading';
              else                           m.bands[i] = 'owned';
            } else { m.bands[i] = 'owned'; }
          }
        }
      });
      const after = JSON.stringify(db);
      if (before !== after) {
        saveLoc();
        render();
      }
      // Wenn HTML-Seeds Genres ergänzt haben, sofort zurück in die Cloud schreiben,
      // damit alle Geräte (iPhone, Desktop) ohne weiteres Eingreifen die Tags sehen
      if (genresAdded) { setSyncStatus('🔄', 'Genre-Seeds sichern…'); await pushCloud(); }
    }
    setSyncStatus('☁️', 'Cloud-Sync aktiv');
  } catch(e) {
    setSyncStatus('⚠️', 'Offline – lokale Daten');
  }
}


// ─── Migration: owned/current/status → bands ──────────────────────────────
// Boot-Phase: ein einziger persist() am Ende statt ~58 (Migration + Seeds)
const bootDataBefore = JSON.stringify(db);
_seeding = true;
(function migrateBands() {
  if (!Array.isArray(db.m)) return;

  // Migration: wishlist:true → status:'wishlist'
  db.m.forEach(m => {
    if (m === null || typeof m !== 'object') { console.warn('migrateBands: null/ungültiger Eintrag übersprungen', m); return; }
    if (m.wishlist === true && m.status !== 'wishlist') m.status = 'wishlist';
    delete m.wishlist;
  });

  // Migration: ongoing Boolean → String (externe oder alte Daten)
  db.m.forEach(m => {
    if (m === null || typeof m !== 'object') return;
    if (m.ongoing === true)  m.ongoing = 'true';
    if (m.ongoing === false) m.ongoing = 'false';
  });

  // Migration: owned/current/status → bands
  db.m.forEach(m => {
    if (m === null || typeof m !== 'object') return;
    if (m.bands) return;
    m.bands = {};
    const n   = Number(m.owned)   || 0;
    const cur = Number(m.current) || 0;
    const st  = m.status || 'owned';
    for (let i = 1; i <= n; i++) {
      if (st === 'completed') {
        m.bands[i] = 'completed';
      } else if (st === 'reading') {
        if (cur > 0 && i < cur)        m.bands[i] = 'completed';
        else if (cur > 0 && i === cur) m.bands[i] = 'reading';
        else                           m.bands[i] = 'owned';
      } else {
        m.bands[i] = 'owned';
      }
    }
  });
})();

// ─── Per-manga helpers (use bands as source of truth) ─────────────────────
function mOwned(m)  { return Object.keys(m.bands || {}).length; }
function mCurrent(m) {
  const e = Object.entries(m.bands || {}).find(([,v]) => v === 'reading');
  return e ? Number(e[0]) : null;
}
function mSeriesStatus(m) {
  if (m.status === 'wishlist') return 'wishlist';
  const vals = Object.values(m.bands || {});
  if (!vals.length) return 'owned';
  if (vals.includes('reading')) return 'reading';
  if (vals.every(v => v === 'completed')) return 'completed';
  return 'owned';
}
function mNextBand(m) {
  const keys = Object.keys(m.bands || {}).map(Number);
  return keys.length ? Math.max(...keys) + 1 : 1;
}
function mFirstMissingBand(m) {
  const owned = m.bands || {};
  const total = Number(m.total);
  const hasTotalKnown = !isNaN(total) && total > 0;
  const ownedNums = new Set(Object.keys(owned).map(Number));
  const maxOwned = ownedNums.size ? Math.max(...ownedNums) : 0;
  const searchUpTo = hasTotalKnown ? total : (maxOwned + 1);
  for (let i = 1; i <= searchUpTo; i++) {
    if (!ownedNums.has(i)) return i;
  }
  // Alle Bände bis total vorhanden → kein fehlender Band
  return null;
}
function mCollectionStatus(m) {
  if (m.status === 'wishlist') return 'wishlist';
  const total = Number(m.total);
  const totalKnown = !isNaN(total) && total > 0;
  if (totalKnown && mFirstMissingBand(m) !== null) return 'missing';
  if (totalKnown && mFirstMissingBand(m) === null) return 'complete';
  return mOwned(m) > 0 ? 'owned' : 'empty';
}

// ─── Modal Band-Manager state ──────────────────────────────────────────────
let modalBands = {};
let modalBandCovers = {};
const ST_LABEL = { owned: '📚 Zu lesen', reading: '📖 Lese ich', completed: '✅ Gelesen' };
const ST_CYCLE = { owned: 'reading', reading: 'completed', completed: 'owned' };

function renderBandMgr() {
  const c = document.getElementById('band-mgr');
  const sorted = Object.entries(modalBands).sort(([a],[b]) => Number(a)-Number(b));
  if (!sorted.length) {
    c.innerHTML = `<div class="band-empty-note">Noch keine Bände eingetragen</div>`;
    return;
  }
  c.innerHTML = sorted.map(([nr, st]) => {
    const cov = modalBandCovers[nr] || '';
    const hasCov = !!cov;
    const tip = hasCov ? ('Cover ändern – aktuell: ' + cov) : ('Cover-URL für Band ' + nr + ' setzen');
    return `<div class="band-row">
      <span class="band-nr">Band ${nr}</span>
      <button type="button" class="band-status-btn st-${st}" data-action="cycle-band" data-band-nr="${escapeHtml(nr)}">${ST_LABEL[st]}</button>
      <button type="button" class="band-cover-btn${hasCov ? ' has-cover' : ''}" data-action="edit-band-cover" data-band-nr="${escapeHtml(nr)}" title="${tip.replace(/"/g,'&quot;')}">🖼️</button>
      <button type="button" class="band-remove-btn" data-action="remove-band" data-band-nr="${escapeHtml(nr)}" title="Entfernen">✕</button>
    </div>`;
  }).join('');
}
function editBandCover(nr) {
  const cur = modalBandCovers[nr] || '';
  const next = prompt(`Cover-URL für Band ${nr}\n(leer lassen zum Entfernen):`, cur);
  if (next === null) return;
  const v = next.trim();
  if (v) modalBandCovers[nr] = v; else delete modalBandCovers[nr];
  renderBandMgr();
}
function cycleBand(nr) { modalBands[nr] = ST_CYCLE[modalBands[nr]] || 'owned'; renderBandMgr(); }
function removeBand(nr) { delete modalBands[nr]; renderBandMgr(); }
function addNextBand() {
  const keys = Object.keys(modalBands).map(Number);
  const next = String(keys.length ? Math.max(...keys) + 1 : 1);
  modalBands[next] = 'owned';
  renderBandMgr();
}

// ─── Dark Mode (permanent) ────────────────────────────────────────────────
document.body.classList.add('dark');

// ─── Bulk Complete ────────────────────────────────────────────────────────
function bulkComplete() {
  const until = parseInt(document.getElementById('bulk-until').value);
  if (!until || until < 1) { toast('⚠️ Bitte eine Band-Nummer eingeben'); return; }
  for (let i = 1; i <= until; i++) modalBands[String(i)] = 'completed';
  document.getElementById('bulk-until').value = '';
  renderBandMgr();
  toast(`✅ Bände 1–${until} als Gelesen markiert`);
}

// ─── Manga Passion API (Band-Cover) ──────────────────────────────────────
const MP_API = 'https://api.manga-passion.de';

function mpEscape(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function mpNormTitle(t) {
  return (t||'').toLowerCase()
    .replace(/[äÄ]/g,'a').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ß]/g,'ss')
    .replace(/[–—−]/g,'-')
    .replace(/[^a-z0-9\s-]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function mpNormPub(p) {
  return (p||'').toLowerCase()
    .replace(/[!.,]/g,'')
    .replace(/[äÄ]/g,'a').replace(/[öÖ]/g,'o').replace(/[üÜ]/g,'u').replace(/[ß]/g,'ss')
    .replace(/\s+/g,' ').trim();
}
async function mpSearchEditions(title) {
  // ?search= ist Fuzzy/Volltext — ?title= macht striktes Substring-Match und scheitert
  // bei „No.8" vs „No. 8" oder Em-Dash vs Doppelpunkt in DB-Titeln.
  const r = await fetch(`${MP_API}/editions?search=${encodeURIComponent(title)}&itemsPerPage=15`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error('MP search HTTP ' + r.status);
  return r.json();
}
function mpScore(m, candidate) {
  const a = mpNormTitle(m.title);
  const b = mpNormTitle(candidate.title);
  let score = 0;
  if (a === b) score += 100;
  else if (b.startsWith(a) || a.startsWith(b)) score += 60;
  else if (b.includes(a) || a.includes(b)) score += 35;
  else {
    const d = levenshtein(a, b);
    if (d <= 2) score += 25;
    else if (d <= 5) score += 10;
  }
  const myPub = mpNormPub(m.pub);
  const cands = (candidate.publishers || []).map(p => mpNormPub(p.name));
  if (myPub && cands.some(c => c === myPub || c.includes(myPub) || myPub.includes(c))) score += 30;
  const t = (candidate.title || '').toLowerCase();
  if (t.includes('ebook')) score -= 30;
  if (t.includes('light novel') || /\bnovel\b/.test(t) || /\broman\b/.test(t)) score -= 25;
  if (t.includes('wimmelbuch') || t.includes('kochbuch') || t.includes('artbook')) score -= 40;
  if ((candidate.numVolumes || 0) >= 5) score += 5;
  return score;
}
async function mpFindEdition(m, opts) {
  opts = opts || {};
  if (m.mpEditionId && m.mpEditionId !== 'none' && !opts.force) return m.mpEditionId;
  let hits;
  try { hits = await mpSearchEditions(m.title); }
  catch (e) { console.warn('MP search error:', m.title, e); return null; }
  if (!Array.isArray(hits) || !hits.length) return null;
  const scored = hits.map(h => ({ ed: h, score: mpScore(m, h) })).sort((a,b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < 40) {
    console.warn('MP: kein verlässlicher Treffer für', m.title, '— Top-Score', top ? top.score : '–');
    return null;
  }
  console.log('MP-Match:', m.title, '→', top.ed.title, '(Edition', top.ed.id + ', Score', top.score + ')');
  return top.ed.id;
}

async function mpFetchCovers(m, opts) {
  opts = opts || {};
  let edId = m.mpEditionId;
  if (!edId || edId === 'none' || opts.force) {
    edId = await mpFindEdition(m, opts);
    if (!edId) { return { ok: false, reason: 'cancelled' }; }
    if (edId === 'none') { m.mpEditionId = 'none'; saveLoc(); return { ok: false, reason: 'no-match' }; }
    m.mpEditionId = edId;
  }
  let r;
  try {
    r = await fetch(`${MP_API}/editions/${edId}/volumes?itemsPerPage=300`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r.ok) return { ok: false, reason: 'http-' + r.status };
  const vols = await r.json();
  if (!Array.isArray(vols) || !vols.length) return { ok: false, reason: 'no-volumes' };
  const byVol = {};
  let added = 0;
  vols.forEach(v => {
    if (v.specialType) return;
    if (typeof v.number !== 'number' || v.number < 1) return;
    if (!v.cover) return;
    byVol[String(v.number)] = v.cover;
    added++;
  });
  if (!added) return { ok: false, reason: 'no-covers' };
  m.bandCovers = { ...(m.bandCovers||{}), ...byVol };
  m.mpVerifiedAt = new Date().toISOString();
  saveLoc();
  return { ok: true, count: added };
}

let _mpBusy = false;
async function mpSyncOne() {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  if (_mpBusy) return;
  if (!editId) { toast('⚠️ Erst Serie speichern'); return; }
  const m = db.m.find(x => x.id === editId);
  if (!m) return;
  _mpBusy = true;
  toast('🔍 Suche bei Manga Passion…');
  try {
    const res = await mpFetchCovers(m);
    if (res.ok) { toast(`✅ ${res.count} Band-Cover für „${m.title}" geladen`); pushCloud(); render(); }
    else if (res.reason === 'cancelled') toast('⏹ Abgebrochen');
    else toast(`⚠️ Kein Treffer (${res.reason})`);
  } catch (e) { console.warn('MP error:', e); toast('⚠️ Manga-Passion-Fehler'); }
  _mpBusy = false;
}

async function mpSyncAll() {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  if (_mpBusy) return;
  _mpBusy = true;
  const btn = document.querySelector('[data-action="mp-sync-all"]');
  const previousLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Cover werden geladen…'; }
  const list = db.m.filter(m => mOwned(m) > 1 && m.mpEditionId !== 'none');
  let ok = 0, miss = 0, cancelled = false;
  for (const m of list) {
    try {
      const res = await mpFetchCovers(m, { auto: true });
      if (res.ok) ok++;
      else if (res.reason === 'cancelled') { cancelled = true; break; }
      else miss++;
    } catch { miss++; }
    await new Promise(r => setTimeout(r, 350));
  }
  if (ok > 0) { pushCloud(); render(); }
  toast(`${cancelled?'⏹':'✅'} ${ok} aktualisiert · ${miss} ohne Treffer${cancelled?' (Abbruch)':''}`);
  if (btn) { btn.disabled = !canEditLocal(); btn.textContent = previousLabel || 'Alle Band-Cover laden'; }
  _mpBusy = false;
}

// ─── State ────────────────────────────────────────────────────────────────
let tab = 'reading';
let editId = null;
let searchQ = '';
let viewMode = 'series'; // 'series' | 'volumes'
let sortMode = 'az';     // 'az' | 'za' | 'next' | 'added'
let filterPub = '';      // Verlagsfilter

// ─── Release Cache State (Phase 15b) ─────────────────────────────────────
let releaseCache        = null;         // Geladene release-cache.json oder null
let releaseCacheStatus  = 'not-loaded'; // 'not-loaded' | 'loaded' | 'missing' | 'invalid'
let releaseWatchlistData = null;        // Phase 34: read-only release-watchlist.json
let releaseWatchlistStatus = 'not-loaded';
let releaseReviewQueueData = null;      // Phase 34: read-only release-source-review-queue.json
let releaseReviewQueueStatus = 'not-loaded';
let releaseVolumeCounts = null;       // Phase 43: read-only public DE volume counts
let releaseVolumeCountsStatus = 'not-loaded';
let _currentReleaseMatches = [];        // Zwischenspeicher für aktuelle Vorschau (Phase 15c)
// Phase 44a-followup: Dashboard-Buttons "Alle Release-Daten prüfen",
// "Alle Serien-Status prüfen" und "Cache-Coverage prüfen" entfernt.
// Release-Daten und DE-Bandstand laufen vollautomatisch über Phase 25/32/42/43.
// Preview-State-Variablen entfallen entsprechend.

// Phase 52: Zentrale Sichtbarkeitslogik für den Serien-/Bänder-Umschalter.
// Der Umschalter erscheint in allen Bibliothekstabs mit Serien/Bänder-Dualität
// (reading, owned, completed, wishlist) und ist nur in Tabs ohne diese
// Dualität ausgeblendet.
const NO_TOGGLE_TABS = ['buy', 'kalender', 'dashboard'];
function updateViewToggleVisibility() {
  const toggle = document.getElementById('view-toggle');
  if (toggle) toggle.style.display = NO_TOGGLE_TABS.includes(tab) ? 'none' : 'flex';
}

function setView(mode) {
  viewMode = mode;
  document.getElementById('vbtn-series').classList.toggle('active', mode === 'series');
  document.getElementById('vbtn-volumes').classList.toggle('active', mode === 'volumes');
  render();
}

function onSearch(val) {
  searchQ = val.trim().toLowerCase();
  document.getElementById('search-clear').style.display = searchQ ? 'block' : 'none';
  render();
}
function clearSearch() {
  searchQ = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  document.getElementById('search-hint').textContent = '';
  render();
}
function applySearch(list) {
  if (!searchQ) return list;
  return list.filter(m => m.title.toLowerCase().includes(searchQ) || (m.pub||'').toLowerCase().includes(searchQ));
}

// ─── Computed ─────────────────────────────────────────────────────────────

// Phase 18f: Stabile Sortierfunktion für Kaufeinträge (keine Datenmutation)
// Reihenfolge: verfügbar zuerst → zukünftige aufsteigend nach Datum → kein Datum
//              → sekundär alphabetisch nach Titel → tertiär nach Bandnummer
function compareBuyEntries(a, b, today) {
  if (!today) { today = new Date(); today.setHours(0,0,0,0); }
  const da = a.nextDate ? new Date(a.nextDate + 'T00:00:00') : null;
  const db2 = b.nextDate ? new Date(b.nextDate + 'T00:00:00') : null;
  const aAvail = !da || da <= today;
  const bAvail = !db2 || db2 <= today;
  // 1) Verfügbare zuerst
  if (aAvail && !bAvail) return -1;
  if (!aAvail && bAvail) return 1;
  // 2) Beide zukünftig: aufsteigend nach Datum
  if (!aAvail && !bAvail) {
    if (da && db2) {
      const diff = da - db2;
      if (diff !== 0) return diff;
    }
  }
  // 3) Beide verfügbar oder gleiche Daten: kein Datum nach Datum-Einträgen
  if (da && !db2) return -1;
  if (!da && db2) return 1;
  // 4) Alphabetisch nach Titel
  const titleCmp = (a.title || '').localeCompare(b.title || '', 'de');
  if (titleCmp !== 0) return titleCmp;
  // 5) Nach Bandnummer
  return (a.next || 0) - (b.next || 0);
}

function toBuyList() {
  const today = new Date(); today.setHours(0,0,0,0);
  return db.m
    .filter(m => {
      const total = Number(m.total);
      const owned = mOwned(m);
      if (isNaN(total) || total <= 0 || total <= owned) return false;
      return mFirstMissingBand(m) !== null;
    })
    .map(m => ({ ...m, next: mFirstMissingBand(m) }))
    .sort((a, b) => compareBuyEntries(a, b, today));
}

// ─── Volume list helpers ──────────────────────────────────────────────────
function bandStatus(m, bandNr) {
  return (m.bands || {})[String(bandNr)] || 'owned';
}

function countBandStatuses() {
  const cnt = { owned: 0, reading: 0, completed: 0 };
  db.m.forEach(m => {
    Object.values(m.bands || {}).forEach(st => {
      if (cnt[st] !== undefined) cnt[st]++;
    });
  });
  return cnt;
}

function bandEntriesForStatus(status, list = db.m) {
  const vols = [];
  list.forEach(m => {
    Object.entries(m.bands || {}).forEach(([bandNr, st]) => {
      if (st === status) vols.push({ ...m, _band: Number(bandNr), _bandStatus: st });
    });
  });
  return vols;
}

function sortVolumeEntries(vols) {
  return vols.slice().sort((a, b) => {
    if (sortMode === 'za') { const t = b.title.localeCompare(a.title,'de'); return t !== 0 ? t : a._band - b._band; }
    if (sortMode === 'added') { const t = (b.at||0)-(a.at||0); return t !== 0 ? t : a._band - b._band; }
    const t = a.title.localeCompare(b.title,'de'); return t !== 0 ? t : a._band - b._band;
  });
}

function volumeActions(v) {
  if (!canEditLocal()) return '';
  const id = escapeHtml(v.id);
  const band = escapeHtml(v._band);
  const buttons = [];
  if (v._bandStatus !== 'reading') {
    buttons.push(`<button class="btn-xs btn-edit" data-action="set-band-status" data-manga-id="${id}" data-band-nr="${band}" data-status="reading">Lese ich</button>`);
  }
  if (v._bandStatus !== 'owned') {
    buttons.push(`<button class="btn-xs btn-edit" data-action="set-band-status" data-manga-id="${id}" data-band-nr="${band}" data-status="owned">Zu lesen</button>`);
  }
  if (v._bandStatus !== 'completed') {
    buttons.push(`<button class="btn-xs btn-buy" data-action="set-band-status" data-manga-id="${id}" data-band-nr="${band}" data-status="completed">Gelesen ✓</button>`);
  }
  buttons.push(`<button class="btn-xs btn-edit" data-action="open-edit" data-manga-id="${id}">Bearbeiten</button>`);
  return `<div class="vol-actions">${buttons.join('')}</div>`;
}

function volumeRow(v) {
  const c = colorFor(v.title);
  const bandCover = safeHttpsUrl((v.bandCovers || {})[String(v._band)] || v.cover);
  const clickAttrs = isPublicReadOnly() ? '' : ` data-action="open-edit" data-manga-id="${escapeHtml(v.id)}"`;
  const status = v._bandStatus || bandStatus(v, v._band);
  return `<div class="vol-row"${clickAttrs}>
    <div class="vol-cover" data-style-background="${escapeHtml(c)}">
      ${bandCover ? `<img src="${escapeHtml(bandCover)}" alt="" loading="lazy" data-remove-on-error="true">` : `<div class="vol-cover-letter">${escapeHtml((v.title || '?').slice(0,1).toUpperCase())}</div>`}
      <div class="vol-cover-gradient"></div>
      <div class="vol-band-badge">Band ${escapeHtml(v._band)}</div>
    </div>
    <div class="vol-info">
      <div class="vol-title">${escapeHtml(v.title)}</div>
      <div class="vol-pub">${escapeHtml(v.pub || 'Unbekannt')}</div>
      <div class="vol-status-pill st-${escapeHtml(status)}">${ST_LABEL[status] || escapeHtml(status)}</div>
      ${volumeActions({ ...v, _bandStatus: status })}
    </div>
  </div>`;
}

// Phase 52: Bändenansicht (☰) für reading/owned/completed — Phase-31-Verhalten.
// Sichtbarkeit des Umschalters steuert updateViewToggleVisibility() zentral.
function renderBandStatusList(status, el, hint) {
  const all = bandEntriesForStatus(status, applyPubFilter(db.m));
  const filtered = sortVolumeEntries(bandEntriesForStatus(status, applySearch(applyPubFilter(db.m))));
  if (searchQ) hint.textContent = `${filtered.length} von ${all.length} Band${all.length!==1?'e':''}`;
  else {
    const serienCount = new Set(all.map(v => v.id)).size;
    hint.textContent = all.length ? `${all.length} Band${all.length!==1?'e':''} aus ${serienCount} Serie${serienCount!==1?'n':''}` : '';
  }
  if (!all.length) {
    const emptyInfo = {
      reading: ['📖', 'Kein Band aktuell in Bearbeitung', 'Setze einen Band auf „Lese ich“, dann erscheint er hier.'],
      owned: ['📚', 'Keine ungelesenen Bände zum Lesen', 'Gekaufte, noch ungelesene Bände erscheinen hier.'],
      completed: ['✅', 'Noch keine Bände als gelesen markiert', 'Sobald du Bände als „Gelesen“ markierst, erscheinen sie hier.'],
    };
    const [ic, tt, sub] = emptyInfo[status] || ['📦','Leer',''];
    el.innerHTML = `<div class="empty"><div class="empty-icon">${ic}</div><h3>${tt}</h3><p>${sub}</p></div>`;
    return;
  }
  if (!filtered.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${escapeHtml(searchQ)}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="vol-list">${filtered.map(volumeRow).join('')}</div>`;
}

// Phase 52: Serienansicht (⊞) für reading/owned/completed/wishlist.
// Extrahiert aus dem früheren completed-Serienpfad, damit alle vier Tabs
// denselben Code nutzen.
function renderSeriesGrid(status, el, hint) {
  const rawItems = applySort(applyGenreFilter(applyPubFilter(db.m.filter(m => mSeriesStatus(m) === status))));
  const items = applySearch(rawItems);

  if (searchQ) hint.textContent = `${items.length} von ${rawItems.length} Ergebnis${items.length!==1?'se':''}`;
  else hint.textContent = '';

  if (!rawItems.length) {
    const info = {
      reading:   ['📖', 'Noch nichts in Bearbeitung', 'Füge Mangas hinzu, die du gerade liest.'],
      completed: ['✅', 'Noch nichts abgeschlossen', 'Hier landen Serien, die du vollständig gelesen hast.'],
      owned:     ['📚', 'Noch nichts zum Lesen', 'Sobald du einen Band als „Gekauft" markierst, erscheint er hier.'],
      wishlist:  ['💜', 'Wunschliste ist leer', 'Füge Serien hinzu, die du noch kaufen oder starten möchtest.'],
    };
    const [ic, tt, sub] = info[status]||['📦','Leer',''];
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">${ic}</div>
      <h3>${tt}</h3>
      <p>${sub}</p>
      <button class="add-btn centered-add-btn" data-action="open-add">＋ Manga hinzufügen</button>
    </div>`;
    return;
  }
  if (!items.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${escapeHtml(searchQ)}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="manga-grid">${items.map(mangaCard).join('')}</div>`;
  updatePubFilter();
  updateGenreFilter();
}

// Phase 52 (Option A): Bändenansicht (☰) der Wunschliste.
// Listet alle erfassten Band-Einträge (jeder Bandstatus) der Serien mit
// mSeriesStatus(m) === 'wishlist'. Wunschlistenserien haben meist keine
// einzelnen Bände → erklärender Leerzustand.
function wishlistBandEntries(list) {
  const vols = [];
  list.filter(m => mSeriesStatus(m) === 'wishlist').forEach(m => {
    Object.entries(m.bands || {}).forEach(([bandNr, st]) => {
      vols.push({ ...m, _band: Number(bandNr), _bandStatus: st });
    });
  });
  return vols;
}

function renderWishlistVolumes(el, hint) {
  const all = wishlistBandEntries(applyPubFilter(db.m));
  const filtered = sortVolumeEntries(wishlistBandEntries(applySearch(applyPubFilter(db.m))));
  if (searchQ) hint.textContent = `${filtered.length} von ${all.length} Band${all.length!==1?'e':''}`;
  else {
    const serienCount = new Set(all.map(v => v.id)).size;
    hint.textContent = all.length ? `${all.length} Band${all.length!==1?'e':''} aus ${serienCount} Serie${serienCount!==1?'n':''}` : '';
  }
  if (!all.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">💜</div><h3>Keine erfassten Bände auf der Wunschliste</h3><p>Wunschlistenserien haben meist noch keine einzelnen Bände — wechsle zur Serienansicht (⊞).</p></div>`;
    return;
  }
  if (!filtered.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${escapeHtml(searchQ)}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="vol-list">${filtered.map(volumeRow).join('')}</div>`;
}
// ─── Render helpers ───────────────────────────────────────────────────────
function coverEl(m, size = 'full', bandNr = null) {
  const c = colorFor(m.title);
  const bc = m.bandCovers || {};
  // Serienansicht (bandNr=null): Band-1-Cover bevorzugen, sonst Serien-Fallback
  const rawImg = bandNr ? (bc[String(bandNr)] || m.cover)
                        : (bc['1'] || m.cover);
  const img = safeHttpsUrl(rawImg);
  if (size === 'full') {
    return `<div class="cover" data-style-background="${escapeHtml(c)}">
      ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" data-remove-on-error="true">` : ''}
      <div class="cover-gradient"></div>
    </div>`;
  }
  return `<div class="mini-cover" data-style-background="${escapeHtml(c)}">
    ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" data-remove-on-error="true">` : ''}
  </div>`;
}

function applyDeferredStyles(root = document) {
  root.querySelectorAll?.('[data-style-background]').forEach(el => {
    el.style.background = el.dataset.styleBackground;
  });
  root.querySelectorAll?.('[data-style-width]').forEach(el => {
    el.style.width = el.dataset.styleWidth;
  });
  root.querySelectorAll?.('[data-style-height]').forEach(el => {
    el.style.height = el.dataset.styleHeight;
  });
}

function bindDeferredStyleObserver() {
  applyDeferredStyles(document);
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        applyDeferredStyles(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function mangaCard(m) {
  const total = Number(m.total);
  const owned = mOwned(m);
  const cur   = mCurrent(m);
  const hasProg = !isNaN(total) && total > 0;
  const publicVolumeSummary = buildPersonalReleaseVolumeSummary(m);
  const prog = hasProg ? Math.min(100, Math.round(owned / total * 100)) : 0;
  const volText = hasProg ? `${owned} / ${total} Bände` : `${owned} Bände`;
  // Phase 38: Statusbedeutung bezieht sich auf die deutschsprachige Veröffentlichung.
  const statusPill = m.ongoing === 'true'
    ? '<span class="ongoing-pill" title="Deutschsprachige Veröffentlichung läuft – weitere DE-Bände erwartet">laufend (DE)</span>'
    : m.ongoing === 'false'
      ? '<span class="done-pill" title="Deutschsprachige Veröffentlichung abgeschlossen">abgeschlossen (DE)</span>'
      : '<span class="unknown-pill" title="Deutschsprachiger Veröffentlichungsstatus unklar">unbekannt (DE)</span>';
  const readingBadge = cur ? `<div class="reading-badge">Band ${cur}</div>` : '';
  const wishBadge = mSeriesStatus(m) === 'wishlist' ? `<div class="wishlist-badge">💜 Wunsch</div>` : '';

  return `<div class="manga-card"${isPublicReadOnly() ? '' : ` data-action="open-edit" data-manga-id="${escapeHtml(m.id)}"`}>
    <div class="cover-stack">
      ${coverEl(m)}
      ${readingBadge}
      ${wishBadge}
    </div>
    <div class="card-info">
      <div class="card-title">${escapeHtml(m.title)}</div>
      <div class="card-pub">${escapeHtml(m.pub || 'Unbekannt')} ${statusPill}</div>
      <div class="card-vols">${volText}</div>
      ${publicVolumeSummary ? `<div class="card-release-volume-summary">${publicVolumeSummary}</div>` : ''}
      ${hasProg ? `<div class="progress"><div class="progress-fill" data-style-width="${prog}%"></div></div>` : ''}
      ${(m.genres||[]).length ? `<div class="card-genres">${(m.genres).map(g=>`<span class="card-genre">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
      ${(m.startedAt||m.finishedAt) ? `<div class="card-dates">${m.startedAt?'📖 '+new Date(m.startedAt+'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}):''}${m.startedAt&&m.finishedAt?' – ':''}${m.finishedAt?'✅ '+new Date(m.finishedAt+'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}):''}</div>`:''}
      <button class="share-btn" data-action="share-manga" data-manga-id="${escapeHtml(m.id)}" title="Empfehlung teilen">📤</button>
    </div>
  </div>`;
}

function buyCard(m, isAvail) {
  const today = new Date(); today.setHours(0,0,0,0);
  let dateLabel = '';
  if (m.nextDate) {
    const d = new Date(m.nextDate + 'T00:00:00');
    if (d <= today) {
      dateLabel = `<div class="buy-date avail">✓ Jetzt erhältlich</div>`;
    } else {
      dateLabel = `<div class="buy-date">📅 ${d.toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})}</div>`;
    }
  }
  const q = encodeURIComponent(`${m.title} Manga Band ${m.next}`);
  const shopLinks = `<div class="shop-links">
    <a class="shop-link" href="https://www.thalia.de/suche?sq=${q}" target="_blank" rel="noopener">Thalia</a>
    <a class="shop-link" href="https://www.amazon.de/s?k=${q}" target="_blank" rel="noopener">Amazon</a>
  </div>`;
  return `<div class="buy-card ${isAvail ? 'avail' : 'soon'}">
    ${coverEl(m, 'mini', m.next)}
    <div class="buy-info">
      <div class="buy-title">${escapeHtml(m.title)}</div>
      <div class="buy-band">Band ${escapeHtml(m.next)} kaufen</div>
      <div class="buy-pub">${escapeHtml(m.pub || '')}</div>
      ${dateLabel}
      ${shopLinks}
    </div>
    <div class="buy-btns">
      <button class="btn-xs btn-buy" data-action="mark-bought" data-manga-id="${escapeHtml(m.id)}">Gekauft ✓</button>
      <button class="btn-xs btn-edit" data-action="open-edit" data-manga-id="${escapeHtml(m.id)}">Bearbeiten</button>
    </div>
  </div>`;
}

// ─── Öffentliches Profil ──────────────────────────────────────────────────
const _viewColl = new URLSearchParams(window.location.search).get('view');

// ─── App-Modus ────────────────────────────────────────────────────────────
// Drei Modi:
//   'public-readonly'  — ?view= gesetzt: fremde Sammlung, keine Schreibrechte
//   'cloud-owner-edit' — eigene Sammlung mit Owner-Token: Lesen + Cloud-Schreiben
//   'local-edit'       — kein Cloud-Sync konfiguriert: nur lokales Schreiben
// Der Frontend-Check ist nur UX; der harte Schutz ist die RLS-Policy collections_update_owner.
function getAppMode() {
  if (_viewColl) return 'public-readonly';
  // Phase 51: a signed-in owner (valid session) is cloud-owner-edit even without the
  // legacy owner token — e.g. on a fresh browser. Writes then go via the session JWT
  // (src/supabase.js patchCollection), with the token path as fallback when present.
  if (_collId && (_ownerToken || (SupabaseAdapter.hasValidSession && SupabaseAdapter.hasValidSession()))) return 'cloud-owner-edit';
  return 'local-edit';
}
function isPublicReadOnly() { return getAppMode() === 'public-readonly'; }
function canEditLocal()     { return !isPublicReadOnly(); }
function canWriteCloud()    { return getAppMode() === 'cloud-owner-edit'; }

// UUID-Validator für View-IDs
function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function applyReadOnly() {
  if (!isPublicReadOnly()) return;
  document.getElementById('readonly-banner').style.display = 'flex';
  document.getElementById('btn-add').style.display = 'none';
  document.getElementById('btn-share-profile').style.display = 'none';
}

function shareProfile() {
  if (!_collId) { toast('⚠️ Noch keine Sammlung erstellt'); return; }
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?view=${_collId}`;
  if (navigator.share) {
    navigator.share({ title: 'Meine Manga-Sammlung', url }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(url).then(() => toast('📋 Link kopiert — teile ihn mit Freunden!'));
  }
}

function startOwnCollection() {
  // INSERT auf public.collections ist serverseitig verboten. Neue Sammlungen entstehen
  // nur ueber einen separaten Setup-Prozess + Adopt-Link, der den Owner-Token liefert.
  toast('ℹ️ Eigene Sammlung kann aktuell nur über einen neuen Adopt-Link/Setup-Prozess erstellt werden.');
}

async function loadViewCollection() {
  // Phase 27b: öffentliche Ansicht lädt nur die Public Projection/public_data.
  // Kein Legacy-Fallback auf private data.
  if (!_viewColl) return;
  if (!isUuid(_viewColl)) {
    toast('⚠️ Ungültiger Sammlungslink.');
    console.error('loadViewCollection: _viewColl ist keine gültige UUID:', _viewColl);
    return;
  }
  try {
    const record = await SupabaseAdapter.fetchPublicCollection(_viewColl);
    if (record && Array.isArray(record.m)) {
      // Validierung VOR Übernahme: kaputte fremde Sammlung nicht rendern
      if (!validateDatabase(record)) {
        toast('⚠️ Diese Sammlung enthält ungültige Daten und kann nicht angezeigt werden');
        console.error('loadViewCollection: Sammlung abgelehnt – ungültige Einträge');
        return;
      }
      db = record;
      db.m.forEach(m => {
        const key = Object.keys(SEED_DATES).find(k => m.title.toLowerCase().includes(k));
        if (!key) return;
        const s = SEED_DATES[key];
        setNextDateIfEmpty(m, s.nextDate);
        setIfEmpty(m, 'total', s.total);
        setIfEmpty(m, 'ongoing', s.ongoing);
      });
      render();
    }
  } catch { toast('⚠️ Sammlung konnte nicht geladen werden'); }
}

// ─── Dashboard ────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Phase 50: Escaping für YAML-Double-Quoted-Strings (Obsidian-Export).
// Reihenfolge wichtig: erst Backslash, dann Anführungszeichen — sonst würde
// ein bereits gesetzter Escape-Backslash erneut verdoppelt (incomplete sanitization).
// Zeilenumbrüche werden auf Leerzeichen reduziert, damit das Frontmatter gültig bleibt.
function escapeYamlString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

// Phase 38: Der Wert `ongoing` beschreibt den Stand der deutschsprachigen
// Veröffentlichung – NICHT den japanischen/originalen Veröffentlichungsstatus.
//   'true'    → DE-Ausgabe läuft (weitere reguläre Bände erwartet)
//   'false'   → DE-Ausgabe abgeschlossen oder offiziell beendet
//   'unknown' → DE-Status nicht belastbar geklärt
function seriesStatusLabel(value) {
  if (value === 'true') return 'Laufend (DE)';
  if (value === 'false') return 'Abgeschlossen (DE)';
  return 'Unbekannt (DE)';
}

function collectionStatusLabel(value) {
  return {
    wishlist: 'Wunschliste',
    missing: 'Unvollständig',
    complete: 'Vollständig gesammelt',
    owned: 'Ohne bekannte Gesamtzahl',
    empty: 'Ohne Bände',
  }[value] || value;
}

function renderDashboard() {
  reconcileLocalReleaseCoveragePending();
  const year = new Date().getFullYear();
  const MONATE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  const el = document.getElementById('content');
  updateGenreFilter();

  // Sammlung gesamt
  const totalSeries  = db.m.length;
  const totalVols    = db.m.reduce((s,m) => s + mOwned(m), 0);
  const readingSeries = db.m.filter(m => mSeriesStatus(m) === 'reading').length;
  // Abgeschlossene BÄNDE (nicht Serien) — Status 'completed' im bands-Objekt
  const completedVols = db.m.reduce((s,m) =>
    s + Object.values(m.bands || {}).filter(v => v === 'completed').length, 0);
  const buyCount = toBuyList().length;

  const startedYear = db.m.filter(m => m.startedAt && m.startedAt.startsWith(year)).length;
  const finishedYear = db.m.filter(m => m.finishedAt && m.finishedAt.startsWith(year)).length;

  // Monatliche Abschlüsse dieses Jahres
  const monthCount = Array(12).fill(0);
  db.m.forEach(m => { if (m.finishedAt?.startsWith(year)) monthCount[new Date(m.finishedAt+'T00:00:00').getMonth()]++; });
  const maxMonth = Math.max(...monthCount, 1);

  // Publisher-Verteilung
  const pubMap = {};
  db.m.forEach(m => { if (m.pub) pubMap[m.pub] = (pubMap[m.pub]||0)+1; });
  const pubEntries = Object.entries(pubMap).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxPub = pubEntries[0]?.[1] || 1;

  // Genre-Verteilung
  const genreMap = {};
  db.m.forEach(m => (m.genres||[]).forEach(g => { genreMap[g]=(genreMap[g]||0)+1; }));
  const genreEntries = Object.entries(genreMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxGenre = genreEntries[0]?.[1] || 1;

  // Phase 17a: Fehlende Bände, Fortschritt, Vollständigkeit
  const totalKnown = db.m.reduce((s, m) => {
    const t = Number(m.total);
    return s + (isNaN(t) || t <= 0 ? 0 : t);
  }, 0);
  const totalMissing = db.m.reduce((s, m) => {
    const t = Number(m.total);
    if (isNaN(t) || t <= 0) return s;
    return s + Math.max(0, t - mOwned(m));
  }, 0);
  const buyProgress = totalKnown > 0
    ? Math.round((totalVols / totalKnown) * 100)
    : null;
  const completeSeries = db.m.filter(m => {
    const t = Number(m.total);
    return !isNaN(t) && t > 0 && mFirstMissingBand(m) === null;
  }).length;
  const seriesWithMissing = db.m.filter(m => {
    const t = Number(m.total);
    return !isNaN(t) && t > 0 && mFirstMissingBand(m) !== null;
  }).length;

  // Phase 17a: Publikationsstatus
  const ongoingCount  = db.m.filter(m => m.ongoing === 'true').length;
  const finishedCount = db.m.filter(m => m.ongoing === 'false').length;
  const unknownCount  = db.m.filter(m => m.ongoing !== 'true' && m.ongoing !== 'false').length;

  // Phase 18b: Sammlungsstatus-Verteilung nach Bänden
  const statusCounts = { reading: 0, completed: 0, owned: 0, wishlist: 0 };
  db.m.forEach(m => {
    if (m.status === 'wishlist') {
      // Wishlist-Serien: Anzahl Bände als Wishlist zählen, mindestens 1
      statusCounts.wishlist += Math.max(Object.keys(m.bands || {}).length, 1);
    } else {
      // Alle anderen: jeden Band einzeln nach seinem Status zählen
      Object.values(m.bands || {}).forEach(st => {
        if (statusCounts[st] !== undefined) statusCounts[st]++;
      });
    }
  });
  const statusMax = Math.max(
    statusCounts.reading, statusCounts.completed,
    statusCounts.owned,   statusCounts.wishlist, 1
  );

  // Phase 18f: Kaufvorschau (max. 8, available-first via toBuyList())
  const BUY_PREVIEW_MAX = 8;
  const today = new Date(); today.setHours(0,0,0,0);
  const buyPreviewAll = toBuyList();
  const buyPreviewItems = buyPreviewAll.slice(0, BUY_PREVIEW_MAX);

  // Phase 17c: Release-Cache-Kennzahlen (nur bei geladenem Cache rendern)
  const releaseStatsAvailable = releaseCacheStatus === 'loaded'
    && releaseCache
    && Array.isArray(releaseCache.items);
  const releaseStats = releaseStatsAvailable ? (() => {
    const in30Days = new Date(today);
    in30Days.setDate(in30Days.getDate() + 30);
    const upcoming30 = releaseCache.items.filter(item => {
      if (!item || !item.releaseDate) return false;
      const d = new Date(item.releaseDate + 'T00:00:00');
      return !isNaN(d.getTime()) && d >= today && d <= in30Days;
    }).length;
    return {
      seriesWithNextDate: db.m.filter(m => !!m.nextDate).length,
      upcoming30,
      seriesWithReleaseIds: db.m.filter(m => !!m.isbn13 || (!!m.mpEditionId && m.mpEditionId !== 'none')).length,
      itemCount: releaseCache.items.length,
      generatedAt: releaseCache.generatedAt || null,
    };
  })() : null;
  const coverSyncDisabledAttr = canEditLocal() ? '' : ' disabled title="Öffentliche Ansicht – lokale Cover-Aktion deaktiviert"';
  const coverSyncNote = canEditLocal()
    ? 'Lädt fehlende Band-Cover für deine lokale Sammlung. Es wird nichts ins öffentliche Repository geschrieben.'
    : 'Öffentliche Ansicht: lokale Cover-Massenaktionen sind deaktiviert.';
  el.innerHTML = `<div class="stats-page">
    ${renderImportExport()}
    <div class="stats-section">
      <h3>Aktionszentrale: Prüfen &amp; Automatisieren</h3>
      <div class="dashboard-actions">
        <button type="button" class="add-btn dashboard-action-btn" data-action="mp-sync-all"${coverSyncDisabledAttr}>Alle Band-Cover laden</button>
        <p class="stats-empty-note">Release-Cache, Review-Queue und DE-Bandstand werden vollautomatisch per GitHub-Action/Pipeline (Phase 25/32/42/43) gepflegt. Lokale Bearbeiten-Maske zeigt Automationswerte read-only an (Phase 44b).</p>
        <p class="stats-empty-note">${coverSyncNote}</p>
        ${canWriteCloud() ? renderAutoReleaseIntakeToggle() + renderCatalogSeedBackfillAction() : ''}
      </div>
      ${renderLocalReleaseCoveragePendingSummary()}
    </div>

    <div class="stats-section">
      <h3>Sammlung gesamt</h3>
      <div class="stat-big-grid">
        <div class="stat-big-card"><div class="stat-big-n">${totalSeries}</div><div class="stat-big-l">Serien</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${totalVols}</div><div class="stat-big-l">Bände besessen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${readingSeries}</div><div class="stat-big-l">Aktiv lesend</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${completedVols}</div><div class="stat-big-l">Bände abgeschlossen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${buyCount}</div><div class="stat-big-l">Zu kaufen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${totalMissing}</div><div class="stat-big-l">Fehlende Bände</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${completeSeries}</div><div class="stat-big-l">Vollständig gesammelt</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${seriesWithMissing}</div><div class="stat-big-l">Serien mit fehlenden Bänden</div></div>
      </div>
      ${buyProgress !== null
        ? `<div class="stat-progress-row">
            <div class="stat-progress-meta">
              <span>Kauf-Fortschritt: ${totalVols} von ${totalKnown} Bänden</span>
              <span class="stat-progress-pct">${buyProgress} %</span>
            </div>
            <div class="progress stat-progress-bar"><div class="progress-fill" data-style-width="${buyProgress}%"></div></div>
          </div>`
        : `<p class="stat-progress-na">Kauf-Fortschritt nicht berechenbar</p>`}
    </div>

    <div class="stats-section">
      <h3>Deutschsprachige Veröffentlichung</h3>
      <p class="stats-section-hint small">Bezieht sich ausschließlich auf den Stand der deutschsprachigen Ausgabe – nicht auf den japanischen Originalstatus.</p>
      <div class="stat-big-grid cols-3">
        <div class="stat-big-card" title="DE-Ausgabe läuft – weitere reguläre Bände erwartet"><div class="stat-big-n">${ongoingCount}</div><div class="stat-big-l">Laufend (DE)</div></div>
        <div class="stat-big-card" title="DE-Ausgabe vollständig erschienen oder offiziell beendet"><div class="stat-big-n">${finishedCount}</div><div class="stat-big-l">Abgeschlossen (DE)</div></div>
        <div class="stat-big-card" title="DE-Status nicht belastbar geklärt"><div class="stat-big-n">${unknownCount}</div><div class="stat-big-l">Unbekannt (DE)</div></div>
      </div>
    </div>

    <div class="stats-section">
      <h3>Bände nach Sammlungsstatus</h3>
      <div class="bar-chart">
        <div class="bar-row">
          <div class="bar-label">Zu lesen</div>
          <div class="bar-track"><div class="bar-fill" data-style-width="${Math.round(statusCounts.owned/statusMax*100)}%"></div></div>
          <div class="bar-val">${statusCounts.owned}</div>
        </div>
        <div class="bar-row">
          <div class="bar-label">Lese ich</div>
          <div class="bar-track"><div class="bar-fill bar-fill-success" data-style-width="${Math.round(statusCounts.reading/statusMax*100)}%"></div></div>
          <div class="bar-val">${statusCounts.reading}</div>
        </div>
        <div class="bar-row">
          <div class="bar-label">Gelesen</div>
          <div class="bar-track"><div class="bar-fill bar-fill-purple" data-style-width="${Math.round(statusCounts.completed/statusMax*100)}%"></div></div>
          <div class="bar-val">${statusCounts.completed}</div>
        </div>
        <div class="bar-row">
          <div class="bar-label">Wunschliste</div>
          <div class="bar-track"><div class="bar-fill bar-fill-pink" data-style-width="${Math.round(statusCounts.wishlist/statusMax*100)}%"></div></div>
          <div class="bar-val">${statusCounts.wishlist}</div>
        </div>
      </div>
    </div>

    <div class="stats-section">
      <h3>Nächste Käufe &amp; Vormerkungen</h3>
      ${buyPreviewItems.length === 0
        ? `<p class="stats-empty-note">Aktuell keine offenen Käufe.</p>`
        : (() => {
            const previewAvail   = buyPreviewItems.filter(item => { const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null; return !d || d <= today; });
            const previewSoon    = buyPreviewItems.filter(item => { const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null; return d && d > today; });
            const totalAvailAll  = buyPreviewAll.filter(item => { const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null; return !d || d <= today; }).length;
            const totalSoonAll   = buyPreviewAll.filter(item => { const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null; return d && d > today; }).length;
            const totalAll       = buyPreviewAll.length;
            function buyPreviewRow(item) {
              const d = item.nextDate ? new Date(item.nextDate + 'T00:00:00') : null;
              const isAvail = !d || d <= today;
              const dateLabel = d
                ? (isAvail ? 'Jetzt erhältlich' : d.toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'}))
                : 'Jetzt erhältlich';
              const pubHtml  = item.pub   ? `<span class="stats-buy-pub">${escapeHtml(item.pub)}</span>` : '';
              const dateHtml = `<span class="stats-buy-date">${dateLabel}</span>`;
              return `<div class="stats-buy-item${isAvail ? ' avail' : ' soon'}">
                <div class="stats-buy-main">
                  <span class="stats-buy-title">${escapeHtml(item.title)}</span>
                  <span class="stats-buy-band">Band ${escapeHtml(item.next)}</span>
                </div>
                <div class="stats-buy-meta">${pubHtml}${dateHtml}</div>
              </div>`;
            }
            let html = '<div class="stats-buy-preview">';
            if (previewAvail.length) {
              html += `<div class="stats-buy-section-head avail-head">Jetzt erhältlich</div>`;
              html += previewAvail.map(buyPreviewRow).join('');
            }
            if (previewSoon.length) {
              html += `<div class="stats-buy-section-head soon-head">Vorgemerkt</div>`;
              html += previewSoon.map(buyPreviewRow).join('');
            }
            html += `</div>`;
            html += `<div class="stats-buy-summary">${totalAvailAll} verfügbar · ${totalSoonAll} vorgemerkt · ${totalAll} gesamt</div>`;
            html += `<button type="button" class="stats-buy-all-btn" data-action="set-tab" data-tab="buy">Alle Käufe anzeigen →</button>`;
            return html;
          })()}
    </div>

    ${releaseStats ? `<div class="stats-section">
      <h3>Release-Cache</h3>
      <div class="stat-big-grid cols-3">
        <div class="stat-big-card"><div class="stat-big-n">${releaseStats.seriesWithNextDate}</div><div class="stat-big-l">Serien mit Release-Datum</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${releaseStats.upcoming30}</div><div class="stat-big-l">Releases in 30 Tagen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${releaseStats.seriesWithReleaseIds}</div><div class="stat-big-l">Serien mit ISBN/MP-ID</div></div>
      </div>
      <p class="stats-empty-note">Cache: ${releaseStats.itemCount} Einträge${releaseStats.generatedAt ? ` · Stand ${new Date(releaseStats.generatedAt).toLocaleString('de-DE')}` : ''}</p>
    </div>` : ''}
    <div class="stats-section">
      <h3>Jahresrückblick ${year}</h3>
      <div class="stat-big-grid">
        <div class="stat-big-card"><div class="stat-big-n">${startedYear}</div><div class="stat-big-l">Serien begonnen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${finishedYear}</div><div class="stat-big-l">Serien abgeschlossen</div></div>
      </div>
    </div>

    <div class="stats-section">
      <h3>Monatliche Aktivität ${year}</h3>
      <div class="month-chart">
        ${MONATE.map((m,i)=>`<div class="month-col">
          <div class="month-bar" data-style-height="${Math.round(monthCount[i]/maxMonth*100)}%" title="${monthCount[i]} abgeschlossen"></div>
          <div class="month-lbl">${m}</div>
        </div>`).join('')}
      </div>
    </div>

    ${pubEntries.length ? `<div class="stats-section">
      <h3>Verlage</h3>
      <div class="bar-chart">
        ${pubEntries.map(([p,n])=>`<div class="bar-row">
          <div class="bar-label">${p}</div>
          <div class="bar-track"><div class="bar-fill" data-style-width="${Math.round(n/maxPub*100)}%"></div></div>
          <div class="bar-val">${n}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${genreEntries.length ? `<div class="stats-section">
      <h3>Genre-Verteilung</h3>
      <div class="bar-chart">
        ${genreEntries.map(([g,n])=>`<div class="bar-row">
          <div class="bar-label">${g}</div>
          <div class="bar-track"><div class="bar-fill bar-fill-purple" data-style-width="${Math.round(n/maxGenre*100)}%"></div></div>
          <div class="bar-val">${n}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}

  </div>`;
}

// ─── Genre / Tags ─────────────────────────────────────────────────────────
let filterGenre = '';

function resolveProtectedGenres(existing) {
  return Array.isArray(existing?.genres) ? [...existing.genres] : [];
}

function resolveProtectedCover(existing) {
  return existing?.cover || null;
}

function renderGenreReadout(m) {
  const el = document.getElementById('genre-readout');
  if (!el) return;
  const genres = resolveProtectedGenres(m).filter(Boolean);
  if (!genres.length) {
    el.innerHTML = `<span class="genre-readout-empty">${escapeHtml(el.dataset.empty || 'Keine Genres vorhanden.')}</span>`;
    return;
  }
  el.innerHTML = genres
    .map(g => `<span class="genre-chip readonly">${escapeHtml(g)}</span>`)
    .join('');
}

function renderCoverReadout(m) {
  const el = document.getElementById('f-cover-auto');
  if (!el) return;
  const cover = safeHttpsUrl(resolveProtectedCover(m));
  const bandCoverCount = Object.keys(m?.bandCovers || {}).filter(k => !!m.bandCovers[k]).length;
  if (!cover && !bandCoverCount) {
    el.innerHTML = `<span class="automation-readout-empty">${escapeHtml(el.dataset.empty || 'Kein Cover vorhanden.')}</span>`;
    return;
  }
  const parts = [];
  if (cover) parts.push('Serien-Cover-Fallback vorhanden');
  if (bandCoverCount) parts.push(`${bandCoverCount} Band-Cover vorhanden`);
  el.innerHTML = `<strong>${escapeHtml(parts.join(' · '))}</strong><span>Geschützt: wird nicht mehr manuell per URL-Feld überschrieben.</span>`;
}

function updateGenreFilter() {
  const wrap = document.getElementById('genre-filter-wrap');
  const usedGenres = [...new Set(db.m.flatMap(m => m.genres||[]))].sort();
  if (!usedGenres.length || ['buy','kalender','dashboard'].includes(tab)) {
    wrap.style.display = 'none'; return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = ['', ...usedGenres].map(g =>
    `<span class="genre-filter-chip${filterGenre===g?' on':''}" data-action="set-genre-filter" data-genre="${escapeHtml(g)}">${g||'Alle'}</span>`
  ).join('');
}

function setGenreFilter(g) {
  filterGenre = g;
  render();
}

function applyGenreFilter(list) {
  if (!filterGenre) return list;
  return list.filter(m => (m.genres||[]).includes(filterGenre));
}

// ─── Publisher Filter ────────────────────────────────────────────────────
function setPubFilter(val) {
  filterPub = val;
  render();
}

function updatePubFilter() {
  const sel = document.getElementById('pub-filter');
  const cur = sel.value;
  const pubs = [...new Set(db.m.map(m => m.pub).filter(Boolean))].sort((a,b) => a.localeCompare(b,'de'));
  sel.innerHTML = '<option value="">Alle Verlage</option>' +
    pubs.map(p => `<option value="${p}"${p===cur?' selected':''}>${p}</option>`).join('');
}

function applyPubFilter(list) {
  if (!filterPub) return list;
  return list.filter(m => m.pub === filterPub);
}

// ─── Manual Sync ─────────────────────────────────────────────────────────
async function manualSync() {
  await loadFromCloud();
  toast('☁️ Daten aktualisiert');
}

// ─── Import / Export ──────────────────────────────────────────────────────
const SCHEMA_VERSION = 2;

function renderImportExport() {
  return `<div class="stats-section">
    <h3>Import / Export</h3>
    <div class="import-export-actions">
      <button class="add-btn export-json-btn" data-action="export-json">💾 JSON-Backup</button>
      <button class="add-btn import-json-btn" data-action="trigger-import">📂 Importieren</button>
      <button class="add-btn export-obsidian-btn" data-action="export-obsidian">📦 Obsidian-Export (ZIP)</button>
    </div>
    <p class="import-export-note">Vor dem Import wird automatisch ein lokales Backup heruntergeladen. Supabase bleibt die einzige Cloud-Sync-Lösung.</p>
  </div>`;
}

// A) JSON-Export
function exportJSON() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    series: db.m,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `manga-tracker-backup-${date}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('💾 Backup gespeichert');
}

// Lokales Backup vor Import als Download bereitstellen
function createLocalBackupDownload() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    series: db.m,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `manga-tracker-vor-import-${date}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// B) JSON-Import
const _VALID_IMPORT_STATUSES = ['reading', 'completed', 'owned', 'wishlist'];
const _VALID_IMPORT_BAND_STATUSES = ['owned', 'reading', 'completed'];
const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateImportEntry(entry, i) {
  if (!entry || typeof entry !== 'object') return `Eintrag ${i}: kein Objekt`;
  if (!entry.id || typeof entry.id !== 'string') return `Eintrag ${i}: id fehlt oder ungültig`;
  if (!entry.title || typeof entry.title !== 'string' || !entry.title.trim())
    return `Eintrag ${i}: title fehlt oder leer`;
  if (entry.status && !_VALID_IMPORT_STATUSES.includes(entry.status))
    return `Eintrag ${i} (\"${entry.title}\"): ungültiger Status \"${entry.status}\"`;
  if (entry.startedAt && !_DATE_RE.test(entry.startedAt))
    return `Eintrag ${i} (\"${entry.title}\"): startedAt kein ISO-Datum (YYYY-MM-DD)`;
  if (entry.finishedAt && !_DATE_RE.test(entry.finishedAt))
    return `Eintrag ${i} (\"${entry.title}\"): finishedAt kein ISO-Datum (YYYY-MM-DD)`;
  if (entry.nextDate && !_DATE_RE.test(entry.nextDate))
    return `Eintrag ${i} (\"${entry.title}\"): nextDate kein ISO-Datum (YYYY-MM-DD)`;
  if (entry.bands) {
    for (const [bandNr, status] of Object.entries(entry.bands)) {
      if (!_VALID_IMPORT_BAND_STATUSES.includes(status))
        return `Eintrag ${i} (\"${entry.title}\"): Band ${bandNr} hat ungültigen Status \"${status}\"`;
    }
  }
  return null;
}

function parseImportPayload(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error('Ungültiges JSON: ' + e.message); }

  // Unterstützte Formate:
  //   Neu:  { schemaVersion, series: [...] }
  //   Alt:  { m: [...] }
  //   Raw:  [...]
  let entries;
  if (Array.isArray(parsed.series)) {
    entries = parsed.series;
  } else if (Array.isArray(parsed.m)) {
    entries = parsed.m;
  } else if (Array.isArray(parsed)) {
    entries = parsed;
  } else {
    throw new Error('Unbekanntes Backup-Format: weder „series"- noch „m"-Array gefunden');
  }

  for (let i = 0; i < entries.length; i++) {
    const err = validateImportEntry(entries[i], i + 1);
    if (err) throw new Error(err);
  }
  return entries;
}

function triggerImport() {
  document.getElementById('import-file-input').click();
}

async function handleImportFile(input) {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  let raw;
  try { raw = await file.text(); }
  catch (e) { toast('❌ Datei konnte nicht gelesen werden'); return; }

  let entries;
  try { entries = parseImportPayload(raw); }
  catch (e) {
    toast('❌ Import fehlgeschlagen: ' + e.message);
    console.error('Manga Tracker Import-Fehler:', e);
    return;
  }

  if (!confirm(
    `Import: ${entries.length} Serie(n) aus „${file.name}" laden?\n\n` +
    `Ein lokales Backup wird vorher automatisch heruntergeladen.`
  )) return;

  // Schritt 1: Backup sichern
  createLocalBackupDownload();

  // Schritt 2: Daten übernehmen und Migrationen anwenden
  db = { m: entries };
  db.m.forEach(m => {
    if (m.wishlist === true && m.status !== 'wishlist') m.status = 'wishlist';
    delete m.wishlist;
    if (m.ongoing === true)  m.ongoing = 'true';
    if (m.ongoing === false) m.ongoing = 'false';
    if (!m.bands) {
      m.bands = {};
      const n   = Number(m.owned)   || 0;
      const cur = Number(m.current) || 0;
      const st  = m.status || 'owned';
      for (let i = 1; i <= n; i++) {
        if (st === 'completed')        m.bands[i] = 'completed';
        else if (st === 'reading') {
          if (cur > 0 && i < cur)        m.bands[i] = 'completed';
          else if (cur > 0 && i === cur) m.bands[i] = 'reading';
          else                           m.bands[i] = 'owned';
        } else { m.bands[i] = 'owned'; }
      }
    }
  });

  saveLoc();

  // Schritt 3: In Supabase synchronisieren wenn Cloud-Sync aktiv
  if (_collId && _ownerToken) {
    toast(`✅ ${entries.length} Serien importiert – synchronisiere…`);
    await pushCloud();
  }

  render();
  toast(`✅ ${entries.length} Serien importiert`);
}

// C) Obsidian/SharkMind ZIP-Export
function sanitizeFilename(str) {
  return (str || 'Unbekannt')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function buildSeriesMd(m) {
  const owned = mOwned(m);
  const status = mSeriesStatus(m);
  const total = (m.total !== null && m.total !== undefined && !isNaN(Number(m.total)) && Number(m.total) > 0)
    ? Number(m.total) : null;

  let collectionStatus = 'owned';
  if (status === 'wishlist') {
    collectionStatus = 'wishlist';
  } else if (total !== null && owned < total) {
    collectionStatus = 'missing';
  }

  const genres = (m.genres || []);
  const genresYaml = genres.length
    ? 'genres:\n' + genres.map(g => `  - ${g}`).join('\n')
    : 'genres: []';

  const bandLines = Object.entries(m.bands || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([nr, st]) => `- [[${sanitizeFilename(m.title)} Band ${nr}]] — ${ST_LABEL[st] || st}`)
    .join('\n');

  const lines = [
    '---',
    'type: manga-series',
    `title: "${escapeYamlString(m.title)}"`,
    `publisher: "${escapeYamlString(m.pub)}"`,
    `status: "${status}"`,
    `collectionStatus: "${collectionStatus}"`,
    `ownedVolumes: ${owned}`,
    `totalVolumes: ${total !== null ? total : ''}`,
    `isOngoing: ${m.ongoing === 'true' ? 'true' : m.ongoing === 'false' ? 'false' : 'unknown'}`,
    `nextReleaseDate: ${m.nextDate || ''}`,
    genresYaml,
    `startedAt: ${m.startedAt || ''}`,
    `finishedAt: ${m.finishedAt || ''}`,
    '---',
    '',
    `# ${m.title}`,
    '',
  ];
  if (m.notes) lines.push(`> ${m.notes}`, '');
  lines.push(
    `**Verlag:** ${m.pub || 'Unbekannt'}`,
    `**Bände:** ${owned}${total !== null ? ' / ' + total : ''} Bände`,
    // Phase 38: Status beschreibt den deutschsprachigen Veröffentlichungsstand.
    `**Deutschsprachige Veröffentlichung:** ${m.ongoing === 'true' ? 'Laufend (weitere DE-Bände erwartet)' : m.ongoing === 'false' ? 'Abgeschlossen (DE-Ausgabe komplett)' : 'Unbekannt (DE-Status unklar)'}`,
  );
  if (m.nextDate) lines.push(`**Nächster Band:** ${m.nextDate}`);
  if (bandLines) lines.push('', '## Bände', bandLines);
  return lines.join('\n');
}

function buildVolumeMd(m, bandNr, bandStatus) {
  const nr = Number(bandNr);
  const releaseDate = (m.nextDate && nr === (mFirstMissingBand(m) ?? mNextBand(m))) ? m.nextDate : '';
  const readAt = (bandStatus === 'completed' && m.finishedAt) ? m.finishedAt : '';

  return [
    '---',
    'type: manga-volume',
    `series: "[[${sanitizeFilename(m.title)}]]"`,
    `volumeNumber: ${nr}`,
    `readStatus: "${bandStatus}"`,
    'owned: true',
    `releaseDate: ${releaseDate}`,
    'isbn13:',
    'boughtAt:',
    `readAt: ${readAt}`,
    '---',
    '',
    `# ${m.title} Band ${nr}`,
    '',
    `**Serie:** [[${sanitizeFilename(m.title)}]]`,
    `**Status:** ${ST_LABEL[bandStatus] || bandStatus}`,
  ].join('\n');
}

function buildDashboardMd(dateLabel) {
  return `# Manga Dashboard

Generiert am ${dateLabel} mit dem Manga Tracker.

## Alle Serien

\`\`\`dataview
TABLE status, publisher, collectionStatus, ownedVolumes, totalVolumes, nextReleaseDate
FROM "Manga/Serien"
SORT file.name ASC
\`\`\`

## Alle Bände

\`\`\`dataview
TABLE series, volumeNumber, readStatus, releaseDate
FROM "Manga/Bände"
SORT series ASC, volumeNumber ASC
\`\`\`

## Aktiv lesend

\`\`\`dataview
TABLE status, ownedVolumes, totalVolumes, nextReleaseDate
FROM "Manga/Serien"
WHERE status = "reading"
SORT file.name ASC
\`\`\`

## Wunschliste

\`\`\`dataview
TABLE publisher, totalVolumes
FROM "Manga/Serien"
WHERE status = "wishlist"
SORT file.name ASC
\`\`\`
`;
}

async function exportObsidian() {
  if (typeof JSZip === 'undefined') {
    toast('❌ JSZip nicht geladen – Seite neu laden');
    return;
  }
  toast('📦 ZIP wird erstellt…');
  try {
    const zip = new JSZip();
    const mangaFolder = zip.folder('Manga');
    const serienFolder = mangaFolder.folder('Serien');
    const baendeFolder = mangaFolder.folder('Bände');

    for (const m of db.m) {
      const sfn = sanitizeFilename(m.title);
      serienFolder.file(sfn + '.md', buildSeriesMd(m));
      for (const [bandNr, bandStatus] of Object.entries(m.bands || {})) {
        baendeFolder.file(`${sfn} Band ${bandNr}.md`, buildVolumeMd(m, bandNr, bandStatus));
      }
    }

    const dateLabel = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    mangaFolder.file('Dashboard.md', buildDashboardMd(dateLabel));

    const dateStr = new Date().toISOString().slice(0, 10);
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `manga-obsidian-${dateStr}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('✅ Obsidian-Export fertig');
  } catch (e) {
    console.error('Obsidian-Export-Fehler:', e);
    toast('❌ ZIP-Fehler: ' + e.message);
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────────
function setSort(val) {
  sortMode = val;
  render();
}

function applySort(items) {
  // Sortiert in-place – alle Aufrufer übergeben frische Arrays aus .filter()/.map()
  const today = new Date(); today.setHours(0,0,0,0);
  return items.sort((a, b) => {
    if (sortMode === 'az') return a.title.localeCompare(b.title, 'de');
    if (sortMode === 'za') return b.title.localeCompare(a.title, 'de');
    if (sortMode === 'added') return (b.at || 0) - (a.at || 0);
    if (sortMode === 'next') {
      // Serien mit konkretem Datum zuerst, dann ohne Datum, dann schon erschienen
      const da = a.nextDate ? new Date(a.nextDate + 'T00:00:00') : null;
      const db_ = b.nextDate ? new Date(b.nextDate + 'T00:00:00') : null;
      const aFuture = da && da > today;
      const bFuture = db_ && db_ > today;
      if (aFuture && bFuture) return da - db_;
      if (aFuture) return -1;
      if (bFuture) return 1;
      return a.title.localeCompare(b.title, 'de');
    }
    return 0;
  });
}

// ─── Teilen ───────────────────────────────────────────────────────────────
function shareManga(id, e) {
  e.stopPropagation();
  const m = db.m.find(x => x.id === id);
  if (!m) return;
  const total = m.total ? `${m.total} Bände` : 'laufend';
  // Phase 38: DE-Veröffentlichungsstatus
  const ongoing = m.ongoing === 'true' ? 'laufend (DE) 🔄' : m.ongoing === 'false' ? 'abgeschlossen (DE) ✓' : 'unbekannt (DE) ?';
  const next = m.nextDate ? `\n📅 Nächster Band: ${new Date(m.nextDate+'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'})}` : '';
  const q = encodeURIComponent(`${m.title} Manga`);
  const text = `📚 ${m.title}\n${m.pub||'Unbekannt'} · ${total} · ${ongoing}${next}\n🔗 https://www.thalia.de/suche?sq=${q}`;
  if (navigator.share) {
    navigator.share({ title: m.title, text }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(text).then(() => toast('📋 Empfehlung kopiert!'));
  }
}

// ─── Main Render ─────────────────────────────────────────────────────────
function render() {
  const today = new Date(); today.setHours(0,0,0,0);

  // counts (derived from bands)
  const cnt = { reading:0, completed:0, owned:0, wishlist:0 };
  db.m.forEach(m => { const st = mSeriesStatus(m); if (cnt[st] !== undefined) cnt[st]++; });
  const bandCnt = countBandStatuses();
  const buyItems = toBuyList();
  const wishItems = db.m.filter(m => mSeriesStatus(m) === 'wishlist');
  // Kalender: alle Serien mit nextDate die noch kommen oder jetzt erschienen sind
  const kalItems = db.m.filter(m => m.nextDate).sort((a,b) => new Date(a.nextDate)-new Date(b.nextDate));
  document.getElementById('c-reading').textContent = bandCnt.reading;
  document.getElementById('c-completed').textContent = cnt.completed;
  document.getElementById('c-owned').textContent = bandCnt.owned;
  document.getElementById('c-wishlist').textContent = wishItems.length;
  document.getElementById('c-buy').textContent = buyItems.length;
  document.getElementById('c-kalender').textContent = kalItems.length;
  // Sidebar-Navigation (Redesign): Gesamt-/Schnellzugriff-Zähler
  const _setText = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  _setText('nav-c-library', db.m.length);
  _setText('nav-c-reading', bandCnt.reading);
  _setText('nav-c-owned', bandCnt.owned);
  _setText('nav-c-wishlist', wishItems.length);
  _setText('side-vol-total', `${db.m.reduce((s, m) => s + mOwned(m), 0)} Bände`);

  // search hint
  const hint = document.getElementById('search-hint');

  const el = document.getElementById('content');

  // Phase 52: Umschalter-Sichtbarkeit zentral aus dem aktuellen Tab ableiten.
  updateViewToggleVisibility();

  if (tab === 'dashboard') { renderDashboard(); return; }

  if (tab === 'kalender') {
    const filtered = applySearch(kalItems);
    hint.textContent = filtered.length ? `${filtered.length} Termin${filtered.length!==1?'e':''}` : '';
    if (!kalItems.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">📅</div><h3>Keine Termine</h3><p>Sobald für eine Serie ein Erscheinungsdatum bekannt ist, erscheint es hier.</p></div>`;
      return;
    }
    // Nach Monat gruppieren
    const grouped = {};
    const monate = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    filtered.forEach(m => {
      const d = new Date(m.nextDate + 'T00:00:00');
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = `${monate[d.getMonth()]} ${d.getFullYear()}`;
      if (!grouped[key]) grouped[key] = { label, items:[] };
      grouped[key].items.push(m);
    });
    let html = '';
    Object.keys(grouped).sort().forEach(key => {
      const { label, items: gi } = grouped[key];
      html += `<div class="kal-month">${label}</div>`;
      gi.forEach(m => {
        const d = new Date(m.nextDate + 'T00:00:00');
        const isAvail = d <= today;
        const day = String(d.getDate()).padStart(2,'0');
        const mon = monate[d.getMonth()].slice(0,3);
        const next = mFirstMissingBand(m) ?? mNextBand(m);
        html += `<div class="kal-row${isAvail?' kal-avail':''}" data-action="open-edit" data-manga-id="${escapeHtml(m.id)}">
          <div class="kal-date-box">
            <div class="kal-day">${isAvail ? '✓' : day}</div>
            <div class="kal-mon">${isAvail ? 'Jetzt' : mon}</div>
          </div>
          ${coverEl(m,'mini',next)}
          <div class="kal-info">
            <div class="kal-title">${m.title}</div>
            <div class="kal-sub">Band ${next} · ${m.pub||'Unbekannt'}</div>
          </div>
        </div>`;
      });
    });
    el.innerHTML = html;
    return;
  }

  if (tab === 'buy') {
    const filtered = applySearch(applySort(applyPubFilter(buyItems)));
    if (searchQ) hint.textContent = `${filtered.length} von ${buyItems.length} Ergebnis${filtered.length!==1?'se':''}`;
    else hint.textContent = '';
    if (!buyItems.length) {
      el.innerHTML = `<div class="empty">
        <div class="empty-icon">🎉</div>
        <h3>Alles auf dem neuesten Stand!</h3>
        <p>Sobald ein neuer Band einer deiner Serien erscheint, taucht er hier automatisch auf.<br>Dafür einfach die Anzahl der verfügbaren deutschen Bände aktualisieren.</p>
      </div>`;
      return;
    }
    if (searchQ && !filtered.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${escapeHtml(searchQ)}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
      return;
    }
    const avail = filtered.filter(m => !m.nextDate || new Date(m.nextDate+'T00:00:00') <= today);
    const upcoming = filtered.filter(m => m.nextDate && new Date(m.nextDate+'T00:00:00') > today);
    let html = '';
    if (avail.length) {
      html += `<div class="section-head">🟢 Jetzt erhältlich – ${avail.length} Band${avail.length>1?'e':''}</div>`;
      html += `<div class="buy-list">${avail.map(m=>buyCard(m,true)).join('')}</div>`;
    }
    if (upcoming.length) {
      html += `<div class="section-head">📅 Vorgemerkt – ${upcoming.length} Band${upcoming.length>1?'e':''}</div>`;
      html += `<div class="buy-list">${upcoming.map(m=>buyCard(m,false)).join('')}</div>`;
    }
    el.innerHTML = html;
    return;
  }

  // ── Phase 52: Bibliothekstabs mit Serien/Bänder-Umschalter ──────────────
  // reading, owned, completed und wishlist nutzen denselben Pfad und schalten
  // über den globalen viewMode zwischen Serienansicht (⊞) und Bändenansicht (☰).
  if (viewMode === 'volumes') {
    // Wunschliste (Option A): vorhandene Band-Einträge der Wunschlistenserien.
    if (tab === 'wishlist') { renderWishlistVolumes(el, hint); return; }
    // reading/owned/completed: Bände mit passendem Bandstatus (Phase-31-Verhalten).
    renderBandStatusList(tab, el, hint);
    return;
  }

  // Serienansicht (Standard) für alle vier Tabs.
  renderSeriesGrid(tab, el, hint);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────
const LIBRARY_TABS = ['reading', 'completed', 'owned', 'wishlist', 'buy'];
const TAB_TITLES = {
  reading: 'Lese ich', completed: 'Gelesen', owned: 'Zu lesen',
  wishlist: 'Wunschliste', buy: 'Zu kaufen', kalender: 'Kalender', dashboard: 'Dashboard',
};
function setTab(t) {
  tab = t;
  const inLibrary = LIBRARY_TABS.includes(t);
  // Segmentierte Regal-Leiste (nur in der Bibliothek)
  document.querySelectorAll('#tabs .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === t);
  });
  // Sidebar / Bottom-Nav aktive Zustände
  document.querySelectorAll('.nav-item, .botnav button').forEach(el => {
    const nav = el.dataset.nav;
    let active = false;
    if (nav === 'library') active = inLibrary;
    else if (nav) active = (nav === t);
    else active = (el.dataset.tab === t); // Schnellzugriff-Direktlinks
    el.classList.toggle('active', active);
  });
  // Seitentitel
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = inLibrary ? 'Bibliothek' : (TAB_TITLES[t] || 'Manga Tracker');
  // Regal-Leiste + Toolbar nur in der Bibliothek anzeigen
  const tabsEl = document.getElementById('tabs');
  if (tabsEl) tabsEl.style.display = inLibrary ? '' : 'none';
  const toolbarEl = document.getElementById('toolbar');
  if (toolbarEl) toolbarEl.style.display = inLibrary ? '' : 'none';
  // Phase 52: Umschalter-Sichtbarkeit wird zentral in render() gesetzt.
  render();
}

// ─── Modal ────────────────────────────────────────────────────────────────

// Phase 44b: Read-only Anzeige der Automationsfelder
// "Bände erschienen (DE)" und "Nächster Band erscheint (DE)" werden nicht mehr
// manuell editiert. Anzeige aus Phase-43-Daten (release-volume-counts.json,
// release-cache.json) oder Legacy-Werten als Fallback.
function renderAutomationReadout(m) {
  const totalEl = document.getElementById('f-total-auto');
  const dateEl  = document.getElementById('f-nextdate-auto');
  if (!totalEl || !dateEl) return;
  // Bände erschienen (DE)
  let totalHtml = `<span class="automation-readout-empty">Noch kein belastbarer Automationswert vorhanden.</span>`;
  if (m) {
    const count = (typeof findReleaseVolumeCountForSeries === 'function')
      ? findReleaseVolumeCountForSeries(m) : null;
    if (count && Number.isInteger(Number(count.publishedVolumesDE))) {
      const checked = count.checkedAt ? String(count.checkedAt).slice(0, 10) : '';
      totalHtml = `<div class="automation-readout-value">${escapeHtml(count.publishedVolumesDE)}</div>`
        + `<div class="automation-readout-meta">Quelle: ${escapeHtml(count.source || 'Release-Bandstand-Routine')}`
        + (checked ? ` · zuletzt geprüft ${escapeHtml(checked)}` : '')
        + `</div>`;
    } else if (m.total != null && Number.isFinite(Number(m.total)) && Number(m.total) > 0) {
      totalHtml = `<div class="automation-readout-value">${escapeHtml(m.total)}</div>`
        + `<div class="automation-readout-meta">Legacy-Wert (vor Phase 43). Wird beim Speichern erhalten, aber nicht mehr manuell aktualisiert.</div>`;
    }
  }
  totalEl.innerHTML = totalHtml;
  // Nächster Band erscheint (DE)
  let dateHtml = `<span class="automation-readout-empty">Noch kein belastbares Datum vorhanden.</span>`;
  if (m) {
    let displayDate = null;
    let source = '';
    if (typeof getReleaseTargetVolume === 'function'
        && typeof findReleaseCacheItemForVolume === 'function') {
      const target = getReleaseTargetVolume(m);
      if (target != null) {
        const cacheItem = findReleaseCacheItemForVolume(m, target);
        if (cacheItem && cacheItem.releaseDate) {
          displayDate = cacheItem.releaseDate;
          source = 'Release-Cache';
        }
      }
    }
    if (!displayDate && m.nextDate) {
      displayDate = m.nextDate;
      source = 'Legacy-Wert (vor Phase 43). Wird beim Speichern erhalten, aber nicht mehr manuell gesetzt.';
    }
    if (displayDate) {
      const human = (typeof formatGermanDate === 'function') ? formatGermanDate(displayDate) : displayDate;
      dateHtml = `<div class="automation-readout-value">${escapeHtml(human || displayDate)}</div>`
        + `<div class="automation-readout-meta">${escapeHtml(source || 'Release-Cache')}</div>`;
    }
  }
  dateEl.innerHTML = dateHtml;
}

function openAdd() {
  editId = null;
  modalBands = {};
  modalBandCovers = {};
  document.getElementById('modal-title').textContent = 'Manga hinzufügen';
  document.getElementById('f-title').value = '';
  document.getElementById('f-publisher').value = '';
  document.getElementById('f-total').value = '';
  document.getElementById('f-ongoing').value = 'true';
  document.getElementById('f-nextdate').value = '';
  renderAutomationReadout(null);
  renderCoverReadout(null);
  document.getElementById('f-notes').value = '';
  document.getElementById('f-started').value = '';
  document.getElementById('f-finished').value = '';
  document.getElementById('f-wishlist').checked = (tab === 'wishlist');
  document.getElementById('btn-del').style.display = 'none';
  renderBandMgr();
  renderGenreReadout(null);
  // Phase 15c: Release-Check-Button im Hinzufügen-Dialog ausblenden (nur bei Bearbeitung sinnvoll)
  const _btnRcAdd = document.getElementById('btn-release-check');
  if (_btnRcAdd) _btnRcAdd.style.display = 'none';
  document.getElementById('overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('f-title').focus(), 50);
}

function openEdit(id, e) {
  if (e) e.stopPropagation();
  const m = db.m.find(x => x.id === id);
  if (!m) return;
  editId = id;
  modalBands = { ...(m.bands || {}) };
  modalBandCovers = { ...(m.bandCovers || {}) };
  document.getElementById('modal-title').textContent = 'Manga bearbeiten';
  document.getElementById('f-title').value = m.title||'';
  document.getElementById('f-publisher').value = m.pub||'';
  document.getElementById('f-total').value = (m.total ?? '') === null ? '' : (m.total ?? '');
  document.getElementById('f-ongoing').value = m.ongoing??'true';
  document.getElementById('f-nextdate').value = m.nextDate??'';
  renderAutomationReadout(m);
  renderCoverReadout(m);
  document.getElementById('f-notes').value = m.notes??'';
  document.getElementById('f-started').value = m.startedAt || '';
  document.getElementById('f-finished').value = m.finishedAt || '';
  document.getElementById('f-wishlist').checked = (m.status === 'wishlist');
  document.getElementById('btn-del').style.display = 'block';
  renderBandMgr();
  renderGenreReadout(m);
  // Phase 15c: Release-Check-Button einblenden und Status aktualisieren
  const _btnRcEdit = document.getElementById('btn-release-check');
  if (_btnRcEdit) { _btnRcEdit.style.display = 'block'; updateReleaseCacheButton(); }
  document.getElementById('overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('overlay').style.display = 'none';
  editId = null;
}

function overlayClick(e) {
  if (e.target === document.getElementById('overlay')) closeModal();
}

// ─── Phase 20: Hilfsfunktionen ────────────────────────────────────────────

// Validiert und bereinigt eine Cover-URL — nur HTTPS erlaubt
function safeHttpsUrl(v) {
  if (!v || typeof v !== 'string') return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? v : '';
  } catch { return ''; }
}

// ─── Phase 21b: Public Projection ────────────────────────────────────────

/**
 * Erstellt eine sichere öffentliche Projektion der Sammlung.
 * Enthält keine privaten Felder (notes, startedAt, finishedAt, isbn13, mpEditionId, etc.)
 * Wird fuer public_data verwendet; private Felder bleiben in data.
 */
function buildPublicCollectionData(db) {
  if (!db || !Array.isArray(db.m)) return { m: [] };
  return {
    schemaVersion: db.schemaVersion || 2,
    m: db.m.map(function(m) {
      return {
        id: m.id,
        title: m.title,
        pub: m.pub || '',
        bands: m.bands || {},
        total: m.total || null,
        ongoing: m.ongoing || null,
        nextDate: m.nextDate || null,
        cover: safeHttpsUrl(m.cover),
        bandCovers: Object.fromEntries(
          Object.entries(m.bandCovers || {}).map(function([k, v]) {
            return [k, safeHttpsUrl(v)];
          }).filter(function([, v]) { return !!v; })
        ),
        genres: Array.isArray(m.genres) ? m.genres : [],
        status: m.status === 'wishlist' ? 'wishlist' : (m.status || ''),
      };
    }),
  };
}

// Erhält beim Speichern Felder, die nicht im Formular bearbeitbar sind
function mergePreservedFields(existing, entry) {
  if (!existing) return entry;
  const keys = [
    'isbn13', 'editionFingerprint', 'coverManuallySet', 'mpEditionId', 'mpVerifiedAt',
    'releaseSource', 'releaseCheckedAt', 'releaseConfidence', 'externalIds', 'volumeMeta',
  ];
  keys.forEach(function(k) {
    if (existing[k] !== undefined && entry[k] === undefined) entry[k] = existing[k];
  });
  return entry;
}

// Bestimmt den Zielband für Release-Abgleich — kapselt inline-Ausdruck
function getReleaseTargetVolume(m) {
  const firstMissing = mFirstMissingBand(m);
  const total = Number(m.total);
  const totalKnown = !isNaN(total) && total > 0;
  if (m.ongoing === 'false') return totalKnown && firstMissing !== null ? firstMissing : null;
  if (m.ongoing === 'true') return firstMissing !== null ? firstMissing : mNextBand(m);
  return totalKnown && firstMissing !== null ? firstMissing : null;
}

// ─── Duplikaterkennung ────────────────────────────────────────────────────
function normTitle(t) {
  return t.toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const dp = Array.from({length: a.length + 1}, (_, i) =>
    Array.from({length: b.length + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[a.length][b.length];
}
function findDuplicates(title) {
  const norm = normTitle(title);
  return db.m.filter(m => {
    const n = normTitle(m.title);
    if (n === norm) return true;
    if (norm.length > 4 && (n.includes(norm) || norm.includes(n))) return true;
    return norm.length > 5 && levenshtein(n, norm) <= 2;
  });
}

function doSave() {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('Bitte einen Titel eingeben.'); return; }
  if (!editId) {
    const dupes = findDuplicates(title);
    if (dupes.length > 0) {
      const names = dupes.map(d => `„${d.title}"`).join('\n');
      if (!confirm(`⚠️ Mögliches Duplikat gefunden:\n${names}\n\nTrotzdem hinzufügen?`)) return;
    }
  }
  const bands = { ...modalBands };
  const ongoing = document.getElementById('f-ongoing').value;

  // ── Auto-Setting für startedAt / finishedAt ─────────────────────────────
  // Nicht überschreiben was der User manuell eingegeben hat oder was schon im Eintrag steht
  const existing = editId ? db.m.find(x => x.id === editId) : null;

  // Phase 44b: "Bände erschienen (DE)" (total) und "Nächster Band erscheint (DE)" (nextDate)
  // werden nicht mehr aus normalen Formularfeldern gesetzt. Legacy-Werte aus dem
  // bestehenden Eintrag bleiben erhalten, dürfen aber durch das Speichern nicht
  // versehentlich überschrieben werden. Die öffentliche Automationsanzeige (Phase 43)
  // ist die fachliche Quelle für diese Werte.
  const total = (existing && existing.total != null && Number.isFinite(Number(existing.total)) && Number(existing.total) > 0)
    ? Number(existing.total)
    : null;
  const nextDate = (existing && typeof existing.nextDate === 'string' && existing.nextDate)
    ? existing.nextDate
    : null;
  const manualStarted  = document.getElementById('f-started').value || null;
  const manualFinished = document.getElementById('f-finished').value || null;
  const today = new Date().toISOString().slice(0, 10);
  const bandValues = Object.values(bands);
  const hasReadOrCompleted = bandValues.some(v => v === 'reading' || v === 'completed');
  const allCompleted = bandValues.length > 0 && bandValues.every(v => v === 'completed');
  const seriesComplete = allCompleted && ongoing === 'false' && total != null && total > 0
                         && Object.keys(bands).length >= total;

  // startedAt: heute setzen wenn Serie zum ersten Mal als „lesend" oder „gelesen" markiert wird
  let startedAt = manualStarted || existing?.startedAt || null;
  if (!startedAt && hasReadOrCompleted) startedAt = today;

  // finishedAt: heute setzen wenn alle Bände gelesen UND Serie als abgeschlossen markiert UND komplett
  let finishedAt = manualFinished || existing?.finishedAt || null;
  if (!finishedAt && seriesComplete) finishedAt = today;
  // Wenn Serie nicht mehr „komplett gelesen" ist (z.B. Band rückgängig), finishedAt nicht löschen — manuelle Korrektur möglich
  // ────────────────────────────────────────────────────────────────────────

  // Phase 44c: Der technische Serien-Cover-URL-Fallback ist kein Formularfeld mehr.
  // Speichern erhält bestehende Cover, setzt aber keinen neuen Serien-Fallback aus der Maske.
  // Band-Cover können weiterhin über dedizierte Cover-/Release-Flows gepflegt werden.
  const cover = resolveProtectedCover(existing);

  // Phase 44c: Genre/Tags sind in der Maske read-only. Bestehende kuratierte/Seed-Werte
  // bleiben erhalten; ohne stabile automatische Quelle werden keine leeren Auto-Genres
  // erfunden und keine vorhandenen Tags überschrieben.
  const genres = resolveProtectedGenres(existing);

  // bandCovers: Einträge behalten, deren Band existiert.
  // Phase 37: Zusätzlich Covers erhalten, für die kein Band-Eintrag in bands[] vorhanden war
  // (z.B. MP-geladene Covers für Wishlist-Serien ohne eigene Bände).
  const bandCovers = {};
  Object.entries(modalBandCovers).forEach(([k, v]) => {
    const bandExists = !!bands[k];
    // Cover ohne korrespondierenden Band-Eintrag erhalten, falls bereits in existing gesetzt
    // und dort ebenfalls kein Band-Eintrag vorhanden war (kein versehentliches Wiederherstellen
    // von Covers gelöschter Bände).
    const isCoverWithoutBand = !!(v && existing?.bandCovers?.[k] && !existing?.bands?.[k]);
    if ((bandExists || isCoverWithoutBand) && v) bandCovers[k] = v;
  });

  const entry = {
    id: editId || uid(),
    title,
    pub: document.getElementById('f-publisher').value,
    bands,
    bandCovers,
    owned: Object.keys(bands).length,           // Rückwärtskompatibilität
    status: document.getElementById('f-wishlist').checked ? 'wishlist' : mSeriesStatus({ bands }),
    current: mCurrent({ bands }),                // abgeleitet
    total,
    ongoing,
    nextDate,
    cover,
    notes: document.getElementById('f-notes').value.trim(),
    genres,
    startedAt,
    finishedAt,
    at: existing?.at || Date.now(),
  };
  // Phase 20: Felder erhalten, die nicht im Formular sichtbar sind (Save-Roundtrip)
  mergePreservedFields(existing, entry);
  if (editId) {
    const i = db.m.findIndex(x => x.id === editId);
    if (i !== -1) db.m[i] = entry;
  } else {
    db.m.push(entry);
  }
  persist();
  maybeRunLocalReleaseCoverageCheck(entry);
  maybeSeedCatalogFromCollection(entry);
  closeModal();
  render();
  toast(editId ? '✅ Manga aktualisiert' : `✅ „${title}" hinzugefügt`);
}

function doDelete() {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  if (!editId || !confirm('Manga wirklich löschen?')) return;
  const title = db.m.find(x=>x.id===editId)?.title||'Manga';
  db.m = db.m.filter(x => x.id !== editId);
  persist();
  closeModal();
  render();
  toast(`🗑 „${title}" gelöscht`);
}

function markBought(id, e) {
  if (e) e.stopPropagation();
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  const m = db.m.find(x => x.id === id);
  if (!m) return;
  if (!m.bands) m.bands = {};
  const nextBand = String(mFirstMissingBand(m) ?? mNextBand(m));
  m.bands[nextBand] = 'owned';
  m.owned = mOwned(m); // Rückwärtskompatibilität
  // nextDate nur löschen wenn es sich auf den gerade gekauften Band bezog;
  // danach prüfen ob Release-Cache für den neuen nächsten fehlenden Band ein Datum liefert
  m.nextDate = null;
  if (releaseCache && releaseCacheStatus === 'loaded') {
    const cacheMatches = findReleaseMatchesForSeries(m); // jetzt für neuen nächsten Band
    if (cacheMatches.length && cacheMatches[0].releaseDate) {
      m.nextDate = cacheMatches[0].releaseDate;
    }
  }
  if (m.status === 'wishlist') m.status = 'owned';
  persist();
  // Phase 36a: nach Bandkauf nächsten Zielband automatisch in Coverage-Pending aufnehmen
  maybeRunLocalReleaseCoverageCheck(m);
  maybeSeedCatalogFromCollection(m);
  render();
  toast(`✅ Band ${nextBand} von „${m.title}" zu „Zu lesen" hinzugefügt`);
}

function setBandStatus(id, bandNr, status, e) {
  if (e) e.stopPropagation();
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    return;
  }
  if (!['owned', 'reading', 'completed'].includes(status)) return;
  const m = db.m.find(x => x.id === id);
  if (!m) return;
  const numericBand = Number(bandNr);
  const nr = String(numericBand);
  if (!Number.isInteger(numericBand) || numericBand < 1 || !(m.bands || {})[nr]) return;
  m.bands[nr] = status;
  m.owned = mOwned(m);       // Rückwärtskompatibilität
  m.current = mCurrent(m);   // Rückwärtskompatibilität
  if (m.status !== 'wishlist') m.status = mSeriesStatus(m);
  persist();
  maybeSeedCatalogFromCollection(m);
  render();
  toast(`✅ Band ${nr} von „${m.title}" ist jetzt „${ST_LABEL[status] || status}"`);
}
// ─── Toast ───────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Phase 15: Release-Cache ─────────────────────────────────────────────
// Lädt data/release-cache.json read-only. Nutzerdaten werden NICHT automatisch
// verändert. Jede Übernahme erfordert Vorschau und explizite Nutzerbestätigung.

// ── 15b: Normalisierung ───────────────────────────────────────────────────

// Normalisiert einen Serientitel für den Abgleich (ähnlich mpNormTitle)
// Umlaute als Digraphen (ae/oe/ue), damit der Output mit update-release-cache.js übereinstimmt
function normalizeReleaseTitle(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Publisher-Alias-Map: normalisierter Name → kanonischer Name
const _PUB_ALIAS_MAP = {
  'carlsen':           'carlsen manga',
  'carlsen manga':     'carlsen manga',
  'tokyopop':          'tokyopop',
  'tokyo pop':         'tokyopop',
  'kaze manga':        'kaze manga',
  'kaze':              'kaze manga',
  'kazé manga':        'kaze manga',
  'kaz manga':         'kaze manga',   // nach Umlaut-Normalisierung
  'crunchyroll manga': 'crunchyroll manga',
  'crunchyroll':       'crunchyroll manga',
  'panini manga':      'panini manga',
  'panini':            'panini manga',
  'egmont manga':      'egmont manga',
  'egmont':            'egmont manga',
  'hayabusa':          'hayabusa',
  'manga cult':        'manga cult',
  'mangacult':         'manga cult',
  'altraverse':        'altraverse',
  'dokico':            'dokico',
  'mangamoon':         'mangamoon',
  'manga moon':        'mangamoon',
  'dani books':        'dani books',
  'cross cult':        'cross cult',
  'splitter verlag':   'splitter verlag',
  'splitter':          'splitter verlag',
  'yomeru':            'yomeru',
};

// Verwandte Verlagsgruppen (Serien wechseln manchmal den Verlag)
const _PUB_RELATED_GROUPS = [
  new Set(['kaze manga', 'crunchyroll manga']),
];

// Normalisiert einen Verlagsnamen und löst bekannte Aliases auf
// Umlaute als Digraphen (ae/oe/ue), konsistent mit update-release-cache.js
function normalizeReleasePublisher(value) {
  const raw = (value || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
    .replace(/[!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return _PUB_ALIAS_MAP[raw] || raw;
}

// Prüft ob zwei normalisierte Verlagsnamen matchen (inkl. verwandter Gruppen)
function _releasePubsMatch(a, b) {
  if (!a || !b) return true; // Fehlender Verlag schließt nicht aus
  if (a === b) return true;
  for (const group of _PUB_RELATED_GROUPS) {
    if (group.has(a) && group.has(b)) return true;
  }
  return false;
}

// Normalisiert und validiert ISBN-13 — gibt null zurück wenn ungültig
function normalizeIsbn13(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits.length === 13 ? digits : null;
}

// ── 15b: Browser-Validator ────────────────────────────────────────────────

// Leichtgewichtige Client-seitige Validierung (tolerant, kein harter Fehler pro Item)
function validateReleaseCacheClient(cache) {
  if (!cache || typeof cache !== 'object') {
    console.warn('[Phase 15] release-cache.json: kein gültiges Objekt');
    return false;
  }
  if (cache.schemaVersion !== 1) {
    console.warn('[Phase 15] release-cache.json: schemaVersion muss 1 sein, erhalten:', cache.schemaVersion);
    return false;
  }
  if (!Array.isArray(cache.items)) {
    console.warn('[Phase 15] release-cache.json: "items" ist kein Array');
    return false;
  }
  // Stichproben-Check — tolerant, einzelne schlechte Items werden ignoriert, nicht abgelehnt
  cache.items.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      console.warn(`[Phase 15] Item ${i}: kein Objekt, wird beim Matching ignoriert`);
      return;
    }
    if (typeof item.seriesTitle !== 'string' || !item.seriesTitle) {
      console.warn(`[Phase 15] Item ${i}: seriesTitle fehlt`);
    }
    if (typeof item.volumeNumber !== 'number' || item.volumeNumber < 1) {
      console.warn(`[Phase 15] Item ${i} ("${item.seriesTitle || '?'}"): ungültige volumeNumber`);
    }
  });
  return true;
}

// ── 15b: Laden ────────────────────────────────────────────────────────────

// Lädt data/release-cache.json read-only — ändert KEINE Nutzerdaten
async function loadReleaseCache() {
  let res;
  try {
    res = await fetch('./data/release-cache.json', { cache: 'no-store' });
  } catch (e) {
    releaseCache       = null;
    releaseCacheStatus = 'missing';
    console.warn('[Phase 15] release-cache.json nicht erreichbar — App läuft ohne Release-Cache:', e.message);
    updateReleaseCacheButton();
    return;
  }
  if (!res.ok) {
    releaseCache       = null;
    releaseCacheStatus = 'missing';
    console.warn(`[Phase 15] release-cache.json nicht gefunden (HTTP ${res.status}) — App läuft ohne Release-Cache`);
    updateReleaseCacheButton();
    return;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    releaseCache       = null;
    releaseCacheStatus = 'invalid';
    console.warn('[Phase 15] release-cache.json: ungültiges JSON —', e.message);
    updateReleaseCacheButton();
    return;
  }
  if (!validateReleaseCacheClient(data)) {
    releaseCache       = null;
    releaseCacheStatus = 'invalid';
    console.warn('[Phase 15] release-cache.json: Validierung fehlgeschlagen — App läuft ohne Release-Cache');
    updateReleaseCacheButton();
    return;
  }
  releaseCache       = data;
  releaseCacheStatus = 'loaded';
  console.info(`[Phase 15] release-cache.json geladen: ${data.items.length} Item(s), Stand: ${data.generatedAt || 'unbekannt'}`);
  updateReleaseCacheButton();
  reconcileLocalReleaseCoveragePending();
  if (tab === 'dashboard') renderDashboard();
}

// Aktualisiert Sichtbarkeit und Tooltip des Release-Check-Buttons im Modal
function updateReleaseCacheButton() {
  const btn = document.getElementById('btn-release-check');
  if (!btn) return;
  const statusLabel = {
    'not-loaded': 'noch nicht geladen',
    'missing':    'nicht gefunden',
    'invalid':    'ungültig',
    'loaded':     'geladen',
  };
  if (releaseCacheStatus === 'loaded') {
    btn.title   = `Release-Cache geladen (${releaseCache ? releaseCache.items.length : 0} Einträge) — lokale Vorschau anzeigen`;
    btn.style.opacity = '1';
  } else {
    btn.title   = `Release-Cache ${statusLabel[releaseCacheStatus] || releaseCacheStatus} — keine Vorschau möglich`;
    btn.style.opacity = '0.4';
  }
}

// ── 15c: Matching ─────────────────────────────────────────────────────────

// ─── Phase 34: Lokaler Release-Coverage-Auto-Check ───────────────────────
const LOCAL_RELEASE_COVERAGE_PENDING_KEY = 'mtReleaseCoveragePending';
const LOCAL_RELEASE_COVERAGE_SCHEMA_VERSION = 1;
const LOCAL_RELEASE_COVERAGE_SOURCE = 'local-save-coverage-check';
const LOCAL_RELEASE_COVERAGE_ALLOWED_FIELDS = new Set([
  'seriesTitle', 'normalizedSeriesTitle', 'publisher', 'normalizedPublisher',
  'volumeNumber', 'reason', 'status', 'source', 'checkedAt', 'lastSeenAt',
  'seenCount', 'resolvedAt',
]);
const LOCAL_RELEASE_COVERAGE_ALLOWED_STATUS = new Set(['pending', 'resolved', 'ignored']);

function releaseCoverageKeyFromFields(seriesTitle, publisher, volumeNumber) {
  return [
    normalizeReleaseTitle(seriesTitle || ''),
    normalizeReleasePublisher(publisher || ''),
    Number(volumeNumber),
  ].join('|');
}

function releaseCoverageKey(entry) {
  return releaseCoverageKeyFromFields(entry.seriesTitle, entry.publisher, entry.volumeNumber);
}

function sanitizeLocalReleaseCoverageItem(item) {
  if (!item || typeof item !== 'object') return null;
  const volumeNumber = Number(item.volumeNumber);
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  const seriesTitle = String(item.seriesTitle || '').trim();
  if (!seriesTitle) return null;
  const publisher = String(item.publisher || '').trim();
  const status = LOCAL_RELEASE_COVERAGE_ALLOWED_STATUS.has(item.status) ? item.status : 'pending';
  const checkedAt = item.checkedAt || new Date().toISOString();
  const sanitized = {
    seriesTitle,
    normalizedSeriesTitle: normalizeReleaseTitle(seriesTitle),
    publisher,
    normalizedPublisher: normalizeReleasePublisher(publisher),
    volumeNumber,
    reason: 'unknown-to-release-system',
    status,
    source: LOCAL_RELEASE_COVERAGE_SOURCE,
    checkedAt,
    lastSeenAt: item.lastSeenAt || checkedAt,
    seenCount: Number.isInteger(Number(item.seenCount)) && Number(item.seenCount) > 0 ? Number(item.seenCount) : 1,
  };
  if (item.resolvedAt && status === 'resolved') sanitized.resolvedAt = item.resolvedAt;
  Object.keys(sanitized).forEach(key => { if (!LOCAL_RELEASE_COVERAGE_ALLOWED_FIELDS.has(key)) delete sanitized[key]; });
  return sanitized;
}

function normalizePendingCoverageCandidate(candidate) {
  return sanitizeLocalReleaseCoverageItem(candidate);
}

function loadReleaseCoveragePendingQueue() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(LOCAL_RELEASE_COVERAGE_PENDING_KEY) || 'null');
  } catch (e) {
    parsed = null;
  }
  const rawItems = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  const items = rawItems.map(normalizePendingCoverageCandidate).filter(Boolean);
  return {
    schemaVersion: LOCAL_RELEASE_COVERAGE_SCHEMA_VERSION,
    updatedAt: parsed && parsed.updatedAt ? parsed.updatedAt : null,
    invalidCount: rawItems.length - items.length,
    items,
  };
}

function loadLocalReleaseCoveragePending() {
  return loadReleaseCoveragePendingQueue();
}

function saveLocalReleaseCoveragePending(queue) {
  if (isPublicReadOnly() || !canEditLocal()) return false;
  const clean = {
    schemaVersion: LOCAL_RELEASE_COVERAGE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    items: (queue && Array.isArray(queue.items) ? queue.items : [])
      .map(sanitizeLocalReleaseCoverageItem)
      .filter(Boolean),
  };
  localStorage.setItem(LOCAL_RELEASE_COVERAGE_PENDING_KEY, JSON.stringify(clean));
  return true;
}

function addReleaseCoverageKey(set, item) {
  if (!item || typeof item !== 'object') return;
  const volumes = Array.isArray(item.volumeNumbers) ? item.volumeNumbers : [item.volumeNumber];
  volumes.forEach(volume => {
    const n = Number(volume);
    if (!Number.isInteger(n) || n < 1) return;
    set.add(releaseCoverageKeyFromFields(item.seriesTitle || '', item.publisher || '', n));
  });
}

function getKnownReleaseCoverageKeySet(options = {}) {
  const set = new Set();
  if (releaseCache && Array.isArray(releaseCache.items)) releaseCache.items.forEach(item => addReleaseCoverageKey(set, item));
  if (releaseWatchlistData && Array.isArray(releaseWatchlistData.items)) releaseWatchlistData.items.forEach(item => addReleaseCoverageKey(set, item));
  if (releaseReviewQueueData) {
    const reviewItems = Array.isArray(releaseReviewQueueData.queue)
      ? releaseReviewQueueData.queue
      : (Array.isArray(releaseReviewQueueData.items) ? releaseReviewQueueData.items : []);
    reviewItems.forEach(item => addReleaseCoverageKey(set, item));
  }
  if (options.includePending) {
    loadLocalReleaseCoveragePending().items
      .filter(item => item.status === 'pending')
      .forEach(item => set.add(releaseCoverageKey(item)));
  }
  return set;
}

function isReleaseCoverageKnown(candidate, options = {}) {
  return getKnownReleaseCoverageKeySet(options).has(releaseCoverageKey(candidate));
}

function buildLocalReleaseCoverageCandidate(manga) {
  if (!manga || typeof manga !== 'object') return null;
  // Phase 37: Wishlist-Serien sind jetzt gültige Coverage-Kandidaten.
  // Der bewusste Ausschluss aus Phase 34 wurde aufgehoben, da die Staging-Kette
  // (Phase 36) sanitisiert ist und keine privaten Daten exportiert werden.
  // Datenschutzgrenze liegt ausschließlich im sanitisierten Export-Kandidat.
  const targetVolume = getReleaseTargetVolume(manga);
  if (targetVolume === null) return null;
  const volumeNumber = Number(targetVolume);
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  const seriesTitle = String(manga.title || '').trim();
  if (!seriesTitle) return null;
  const publisher = String(manga.pub || '').trim();
  const now = new Date().toISOString();
  return sanitizeLocalReleaseCoverageItem({
    seriesTitle,
    publisher,
    volumeNumber,
    reason: 'unknown-to-release-system',
    status: 'pending',
    source: LOCAL_RELEASE_COVERAGE_SOURCE,
    checkedAt: now,
    lastSeenAt: now,
    seenCount: 1,
  });
}

function upsertLocalReleaseCoveragePending(candidate) {
  const clean = sanitizeLocalReleaseCoverageItem(candidate);
  if (!clean) return false;
  const queue = loadLocalReleaseCoveragePending();
  const key = releaseCoverageKey(clean);
  const now = new Date().toISOString();
  const existing = queue.items.find(item => releaseCoverageKey(item) === key);
  if (existing) {
    existing.checkedAt = now;
    existing.lastSeenAt = now;
    existing.seenCount = Math.max(1, Number(existing.seenCount) || 1) + 1;
    existing.status = 'pending';
    delete existing.resolvedAt;
  } else {
    clean.checkedAt = now;
    clean.lastSeenAt = now;
    clean.seenCount = 1;
    queue.items.push(clean);
  }
  return saveLocalReleaseCoveragePending(queue);
}

function maybeRunLocalReleaseCoverageCheck(manga) {
  if (isPublicReadOnly() || !canEditLocal()) return false;
  const candidate = buildLocalReleaseCoverageCandidate(manga);
  if (!candidate) return false;
  if (isReleaseCoverageKnown(candidate, { includePending: false })) {
    reconcileLocalReleaseCoveragePending();
    return false;
  }
  const result = upsertLocalReleaseCoveragePending(candidate);
  // Phase 36a: wenn Publisher jetzt gesetzt ist, alte leere-Publisher-Kandidaten für
  // denselben Titel+Band als resolved markieren (Korrektur-Dedupe auf Storage-Ebene)
  if (candidate.publisher) {
    resolveEmptyPublisherPendingCandidates(candidate.seriesTitle, candidate.volumeNumber);
  }
  // Phase 36b: optional async submit to Supabase staging (fire-and-forget, non-blocking)
  if (result) maybeSubmitReleaseIntakeCandidate(candidate);
  return result;
}

// ── Phase 36b: Auto-Intake Submit to Supabase Staging ────────────────────────
//
// The auto-intake feature is OFF by default. The user must explicitly enable it
// via the dashboard toggle. When enabled, exportable pending candidates are
// submitted to Supabase staging as an allowlist-sanitized release intake candidate.
//
// Security guarantees:
// - Only active in cloud-owner mode (never in local-edit or public-readonly)
// - Only sends when the user has explicitly enabled the setting
// - Only sends exportable candidates (publisher set, non-dummy)
// - Phase 37: Wishlist series are allowed candidates; wishlist status is never transmitted
// - Only allowlist fields: seriesTitle, publisher, volumeNumber, sourceUrl, notes, enabled
// - Submit errors never block save, purchase, or any local operation
// - No private collection data is ever sent (see RELEASE_INTAKE_SUBMIT_ALLOWED_FIELDS)
// - Public view sends nothing and cannot enable the setting

const MT_AUTO_RELEASE_INTAKE_KEY = 'mtAutoReleaseIntake';

// Allowlist for fields that may be submitted to Supabase staging
const RELEASE_INTAKE_SUBMIT_ALLOWED_FIELDS = new Set([
  'seriesTitle', 'publisher', 'volumeNumber', 'sourceUrl', 'notes', 'enabled',
]);

function getAutoReleaseIntakeSetting() {
  try {
    return localStorage.getItem(MT_AUTO_RELEASE_INTAKE_KEY) === 'true';
  } catch (_) { return false; }
}

function setAutoReleaseIntakeSetting(value) {
  if (isPublicReadOnly()) return; // Public view may not enable this
  try {
    if (value) {
      localStorage.setItem(MT_AUTO_RELEASE_INTAKE_KEY, 'true');
    } else {
      localStorage.removeItem(MT_AUTO_RELEASE_INTAKE_KEY);
    }
  } catch (_) {}
}

// Validates that a pending candidate is safe to submit to Supabase staging.
// All conditions must be met; on any failure returns false (silent gate).
function isReleaseIntakeSendAllowed(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  // Mode guards
  if (isPublicReadOnly()) return false;
  if (!canWriteCloud()) return false;
  if (!getAutoReleaseIntakeSetting()) return false;
  // Candidate guards
  if (!candidate.publisher) return false;
  if (isPendingCoverageDummyTitle(candidate.seriesTitle)) return false;
  const vol = Number(candidate.volumeNumber);
  if (!Number.isInteger(vol) || vol < 1) return false;
  // sourceUrl must be null/undefined or a https:// URL
  if (candidate.sourceUrl !== null && candidate.sourceUrl !== undefined) {
    if (typeof candidate.sourceUrl !== 'string' || !candidate.sourceUrl.startsWith('https://')) return false;
  }
  return true;
}

// Builds a submission object containing only the allowlisted fields.
// Returns null if the candidate fails any structural requirement.
function buildIntakeSubmitCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const seriesTitle  = String(candidate.seriesTitle  || '').trim();
  const publisher    = String(candidate.publisher    || '').trim();
  const vol          = Number(candidate.volumeNumber);
  if (!seriesTitle || !publisher) return null;
  if (!Number.isInteger(vol) || vol < 1) return null;
  const sourceUrl = (typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.startsWith('https://'))
    ? candidate.sourceUrl : null;
  const notes = typeof candidate.notes === 'string' && candidate.notes
    ? candidate.notes.slice(0, 500) : null;
  // Explicit field list — never spread candidate to prevent accidental leakage
  return {
    seriesTitle,
    publisher,
    volumeNumber: vol,
    sourceUrl,
    notes,
    enabled: true,
  };
}

// Fire-and-forget async submit. Never throws, never blocks the call site.
// Phase 39b: Dual-Write — feuert sowohl den Phase-36b-Intake (release_intake_candidates)
// als auch den Phase-39b-Katalog-Intake (manga_catalog_candidates). Beide Aufrufe sind
// voneinander unabhaengig (eigene try/catch), damit ein Fehler in einem Pfad den
// anderen nicht blockiert. Der Katalog-Intake wiederholt die fachliche Signatur
// und ergaenzt 'origin', sourceKey/coverUrl bleiben null bis Provider-Anbindung greift.
function maybeSubmitReleaseIntakeCandidate(candidate) {
  if (!isReleaseIntakeSendAllowed(candidate)) return;
  const { ownerToken } = window.MangaTrackerSupabase.getOwnerState();
  if (!ownerToken) return;
  const submission = buildIntakeSubmitCandidate(candidate);
  if (!submission) return;

  // Phase 36b — bestehender Intake in release_intake_candidates
  Promise.resolve().then(async function () {
    try {
      const r = await window.MangaTrackerSupabase.submitReleaseIntakeCandidate(submission, ownerToken);
      if (r && r.result && r.result !== 'error') {
        console.info('[Phase 36b] Release intake:', r.result, submission.seriesTitle, 'Bd.', submission.volumeNumber);
      } else if (r && r.result === 'error') {
        console.warn('[Phase 36b] Release intake submit failed (non-blocking):', r.message || '');
      }
    } catch (e) {
      console.warn('[Phase 36b] Release intake submit exception (non-blocking):', String(e && e.message || e).slice(0, 200));
    }
  });

  // Phase 39b — paralleler Dual-Write in manga_catalog_candidates
  // sourceKey/releaseDate/isbn13/coverUrl bleiben hier bewusst leer; sie werden
  // erst durch Provider-/Coverage-Pfaede befuellt. origin='browser' markiert den
  // Eintrag eindeutig als Browser-Sammelfluss.
  Promise.resolve().then(async function () {
    try {
      const catalogSubmission = {
        seriesTitle:  submission.seriesTitle,
        publisher:    submission.publisher,
        volumeNumber: submission.volumeNumber,
        sourceUrl:    submission.sourceUrl,
        origin:       'browser',
      };
      const r = await window.MangaTrackerSupabase.submitMangaCatalogCandidate(catalogSubmission, ownerToken);
      if (r && r.result && r.result !== 'error') {
        console.info('[Phase 39b] Catalog intake:', r.result, catalogSubmission.seriesTitle, 'Bd.', catalogSubmission.volumeNumber);
      } else if (r && r.result === 'error') {
        console.warn('[Phase 39b] Catalog intake submit failed (non-blocking):', r.message || '');
      }
    } catch (e) {
      console.warn('[Phase 39b] Catalog intake submit exception (non-blocking):', String(e && e.message || e).slice(0, 200));
    }
  });
}

// Phase 36a: Leere-Publisher-Kandidaten aufräumen, sobald ein korrigierter Eintrag gespeichert wurde.
// Sucht nach pending-Items mit leerem publisher für denselben normalisierten Titel + Bandnummer
// und markiert sie als resolved, damit sie nicht mehr als exportierbar auftauchen.
function resolveEmptyPublisherPendingCandidates(seriesTitle, volumeNumber) {
  if (isPublicReadOnly() || !canEditLocal()) return false;
  const normTitle = normalizeReleaseTitle(seriesTitle || '');
  const vol = Number(volumeNumber);
  if (!normTitle || !Number.isInteger(vol) || vol < 1) return false;
  const queue = loadLocalReleaseCoveragePending();
  const now = new Date().toISOString();
  let changed = false;
  queue.items.forEach(item => {
    if (item.status !== 'pending') return;
    if (normalizeReleaseTitle(item.seriesTitle || '') === normTitle &&
        Number(item.volumeNumber) === vol &&
        !item.publisher) {
      item.status = 'resolved';
      item.resolvedAt = now;
      changed = true;
    }
  });
  if (changed) saveLocalReleaseCoveragePending(queue);
  return changed;
}

function reconcileLocalReleaseCoveragePending() {
  if (isPublicReadOnly() || !canEditLocal()) return false;
  const queue = loadLocalReleaseCoveragePending();
  if (!queue.items.length) return false;
  const known = getKnownReleaseCoverageKeySet({ includePending: false });
  const now = new Date().toISOString();
  let changed = false;
  queue.items.forEach(item => {
    if (item.status !== 'pending') return;
    if (known.has(releaseCoverageKey(item))) {
      item.status = 'resolved';
      item.resolvedAt = item.resolvedAt || now;
      changed = true;
    }
  });
  if (changed) saveLocalReleaseCoveragePending(queue);
  return changed;
}

function getActiveLocalReleaseCoveragePendingItems() {
  if (isPublicReadOnly() || !canEditLocal()) return [];
  return loadLocalReleaseCoveragePending().items
    .filter(item => item.status === 'pending')
    .sort((a, b) => (a.seriesTitle || '').localeCompare(b.seriesTitle || '', 'de') || a.volumeNumber - b.volumeNumber);
}

function isPendingCoverageDummyTitle(title) {
  const norm = normalizeReleaseTitle(title || '');
  return /^zzz(?:\s|-|_)*test/.test(norm) || /\btest(?:\s|-|_)*serie\b/.test(norm);
}

function mergePendingCoverageCandidate(target, item) {
  target.seenCount += Math.max(1, Number(item.seenCount) || 1);
  const first = item.checkedAt || item.lastSeenAt || target.firstSeenAt;
  const last = item.lastSeenAt || item.checkedAt || target.lastSeenAt;
  if (first && (!target.firstSeenAt || first < target.firstSeenAt)) target.firstSeenAt = first;
  if (last && (!target.lastSeenAt || last > target.lastSeenAt)) target.lastSeenAt = last;
}

function groupPendingCoverageCandidates(candidates) {
  const cleanItems = (Array.isArray(candidates) ? candidates : [])
    .map(normalizePendingCoverageCandidate)
    .filter(Boolean)
    .filter(item => item.status === 'pending');
  const exact = new Map();
  cleanItems.forEach(item => {
    const key = releaseCoverageKey(item);
    if (!exact.has(key)) {
      exact.set(key, {
        ...item,
        seenCount: Math.max(1, Number(item.seenCount) || 1),
        firstSeenAt: item.checkedAt || item.lastSeenAt || '',
        lastSeenAt: item.lastSeenAt || item.checkedAt || '',
      });
    } else {
      mergePendingCoverageCandidate(exact.get(key), item);
    }
  });

  const deduped = Array.from(exact.values());
  const titleVolumeWithPublisher = new Set();
  deduped.forEach(item => {
    if (item.publisher) titleVolumeWithPublisher.add(`${item.normalizedSeriesTitle}|${item.volumeNumber}`);
  });

  const replacementHitsByExportKey = new Map();
  const classified = deduped.map(item => {
    const titleVolumeKey = `${item.normalizedSeriesTitle}|${item.volumeNumber}`;
    let intakeStatus = 'exportable';
    let intakeReason = 'exportierbar';
    if (isPendingCoverageDummyTitle(item.seriesTitle)) {
      intakeStatus = 'ignored-dummy';
      intakeReason = 'ignoriert als Test-/Dummy-Datensatz';
    } else if (!item.publisher && titleVolumeWithPublisher.has(titleVolumeKey)) {
      intakeStatus = 'replaced-empty-publisher';
      intakeReason = 'ersetzt durch korrigierten Eintrag';
      deduped
        .filter(other => other.normalizedSeriesTitle === item.normalizedSeriesTitle && other.volumeNumber === item.volumeNumber && other.publisher)
        .forEach(other => {
          const exportKey = `${other.normalizedSeriesTitle}|${other.normalizedPublisher}`;
          replacementHitsByExportKey.set(exportKey, (replacementHitsByExportKey.get(exportKey) || 0) + 1);
        });
    } else if (!item.publisher) {
      intakeStatus = 'blocked-missing-publisher';
      intakeReason = 'blockiert wegen leerem Publisher';
    }
    return { ...item, intakeStatus, intakeReason };
  });

  const groupsByKey = new Map();
  classified.forEach(item => {
    const groupKey = item.intakeStatus === 'exportable'
      ? `${item.normalizedSeriesTitle}|${item.normalizedPublisher}`
      : `${item.normalizedSeriesTitle}|${item.normalizedPublisher}|${item.intakeStatus}`;
    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, {
        key: groupKey,
        seriesTitle: item.seriesTitle,
        publisher: item.publisher,
        normalizedSeriesTitle: item.normalizedSeriesTitle,
        normalizedPublisher: item.normalizedPublisher,
        intakeStatus: item.intakeStatus,
        intakeReason: item.intakeReason,
        volumes: [],
        seenCount: 0,
        firstSeenAt: item.firstSeenAt || '',
        lastSeenAt: item.lastSeenAt || '',
        replacedCount: 0,
        items: [],
      });
    }
    const group = groupsByKey.get(groupKey);
    if (!group.volumes.includes(item.volumeNumber)) group.volumes.push(item.volumeNumber);
    group.seenCount += Math.max(1, Number(item.seenCount) || 1);
    if (item.firstSeenAt && (!group.firstSeenAt || item.firstSeenAt < group.firstSeenAt)) group.firstSeenAt = item.firstSeenAt;
    if (item.lastSeenAt && (!group.lastSeenAt || item.lastSeenAt > group.lastSeenAt)) group.lastSeenAt = item.lastSeenAt;
    group.items.push(item);
  });

  groupsByKey.forEach(group => {
    group.volumes.sort((a, b) => a - b);
    if (group.intakeStatus === 'exportable') {
      group.replacedCount = replacementHitsByExportKey.get(`${group.normalizedSeriesTitle}|${group.normalizedPublisher}`) || 0;
    }
  });

  const groups = Array.from(groupsByKey.values()).sort((a, b) =>
    a.seriesTitle.localeCompare(b.seriesTitle, 'de') ||
    a.publisher.localeCompare(b.publisher, 'de') ||
    a.volumes[0] - b.volumes[0]
  );
  return { groups, items: classified, summary: summarizePendingCoverageCandidates(groups, classified) };
}

function summarizePendingCoverageCandidates(groups, items) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeGroups = Array.isArray(groups) ? groups : [];
  const count = status => safeItems.filter(item => item.intakeStatus === status).length;
  const lastSeenAt = safeItems.map(item => item.lastSeenAt).filter(Boolean).sort().pop() || '';
  return {
    totalCandidates: safeItems.length,
    affectedSeries: new Set(safeItems.map(item => item.normalizedSeriesTitle).filter(Boolean)).size,
    exportableCandidates: count('exportable'),
    blockedCandidates: count('blocked-missing-publisher'),
    replacedCandidates: count('replaced-empty-publisher'),
    ignoredDummyCandidates: count('ignored-dummy'),
    exportableGroups: safeGroups.filter(group => group.intakeStatus === 'exportable').length,
    lastSeenAt,
  };
}

function buildSanitizedPendingWatchlistBatch(groupsOrResult = groupPendingCoverageCandidates(getActiveLocalReleaseCoveragePendingItems())) {
  const groups = Array.isArray(groupsOrResult)
    ? groupsOrResult
    : (groupsOrResult && Array.isArray(groupsOrResult.groups) ? groupsOrResult.groups : []);
  return groups
    .filter(group => group.intakeStatus === 'exportable' && group.seriesTitle && group.publisher)
    .map(group => {
      const volumes = [...new Set(group.volumes.map(Number).filter(v => Number.isInteger(v) && v > 0))].sort((a, b) => a - b);
      if (!volumes.length) return null;
      const out = {
        seriesTitle: group.seriesTitle,
        publisher: group.publisher,
        sourceUrl: null,
        notes: group.replacedCount > 0
          ? 'Aus lokaler Release-Coverage-Pending-Queue ergänzt; Publisher manuell ergänzt.'
          : 'Aus lokaler Release-Coverage-Pending-Queue ergänzt.',
        enabled: true,
      };
      if (volumes.length === 1) out.volumeNumber = volumes[0];
      else out.volumeNumbers = volumes;
      return out;
    })
    .filter(Boolean);
}

function buildLocalReleaseCoverageWatchlistBatch(items = getActiveLocalReleaseCoveragePendingItems()) {
  return buildSanitizedPendingWatchlistBatch(groupPendingCoverageCandidates(items));
}

function renderLocalReleaseCoveragePendingSummary() {
  const intake = groupPendingCoverageCandidates(getActiveLocalReleaseCoveragePendingItems());
  const items = intake.items;
  const summary = intake.summary;
  if (!items.length) return '<div id="local-release-coverage-pending" class="dashboard-release-preview"></div>';
  const rows = intake.groups.map(group => `<div class="dashboard-release-candidate pending-intake-${escapeHtml(group.intakeStatus)}">
    <div class="dashboard-release-candidate-main">
      <strong>${escapeHtml(group.seriesTitle)}</strong>
      <span>Band/Bände ${escapeHtml(group.volumes.join(', '))}</span>
    </div>
    <div class="dashboard-release-candidate-meta">
      ${group.publisher ? `<span>${escapeHtml(group.publisher)}</span>` : '<span>Publisher fehlt</span>'}
      <span>${escapeHtml(group.intakeReason)}</span>
      <span>gesehen: ${escapeHtml(group.seenCount)}-mal</span>
      ${group.lastSeenAt ? `<span>zuletzt: ${escapeHtml(group.lastSeenAt)}</span>` : ''}
      ${group.replacedCount ? `<span>ersetzte Duplikate: ${escapeHtml(group.replacedCount)}</span>` : ''}
    </div>
  </div>`).join('');
  return `<div id="local-release-coverage-pending" class="dashboard-release-preview local-release-coverage-pending">
    <h4>Neue Release-Coverage-Kandidaten</h4>
    <div class="stat-big-grid cols-3 dashboard-action-stats">
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.totalCandidates)}</div><div class="stat-big-l">Kandidaten</div></div>
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.exportableCandidates)}</div><div class="stat-big-l">exportierbar</div></div>
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.blockedCandidates)}</div><div class="stat-big-l">blockiert</div></div>
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.replacedCandidates)}</div><div class="stat-big-l">ersetzt</div></div>
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.ignoredDummyCandidates)}</div><div class="stat-big-l">Dummy/Test ignoriert</div></div>
      <div class="stat-big-card"><div class="stat-big-n">${escapeHtml(summary.affectedSeries)}</div><div class="stat-big-l">Serien</div></div>
    </div>
    ${summary.exportableCandidates > 0 ? `<p class="release-coverage-ready-notice">✅ ${escapeHtml(String(summary.exportableCandidates))} ${summary.exportableCandidates === 1 ? 'Kandidat bereit' : 'Kandidaten bereit'} — Batch kopieren und in <code>data/release-watchlist.json</code> einfügen, damit die nächste Pipeline die Bände aufgreift.</p>` : ''}
    <p class="stats-empty-note">Lokaler, sanitisierter Export: Pending-Daten werden nur nach Validierung, Escaping und Allowlist kopierbar gemacht. Es gibt keine automatische Veröffentlichung und keinen Schreibpfad auf data/*.json, Supabase, GitHub oder GitHub Actions.</p>
    <p class="stats-empty-note">Phase-37: Wishlist-Serien mit Titel und Publisher erzeugen jetzt ebenfalls Release-Coverage-Kandidaten. Nur sanitisierte Felder (Titel, Verlag, Band) werden exportiert — kein Wishlist-/Sammlungsstatus.</p>
    <div class="dashboard-release-candidates">${rows}</div>
    <div class="dashboard-actions">
      <button type="button" class="add-btn dashboard-action-btn" data-action="copy-local-release-coverage-watchlist-batch">Sanitisierten Watchlist-Vorschlag kopieren</button>
      <button type="button" class="add-btn dashboard-action-btn" data-action="mark-reviewed-local-release-coverage-pending">Pending-Kandidaten als geprüft markieren</button>
      <button type="button" class="add-btn dashboard-action-btn" data-action="delete-local-release-coverage-pending">Pending-Kandidaten löschen</button>
    </div>
    <p class="stats-empty-note">Copy mutiert nichts. Löschen/Mark-reviewed ändert ausschließlich localStorage.mtReleaseCoveragePending.</p>
  </div>`;
}

// Phase 36b: Auto-Intake Toggle UI
// Renders the cloud-owner-only toggle for "Automatischen Release-Intake senden".
// Only shown when in cloud-owner mode. Never shown in public-readonly or local-edit.
function renderAutoReleaseIntakeToggle() {
  if (!canWriteCloud()) return '';
  const enabled = getAutoReleaseIntakeSetting();
  const statusLabel = enabled ? 'aktiv' : 'inaktiv';
  const btnLabel    = enabled ? 'Auto-Intake deaktivieren' : 'Auto-Intake aktivieren';
  return `<div class="auto-release-intake-toggle stats-empty-note">
    <strong>Automatischer Release-Intake:</strong> ${escapeHtml(statusLabel)}
    <button type="button" class="add-btn dashboard-action-btn" data-action="toggle-auto-release-intake">${escapeHtml(btnLabel)}</button>
    <span class="intake-toggle-hint">Sendet nur Titel, Verlag und Bandnummer als Release-Watchlist-Kandidat an das Supabase-Staging. Keine Besitz-, Lese-, Notiz- oder privaten Sammlungsdaten werden übertragen. Standardmäßig AUS.</span>
  </div>`;
}

function toggleAutoReleaseIntake() {
  if (!canWriteCloud()) {
    toast('🔒 Auto-Intake nur im Cloud-Owner-Modus verfügbar.');
    return;
  }
  const current = getAutoReleaseIntakeSetting();
  setAutoReleaseIntakeSetting(!current);
  render();
  toast(!current ? '✅ Auto-Intake aktiviert — neue Kandidaten werden an Staging gesendet.' : 'ℹ️ Auto-Intake deaktiviert.');
}

function copySanitizedPendingWatchlistBatch() {
  const batch = buildSanitizedPendingWatchlistBatch();
  if (!batch.length) { toast('ℹ️ Keine exportierbaren lokalen Release-Coverage-Kandidaten vorhanden.'); return; }
  const json = JSON.stringify(batch, null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(() => {
      toast(`📋 Sanitisierten Watchlist-Vorschlag (${batch.length} Einträge) kopiert.`);
    }).catch(() => toast('⚠️ Kopieren fehlgeschlagen – Browser ohne Clipboard-Zugriff.'));
  } else {
    toast('⚠️ Kopieren fehlgeschlagen – Browser ohne Clipboard-Zugriff.');
  }
}

function copyLocalReleaseCoverageWatchlistBatch() {
  copySanitizedPendingWatchlistBatch();
}

function ignoreLocalReleaseCoveragePending() {
  markReviewedLocalReleaseCoveragePending();
}

function markReviewedLocalReleaseCoveragePending() {
  if (!canEditLocal() || isPublicReadOnly()) return;
  if (!confirm('Pending-Kandidaten als geprüft markieren? Dies ändert nur localStorage.mtReleaseCoveragePending.')) return;
  const queue = loadLocalReleaseCoveragePending();
  let changed = false;
  queue.items.forEach(item => {
    if (item.status === 'pending') { item.status = 'ignored'; changed = true; }
  });
  if (changed) saveLocalReleaseCoveragePending(queue);
  render();
}

function deleteLocalReleaseCoveragePending() {
  if (!canEditLocal() || isPublicReadOnly()) return;
  if (!confirm('Alle Pending-Kandidaten löschen? Dies ändert nur localStorage.mtReleaseCoveragePending.')) return;
  const queue = loadLocalReleaseCoveragePending();
  queue.items = queue.items.filter(item => item.status !== 'pending');
  saveLocalReleaseCoveragePending(queue);
  render();
}

function clearResolvedLocalReleaseCoveragePending() {
  if (!canEditLocal() || isPublicReadOnly()) return;
  const queue = loadLocalReleaseCoveragePending();
  queue.items = queue.items.filter(item => item.status !== 'resolved');
  saveLocalReleaseCoveragePending(queue);
  render();
}
async function loadJsonReadOnly(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Phase 47: Seed real volume rows into the shared Supabase catalog candidate queue.
// This is separate from the release target check, so complete short series are not skipped.
const CATALOG_SEED_ALLOWED_RESULTS = new Set([
  'submitted', 'updated', 'already_verified', 'already_rejected',
]);
const CATALOG_SEED_BACKFILL_BATCH_SIZE = 25;
const CATALOG_SEED_BACKFILL_DELAY_MS = 400;
let _catalogBackfillRunning = false;

function catalogSeedKey(candidate) {
  return [
    normalizeReleaseTitle(candidate && candidate.seriesTitle || ''),
    normalizeReleasePublisher(candidate && candidate.publisher || ''),
    Number(candidate && candidate.volumeNumber),
  ].join('|');
}

function isCatalogSeedSendAllowed() {
  if (isPublicReadOnly()) return false;
  if (!canWriteCloud()) return false;
  if (!getAutoReleaseIntakeSetting()) return false;
  return !!(window.MangaTrackerSupabase && typeof window.MangaTrackerSupabase.submitMangaCatalogCandidate === 'function');
}

function collectCatalogSeedCandidates(manga) {
  if (!manga || typeof manga !== 'object') return [];
  const seriesTitle = String(manga.title || '').trim();
  const publisher = String(manga.pub || '').trim();
  if (!seriesTitle || !publisher) return [];
  if (isPendingCoverageDummyTitle(seriesTitle)) return [];

  const bands = manga.bands && typeof manga.bands === 'object' ? manga.bands : {};
  const volumes = Object.keys(bands)
    .map(Number)
    .filter(volume => Number.isInteger(volume) && volume >= 1)
    .sort((a, b) => a - b);

  return Array.from(new Set(volumes)).map(volumeNumber => ({
    seriesTitle,
    publisher,
    volumeNumber,
    sourceUrl: null,
    origin: 'browser',
  }));
}

function collectCatalogSeedBackfillCandidates(mangaList = db.m) {
  const byKey = new Map();
  (Array.isArray(mangaList) ? mangaList : []).forEach(manga => {
    collectCatalogSeedCandidates(manga).forEach(candidate => {
      const key = catalogSeedKey(candidate);
      if (!byKey.has(key)) byKey.set(key, candidate);
    });
  });
  return Array.from(byKey.values()).sort((a, b) =>
    normalizeReleaseTitle(a.seriesTitle).localeCompare(normalizeReleaseTitle(b.seriesTitle), 'de') ||
    normalizeReleasePublisher(a.publisher).localeCompare(normalizeReleasePublisher(b.publisher), 'de') ||
    Number(a.volumeNumber) - Number(b.volumeNumber)
  );
}

function buildCatalogSeedSubmission(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const seriesTitle = String(candidate.seriesTitle || '').trim();
  const publisher = String(candidate.publisher || '').trim();
  const volumeNumber = Number(candidate.volumeNumber);
  if (!seriesTitle || !publisher) return null;
  if (isPendingCoverageDummyTitle(seriesTitle)) return null;
  if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return null;
  return {
    seriesTitle,
    publisher,
    volumeNumber,
    sourceUrl: null,
    origin: 'browser',
  };
}

async function submitCatalogSeedCandidate(candidate, ownerToken) {
  const submission = buildCatalogSeedSubmission(candidate);
  if (!submission || !ownerToken) return { result: 'blocked' };
  try {
    const result = await window.MangaTrackerSupabase.submitMangaCatalogCandidate(submission, ownerToken);
    return result && result.result ? result : { result: 'blocked' };
  } catch (e) {
    return { result: 'error', message: String(e && e.message || e).slice(0, 200) };
  }
}

function maybeSeedCatalogFromCollection(manga) {
  if (!isCatalogSeedSendAllowed()) return false;
  const ownerState = window.MangaTrackerSupabase.getOwnerState ? window.MangaTrackerSupabase.getOwnerState() : {};
  const ownerToken = ownerState && ownerState.ownerToken;
  if (!ownerToken) return false;

  const candidates = collectCatalogSeedCandidates(manga);
  if (!candidates.length) return false;

  Promise.resolve().then(async function () {
    for (const candidate of candidates) {
      const result = await submitCatalogSeedCandidate(candidate, ownerToken);
      const resultCode = result && result.result ? result.result : 'blocked';
      if (resultCode === 'error') {
        console.warn('[Phase 47] Catalog seed failed (non-blocking):', result.message || '', candidate.seriesTitle, 'Bd.', candidate.volumeNumber);
      } else if (!CATALOG_SEED_ALLOWED_RESULTS.has(resultCode)) {
        console.info('[Phase 47] Catalog seed:', resultCode, candidate.seriesTitle, 'Bd.', candidate.volumeNumber);
      }
    }
  });

  return true;
}

function sleepCatalogSeed(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderCatalogSeedBackfillAction() {
  if (!canWriteCloud()) return '';
  const enabled = getAutoReleaseIntakeSetting();
  const candidates = collectCatalogSeedBackfillCandidates();
  const disabled = (!enabled || _catalogBackfillRunning || candidates.length === 0)
    ? ' disabled'
    : '';
  const title = !enabled
    ? ' title="Auto-Intake zuerst aktivieren"'
    : (_catalogBackfillRunning ? ' title="Backfill läuft bereits"' : '');
  const status = enabled
    ? `${candidates.length} seedbare Bände gefunden`
    : 'Auto-Intake inaktiv';
  return `<div class="catalog-seed-backfill stats-empty-note">
    <strong>Katalog-Seed:</strong> ${escapeHtml(status)}
    <button type="button" class="add-btn dashboard-action-btn" data-action="seed-catalog-backfill"${disabled}${title}>Sammlung in globalen Katalog spülen</button>
    <span class="intake-toggle-hint">Sendet nur Titel, Verlag und Bandnummer echter Band-Einträge an den Supabase-Katalog-Intake. Server-Dedup verhindert Duplikate.</span>
  </div>`;
}

async function seedCatalogBackfill() {
  if (!isCatalogSeedSendAllowed()) {
    toast('🔒 Katalog-Backfill nur im Cloud-Owner-Modus mit aktivem Auto-Intake verfügbar.');
    return;
  }
  if (_catalogBackfillRunning) {
    toast('ℹ️ Katalog-Backfill läuft bereits.');
    return;
  }
  const ownerState = window.MangaTrackerSupabase.getOwnerState ? window.MangaTrackerSupabase.getOwnerState() : {};
  const ownerToken = ownerState && ownerState.ownerToken;
  if (!ownerToken) {
    toast('🔒 Owner-Zugang fehlt.');
    return;
  }

  const candidates = collectCatalogSeedBackfillCandidates();
  if (!candidates.length) {
    toast('ℹ️ Keine seedbaren Bände gefunden.');
    return;
  }
  if (!confirm(`${candidates.length} Band-Einträge in den globalen Katalog-Intake senden?`)) return;

  _catalogBackfillRunning = true;
  renderDashboard();
  const counts = { submitted: 0, updated: 0, already_verified: 0, already_rejected: 0, blocked: 0, error: 0, other: 0 };
  try {
    for (let i = 0; i < candidates.length; i++) {
      const result = await submitCatalogSeedCandidate(candidates[i], ownerToken);
      const code = result && result.result ? result.result : 'blocked';
      if (Object.prototype.hasOwnProperty.call(counts, code)) counts[code]++;
      else counts.other++;
      if ((i + 1) % CATALOG_SEED_BACKFILL_BATCH_SIZE === 0 && i + 1 < candidates.length) {
        await sleepCatalogSeed(CATALOG_SEED_BACKFILL_DELAY_MS);
      }
    }
  } finally {
    _catalogBackfillRunning = false;
    renderDashboard();
  }

  const ok = counts.submitted + counts.updated + counts.already_verified;
  toast(`✅ Katalog-Backfill fertig: ${ok} übernommen/aktualisiert, ${counts.already_rejected} abgelehnt bekannt, ${counts.blocked + counts.error + counts.other} prüfen.`);
}

function validateReleaseVolumeCountsClient(doc) {
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1 || !Array.isArray(doc.items)) return false;
  return doc.items.every(item => item && typeof item === 'object'
    && typeof item.seriesTitle === 'string' && item.seriesTitle.trim()
    && typeof item.publisher === 'string' && item.publisher.trim()
    && Number.isInteger(item.publishedVolumesDE) && item.publishedVolumesDE >= 0
    && typeof item.source === 'string' && item.source.trim()
    && typeof item.sourceUrl === 'string' && item.sourceUrl.startsWith('https://')
    && item.confidence === 'high'
    && typeof item.checkedAt === 'string');
}

async function loadReleaseVolumeCounts() {
  try {
    const data = await loadJsonReadOnly('./data/release-volume-counts.json');
    if (!validateReleaseVolumeCountsClient(data)) throw new Error('invalid schema');
    releaseVolumeCounts = data;
    releaseVolumeCountsStatus = 'loaded';
    console.info(`[Phase 43] release-volume-counts.json geladen: ${data.items.length} Serie(n), Stand: ${data.generatedAt || 'unbekannt'}`);
  } catch (e) {
    releaseVolumeCounts = null;
    releaseVolumeCountsStatus = 'missing';
    console.warn('[Phase 43] release-volume-counts.json nicht als Read-only-Index ladbar:', e.message);
  }
  if (tab === 'dashboard') renderDashboard();
}

function findReleaseVolumeCountForSeries(m) {
  if (!releaseVolumeCounts || !Array.isArray(releaseVolumeCounts.items)) return null;
  const normT = normalizeReleaseTitle(m.title);
  const normP = normalizeReleasePublisher(m.pub || '');
  const matches = releaseVolumeCounts.items.filter(item => {
    const itemT = normalizeReleaseTitle(item.seriesTitle || '');
    const itemP = normalizeReleasePublisher(item.publisher || '');
    return normT === itemT && _releasePubsMatch(normP, itemP);
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

function findReleaseCacheItemForVolume(m, volumeNumber) {
  if (!releaseCache || !Array.isArray(releaseCache.items)) return null;
  const normT = normalizeReleaseTitle(m.title);
  const normP = normalizeReleasePublisher(m.pub || '');
  return releaseCache.items.find(item => {
    const itemT = item.normalizedSeriesTitle || normalizeReleaseTitle(item.seriesTitle || '');
    const rawP = item.normalizedPublisher || normalizeReleasePublisher(item.publisher || '');
    const itemP = _PUB_ALIAS_MAP[rawP] || rawP;
    return Number(item.volumeNumber) === Number(volumeNumber)
      && normT === itemT
      && _releasePubsMatch(normP, itemP);
  }) || null;
}

function formatGermanDate(value) {
  if (!value) return '';
  const d = new Date(value + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildPersonalReleaseVolumeFacts(m) {
  const count = findReleaseVolumeCountForSeries(m);
  if (!count) return null;
  const published = Number(count.publishedVolumesDE);
  const owned = mOwned(m);
  const firstMissing = mFirstMissingBand(m);
  const nextVolume = firstMissing !== null ? firstMissing : mNextBand(m);
  const cacheItem = findReleaseCacheItemForVolume(m, nextVolume);
  let status = 'noch kein belastbares Datum';
  if (nextVolume <= published) {
    status = 'bereits erschienen';
  } else if (cacheItem && cacheItem.releaseDate) {
    const d = new Date(cacheItem.releaseDate + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    status = d <= today ? 'bereits erschienen' : `erscheint am ${formatGermanDate(cacheItem.releaseDate)}`;
  }
  return { owned, published, nextVolume, status, source: count.source, checkedAt: count.checkedAt };
}

function buildPersonalReleaseVolumeSummary(m) {
  const facts = buildPersonalReleaseVolumeFacts(m);
  if (!facts) return '';
  return [
    `Besitze: ${escapeHtml(facts.owned)} / ${escapeHtml(facts.published)} auf Deutsch erschienen`,
    `Nächster Band für dich: Band ${escapeHtml(facts.nextVolume)}`,
    `Status: ${escapeHtml(facts.status)}`,
  ].join('<br>');
}
async function loadReleaseCoverageKnownData() {
  try {
    releaseWatchlistData = await loadJsonReadOnly('./data/release-watchlist.json');
    releaseWatchlistStatus = 'loaded';
  } catch (e) {
    releaseWatchlistData = null;
    releaseWatchlistStatus = 'missing';
    console.warn('[Phase 34] release-watchlist.json nicht als Read-only-Index ladbar:', e.message);
  }
  try {
    releaseReviewQueueData = await loadJsonReadOnly('./data/release-source-review-queue.json');
    releaseReviewQueueStatus = 'loaded';
  } catch (e) {
    releaseReviewQueueData = null;
    releaseReviewQueueStatus = 'missing';
    console.warn('[Phase 34] release-source-review-queue.json nicht als Read-only-Index ladbar:', e.message);
  }
  reconcileLocalReleaseCoveragePending();
  if (tab === 'dashboard') renderDashboard();
}

// Findet passende Cache-Einträge für einen Manga aus der Sammlung
function findReleaseMatchesForSeries(m) {
  if (!releaseCache || !Array.isArray(releaseCache.items)) return [];
  const normT      = normalizeReleaseTitle(m.title);
  const normP      = normalizeReleasePublisher(m.pub || '');
  const firstMiss  = mFirstMissingBand(m);
  // Abgeschlossene Serie ohne Lücken: kein nächster Band möglich
  if (firstMiss === null && m.ongoing === 'false') return [];
  const nextVol = firstMiss ?? mNextBand(m);

  return releaseCache.items.filter(item => {
    if (!item || typeof item !== 'object') return false;

    // Titel-Abgleich (Substring in beide Richtungen, wie upsertManga)
    const cacheT = item.normalizedSeriesTitle
      ? item.normalizedSeriesTitle
      : normalizeReleaseTitle(item.seriesTitle || '');
    const titleMatch = normT === cacheT
      || (cacheT.length >= 3 && normT.includes(cacheT))
      || (normT.length  >= 3 && cacheT.includes(normT));
    if (!titleMatch) return false;

    // Verlags-Abgleich — gespeicherten normalizedPublisher auch durch Alias-Map leiten,
    // da das Update-Script andere Zeichen entfernt (z. B. é → '') als app.js (é bleibt)
    const rawCacheP = item.normalizedPublisher
      ? item.normalizedPublisher
      : normalizeReleasePublisher(item.publisher || '');
    const cacheP = _PUB_ALIAS_MAP[rawCacheP] || rawCacheP;
    if (!_releasePubsMatch(normP, cacheP)) return false;

    // Bandnummer muss dem nächsten erwarteten Band entsprechen
    return item.volumeNumber === nextVol;
  });
}

// ── 15c: Vorschau ─────────────────────────────────────────────────────────

// Baut die HTML-Vorschau für einen Manga und seine Cache-Matches
function buildReleasePreview(m) {
  const matches = findReleaseMatchesForSeries(m);
  if (!matches.length) {
    // Serie abgeschlossen und vollständig → eigene Meldung, kein Cache-Fehler
    if (m.ongoing === 'false' && mFirstMissingBand(m) === null) {
      return `<div class="release-preview-empty">
        Serie abgeschlossen — alle ${mOwned(m)} Bände vorhanden.<br>
        <span class="release-preview-small">Kein nächster Band erwartet.</span>
      </div>`;
    }
    const nextVol = mFirstMissingBand(m) ?? mNextBand(m);
    const cacheMissReport = {
      reason: 'no-cache-entry',
      seriesTitle: m.title,
      normalizedSeriesTitle: normalizeReleaseTitle(m.title),
      publisher: m.pub || '',
      volumeNumber: nextVol,
      checkedAt: new Date().toISOString(),
      source: 'app-preview',
    };
    const reportJson = JSON.stringify(cacheMissReport, null, 2);
    return `<div class="release-preview-empty">
      Keine passenden Einträge in release-cache.json für<br>
      <strong>${escapeHtml(m.title)}</strong> Band ${escapeHtml(nextVol)} gefunden.<br>
      <span class="release-preview-small">Normalisierter Titel: "${escapeHtml(normalizeReleaseTitle(m.title))}"</span><br>
      <span class="release-preview-small">Bekannte Watchlist- und Review-Queue-Fälle werden durch die automatische Pipeline verarbeitet. Diese Modal-Ansicht ist nur Diagnose.</span>
    </div>
    <details class="cache-miss-report">
      <summary class="cache-miss-summary">Diagnose-JSON anzeigen</summary>
      <pre class="cache-miss-json">${reportJson.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <button type="button" class="copy-diagnostics-btn" data-action="copy-text" data-clipboard="${escapeHtml(reportJson)}">Diagnose-JSON kopieren</button>
    </details>`;
  }
  const confLabel = { high: '✓ Verifiziert', medium: '~ Wahrscheinlich', low: '? Unsicher' };
  return matches.map((item, idx) => {
    const hasNewDate  = !!item.releaseDate;
    const hasNewIsbn  = !!(item.isbn13 && normalizeIsbn13(item.isbn13));
    const hasNewCover = !!item.coverUrl;
    const hasCurrDate  = !!m.nextDate;
    const hasCurrIsbn  = !!m.isbn13;
    const hasCurrCover = !!(m.cover || (m.bandCovers && m.bandCovers[String(item.volumeNumber)]));
    // Checkbox-Default: AN wenn Feld leer und neuer Wert vorhanden
    const chkDate  = hasNewDate  && !hasCurrDate;
    const chkIsbn  = hasNewIsbn  && !hasCurrIsbn;
    const chkCover = hasNewCover && !hasCurrCover;
    const src = [item.sourceName, confLabel[item.confidence] || item.confidence].filter(Boolean).join(' · ');
    return `<div class="release-match-item" data-match-idx="${idx}">
      <div class="release-match-title">${escapeHtml(m.title)} — Band ${escapeHtml(item.volumeNumber)}</div>
      <div class="release-match-source">Quelle: ${escapeHtml(src)}</div>

      ${hasNewDate ? `<label class="release-check-label">
        <input type="checkbox" class="release-check-date release-field-checkbox" ${chkDate ? 'checked' : ''}>
        <span>Erscheinungsdatum:
          <span class="release-old-value${hasCurrDate ? ' old-value' : ''}">${hasCurrDate ? escapeHtml(m.nextDate) : 'leer'}</span>
          <span class="release-new-value"> → ${escapeHtml(item.releaseDate)}</span>
        </span>
      </label>` : ''}

      ${hasNewIsbn ? `<label class="release-check-label">
        <input type="checkbox" class="release-check-isbn release-field-checkbox" ${chkIsbn ? 'checked' : ''}>
        <span>ISBN-13:
          <span class="release-old-value${hasCurrIsbn ? ' old-value' : ''}">${hasCurrIsbn ? escapeHtml(m.isbn13 || 'vorhanden') : 'leer'}</span>
          <span class="release-new-value"> → ${escapeHtml(item.isbn13)}</span>
        </span>
      </label>` : ''}

      ${hasNewCover ? `<label class="release-check-label">
        <input type="checkbox" class="release-check-cover release-field-checkbox" ${chkCover ? 'checked' : ''}>
        <span>Band-Cover (Band ${item.volumeNumber}):
          <span class="release-old-value">${hasCurrCover ? 'bereits vorhanden' : 'leer'}</span>
          <span class="release-new-value"> → neues Cover</span>
        </span>
      </label>` : ''}

      ${!hasNewDate && !hasNewIsbn && !hasNewCover
        ? `<div class="release-no-fields">Keine übernehmenden Felder im Cache (Datum, ISBN und Cover sind leer).</div>`
        : ''}
    </div>`;
  }).join('<hr class="release-match-separator">');
}

// Rendert Vorschau-HTML in den Preview-Body
function renderReleasePreview(m) {
  const bodyEl = document.getElementById('release-preview-body');
  if (bodyEl) bodyEl.innerHTML = buildReleasePreview(m);
}

// Öffnet die Release-Vorschau für die aktuell im Modal geöffnete Serie
function openReleasePreviewForCurrentSeries() {
  if (!editId) { toast('⚠️ Erst eine Serie öffnen'); return; }
  if (releaseCacheStatus !== 'loaded') {
    const lbl = { 'not-loaded': 'noch nicht geladen', 'missing': 'nicht gefunden', 'invalid': 'ungültig' };
    toast(`ℹ️ Release-Cache ${lbl[releaseCacheStatus] || releaseCacheStatus} — kein Prüfen möglich`);
    return;
  }
  const m = db.m.find(x => x.id === editId);
  if (!m) return;
  _currentReleaseMatches = findReleaseMatchesForSeries(m);
  const titleEl = document.getElementById('release-preview-title');
  if (titleEl) titleEl.textContent = `Release-Cache-Vorschau: ${m.title}`;
  renderReleasePreview(m);
  document.getElementById('release-preview-overlay').style.display = 'flex';
}

// Schließt die Release-Vorschau
function closeReleasePreview() {
  const el = document.getElementById('release-preview-overlay');
  if (el) el.style.display = 'none';
  _currentReleaseMatches = [];
}

function overlayClickReleasePreview(e) {
  if (e.target === document.getElementById('release-preview-overlay')) closeReleasePreview();
}

// ── 15d: Backup ───────────────────────────────────────────────────────────

// Erstellt einen vollständigen DB-Snapshot in localStorage vor jeder Übernahme
function createReleaseUpdateBackup(reason) {
  try {
    const key = 'mangaTracker.releaseBackup.' + new Date().toISOString();
    localStorage.setItem(key, JSON.stringify({
      reason:               reason || 'release-cache-apply',
      createdAt:            new Date().toISOString(),
      seriesId:             editId || null,
      fullDatabaseSnapshot: JSON.parse(JSON.stringify(db)),
    }));
    console.info('[Phase 15] Backup erstellt:', key);
    return key;
  } catch (e) {
    console.warn('[Phase 15] Backup konnte nicht erstellt werden:', e.message);
    return null;
  }
}

// ── 15d: Übernahme ────────────────────────────────────────────────────────

// Übernimmt die vom Nutzer ausgewählten Felder — persist() erst nach Bestätigung
function applySelectedReleaseUpdates() {
  if (!canEditLocal()) {
    toast('🔒 Öffentliche Ansicht – Änderungen sind deaktiviert.');
    closeReleasePreview();
    return;
  }
  if (!editId) { closeReleasePreview(); return; }
  const m = db.m.find(x => x.id === editId);
  if (!m) { closeReleasePreview(); return; }

  const matchEls = document.querySelectorAll('.release-match-item');

  // Prüfen ob überhaupt etwas ausgewählt ist
  let anySelected = false;
  matchEls.forEach(el => {
    if (el.querySelector('.release-check-date')?.checked)  anySelected = true;
    if (el.querySelector('.release-check-isbn')?.checked)  anySelected = true;
    if (el.querySelector('.release-check-cover')?.checked) anySelected = true;
  });
  if (!anySelected) { toast('ℹ️ Keine Felder ausgewählt'); return; }

  // Backup VOR erster Änderung
  createReleaseUpdateBackup('release-cache-apply:' + (m.title || editId));

  let changed = false;
  matchEls.forEach(el => {
    const idx  = parseInt(el.dataset.matchIdx, 10);
    const item = _currentReleaseMatches[idx];
    if (!item) return;

    // Erscheinungsdatum
    if (el.querySelector('.release-check-date')?.checked && item.releaseDate) {
      m.nextDate = item.releaseDate;
      changed = true;
    }
    // ISBN-13 (Feld neu setzen, nicht überschreiben wenn bereits vorhanden und nicht ausgewählt)
    if (el.querySelector('.release-check-isbn')?.checked && item.isbn13) {
      m.isbn13 = item.isbn13;
      changed = true;
    }
    // Cover: bevorzugt als Band-Cover setzen, Serien-Cover nur als Fallback
    if (el.querySelector('.release-check-cover')?.checked && item.coverUrl) {
      if (!m.bandCovers) m.bandCovers = {};
      m.bandCovers[String(item.volumeNumber)] = item.coverUrl;
      changed = true;
    }
  });

  if (changed) {
    persist(); // Erst nach Bestätigung — greift in bestehende persist()/Cloud-Sync-Logik ein
    render();
    toast('✅ Release-Daten übernommen');
    // Datumsfeld im noch offenen Modal aktualisieren
    const ndEl = document.getElementById('f-nextdate');
    if (ndEl && m.nextDate) ndEl.value = m.nextDate;
  }

  closeReleasePreview();
}
// ─── Ende Phase 15 ────────────────────────────────────────────────────────

// ─── Seed ─────────────────────────────────────────────────────────────────
(function seedParasiteInLove() {
  const existing = db.m.find(m => m.title.toLowerCase().includes('parasite in love'));
  const seedData = {
    title: 'Parasite in Love',
    pub: 'Egmont Manga',
    status: 'reading',
    owned: 3,
    total: 3,
    current: 3,
    ongoing: 'false',
    nextDate: null,
    // German vol.1 cover via Open Library (ISBN 9783770438211)
    cover: 'https://covers.openlibrary.org/b/isbn/9783770438211-L.jpg',
    notes: 'Abgeschlossene Serie – 3 Bände (DE). Story: Sugaru Miaki, Zeichnung: Yuuki Hotate.',
  genres: ['Romance', 'Drama', 'Slice of Life'],
  };
  if (seedData.genres && seedData.genres.length) SEED_GENRES['parasite in love'] = [...seedData.genres];
  let changed = false;
  if (existing) {
    changed = setIfEmpty(existing, 'pub', seedData.pub) || changed;
    changed = setIfEmpty(existing, 'total', seedData.total) || changed;
    changed = setIfEmpty(existing, 'ongoing', seedData.ongoing) || changed;
    changed = setNextDateIfEmpty(existing, seedData.nextDate) || changed;
    changed = setIfEmpty(existing, 'cover', seedData.cover) || changed;
    changed = setIfEmpty(existing, 'notes', seedData.notes) || changed;
    if (seedData.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...seedData.genres];
      changed = true;
    }
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
    changed = true;
  }
  seedDirty = seedDirty || changed;
})();

// ─── Seed helper ─────────────────────────────────────────────────────────
// Phase 15g: Seeds ergänzen nur leere Felder; bestehende Nutzerwerte bleiben erhalten.
function upsertManga(key, data) {
  // Seed-Termine für Cloud-Merge merken (geplante Aufgabe aktualisiert nur diese)
  SEED_DATES[key] = { nextDate: data.nextDate, total: data.total, ongoing: data.ongoing };
  // Seed-Genres für Cloud-Merge merken (Einträge ohne Genres werden ergänzt)
  if (data.genres && data.genres.length) SEED_GENRES[key] = [...data.genres];
  // Bei mehreren Treffern den spezifischsten (kürzesten Titel) nehmen,
  // damit z.B. 'kaiju no.8' nicht 'Kaiju No.8 Side' trifft
  const matches = db.m.filter(m => m.title.toLowerCase().includes(key));
  const existing = matches.sort((a, b) => a.title.length - b.title.length)[0];
  let changed = false;
  if (existing) {
    changed = setIfEmpty(existing, 'pub', data.pub) || changed;
    changed = setIfEmpty(existing, 'cover', data.cover) || changed;
    changed = setIfEmpty(existing, 'notes', data.notes) || changed;
    changed = setIfEmpty(existing, 'total', data.total) || changed;
    changed = setIfEmpty(existing, 'ongoing', data.ongoing) || changed;
    changed = setNextDateIfEmpty(existing, data.nextDate) || changed;
    // Genres nur setzen wenn der Eintrag noch keine hat (manuelle Tags bleiben erhalten)
    if (data.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...data.genres];
      changed = true;
    }
  } else {
    db.m.push({ ...data, id: uid(), at: Date.now() });
    changed = true;
  }
  seedDirty = seedDirty || changed;
  return changed;
}
// ─── Seed: Wie die Götter es wollen ──────────────────────────────────────
upsertManga('wie die götter', {
  title: 'Wie die Götter es wollen', pub: 'Tokyopop',
  status: 'reading', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842082847-L.jpg',
  notes: 'Einzelband, 356 Seiten. Erschienen: Februar 2023. Von Hiroaki Iwaki & Nanashi Uematsu.',
  genres: ['Drama', 'Thriller', 'Supernatural'],
});

// ─── Seed: Vagabond Master Edition ───────────────────────────────────────
upsertManga('vagabond', {
  title: 'Vagabond – Master Edition', pub: 'Egmont Manga',
  status: 'reading', owned: 7, total: 19, current: 7,
  ongoing: 'false', nextDate: null, // Band 8 seit 07.04.2026 verfügbar
  cover: 'https://covers.openlibrary.org/b/isbn/9783755504618-L.jpg',
  notes: 'Doppelband-Edition (2-in-1). Band 8 seit 07.04.2026 verfügbar. Manga von Takehiko Inoue (auf Hiatus seit 2015, 37 Originalbände = ca. 19 ME-Bände).',
  genres: ['Seinen', 'Action', 'Drama'],
});

// ─── Seed: Uzumaki Deluxe ────────────────────────────────────────────────
upsertManga('uzumaki', {
  title: 'Uzumaki Deluxe', pub: 'Carlsen Manga',
  status: 'reading', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551757524-L.jpg',
  notes: '3-in-1 Deluxe Hardcover, 656 Seiten mit Farbseiten. Von Junji Ito.',
  genres: ['Horror', 'Supernatural', 'Mystery'],
});

// ─── Seed: Tomb Town Deluxe ──────────────────────────────────────────────
upsertManga('tomb town', {
  title: 'Tomb Town Deluxe – Der steinerne Tod', pub: 'Carlsen Manga',
  status: 'reading', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551714879-L.jpg',
  notes: 'Deluxe Einzelband, 418 Seiten. Erschienen: 29.08.2023. Von Junji Ito.',
  genres: ['Horror', 'Supernatural'],
});

// ─── Seed: Tokyo Revengers Doppelband ────────────────────────────────────
upsertManga('tokyo revengers', {
  title: 'Tokyo Revengers – Doppelband-Edition', pub: 'Carlsen Manga',
  status: 'reading', owned: 8, total: 16, current: 8,
  ongoing: 'false', nextDate: null, // Band 9+ bereits erhältlich
  cover: null,
  notes: 'Doppelband-Edition. Band 9 und weitere bereits verfügbar. Originalserie abgeschlossen (31 Bände = 16 Doppelbände). Von Ken Wakui.',
  genres: ['Shōnen', 'Action', 'Drama'],
});

// ─── Seed: Mujina into the Deep ──────────────────────────────────────────
upsertManga('mujina', {
  title: 'Mujina into the Deep', pub: 'Tokyopop',
  status: 'reading', owned: 3, total: 4, current: 3,
  ongoing: 'true', nextDate: null, // Band 4 seit April 2026 verfügbar
  cover: null,
  notes: 'Band 4 (DE) seit April 2026 verfügbar. Quartalsrhythmus. Von Inio Asano.',
  genres: ['Seinen', 'Action', 'Thriller'],
});

// ─── Seed: MoMo – the blood taker ────────────────────────────────────────
upsertManga('momo', {
  title: 'MoMo – the blood taker', pub: 'Crunchyroll Manga',
  status: 'reading', owned: 9, total: 9, current: 9,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9782889515837-L.jpg',
  notes: 'Abgeschlossen – 9 Bände. Startete bei Kazé, ab Band 4 Crunchyroll. Von Akira Sugito.',
  genres: ['Action', 'Supernatural', 'Horror'],
});

// ─── Seed: Mirai Nikki – New Edition ─────────────────────────────────────
upsertManga('mirai nikki', {
  title: 'Mirai Nikki – New Edition', pub: 'Egmont Manga',
  status: 'reading', owned: 2, total: 6, current: 2,
  ongoing: 'true', nextDate: null, // 2-in-1 Format; Band 3 April 2026 ✓, Band 4 09.06.2026
  cover: null,
  notes: '2-in-1 Doppelbände. Band 1: Dez. 2025, Band 2: Feb. 2026, Band 3: Apr. 2026. 6 Bände geplant (12 Orig.). Von Sakae Esuno.',
  genres: ['Thriller', 'Action', 'Supernatural'],
});

// ─── Seed: Mars Red ──────────────────────────────────────────────────────
upsertManga('mars red', {
  title: 'Mars Red', pub: 'Crunchyroll Manga',
  status: 'reading', owned: 3, total: 3, current: 3,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9782889516810-L.jpg',
  notes: 'Abgeschlossen – 3 Bände (DE = JP). Von KarakaraKemuri.',
  genres: ['Drama', 'Supernatural', 'Action'],
});

// ─── Seed: Maria's Judgement ─────────────────────────────────────────────
upsertManga("maria's judgement", {
  title: "Maria's Judgement", pub: 'Egmont Manga',
  status: 'reading', owned: 5, total: 6, current: 5,
  ongoing: 'true', nextDate: null, // Band 6 verschoben (Mai 2026 nicht ausgeliefert, neues Datum noch nicht angekündigt – Stand 16.05.2026)
  cover: 'https://covers.openlibrary.org/b/isbn/9783755504054-L.jpg',
  notes: '6 Bände geplant. Band 1: Dez. 2024, Band 5: 09.12.2025. Band 6 ursprünglich für 11.05.2026 angekündigt, jedoch verschoben – neues Datum noch offen. Von Kazuki & Junto Kamejima.',
  genres: ['Drama', 'Thriller'],
});

// ─── Seed: Look Back ─────────────────────────────────────────────────────
upsertManga('look back', {
  title: 'Look Back', pub: 'Egmont Manga',
  status: 'reading', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783755500933-L.jpg',
  notes: 'Einzelband, 144 Seiten. Erschienen: 12.10.2022. Von Tatsuki Fujimoto.',
  genres: ['Drama', 'Slice of Life'],
});

// ─── Seed: Lili-Men ──────────────────────────────────────────────────────
upsertManga('lili-men', {
  title: 'Lili-Men', pub: 'Egmont Manga',
  status: 'reading', owned: 5, total: 8, current: 5,
  ongoing: 'true', nextDate: null, // Band 8 (DE) erscheint 09.06.2026
  cover: null,
  notes: '13 Bände geplant (JP). Band 5: Dez. 2025. Band 6 wahrsch. März 2026. Von Takuma Tokashiki.',
  genres: ['Action', 'Supernatural', 'Horror'],
});

// ─── Seed: Kijin Gentosho: Dämonenjäger ──────────────────────────────────
upsertManga('kijin', {
  title: 'Kijin Gentosho: Dämonenjäger', pub: 'Panini Manga',
  status: 'reading', owned: 1, total: 8, current: 1,
  ongoing: 'true', nextDate: null, // Band 2–8 alle bereits verfügbar
  cover: 'https://covers.openlibrary.org/b/isbn/9783741632402-L.jpg',
  notes: 'Band 8 seit Jan. 2026 verfügbar. Band 2–8 alle erhältlich. Von Motoo Nakanishi & Yu Satomi.',
  genres: ['Action', 'Supernatural', 'Fantasy'],
});

// ─── Seed: Kaiju No.8 Side ───────────────────────────────────────────────
upsertManga('kaiju no.8 side', {
  title: 'Kaiju No.8 Side', pub: 'Crunchyroll Manga',
  status: 'reading', owned: 2, total: 2, current: 2,
  ongoing: 'false', nextDate: null,
  cover: null,
  notes: 'Abgeschlossen – 2 Bände. Spin-off über Hoshina. Start: Nov. 2024.',
  genres: ['Shōnen', 'Action', 'Sci-Fi'],
});

// ─── Seed: Kaiju No.8 ────────────────────────────────────────────────────
upsertManga('kaiju no.8', {
  title: 'Kaiju No.8', pub: 'Crunchyroll Manga',
  status: 'reading', owned: 15, total: 16, current: 15,
  ongoing: 'false', nextDate: null, // Band 16 (Finale) seit ca. März 2026 verfügbar
  cover: 'https://covers.openlibrary.org/b/isbn/9782889516717-L.jpg',
  notes: 'Abgeschlossen – 16 Bände. Band 16 (Finale) seit März 2026 verfügbar. Von Naoya Matsumoto.',
  genres: ['Shōnen', 'Action', 'Sci-Fi'],
});

// ─── Seed: Kagurabachi ───────────────────────────────────────────────────
upsertManga('kagurabachi', {
  title: 'Kagurabachi', pub: 'Carlsen Manga',
  status: 'reading', owned: 6, total: 7, current: 6,
  ongoing: 'true', nextDate: null, // Band 7 erscheint 26.05.2026!
  cover: null,
  notes: 'Band 7 erscheint 26.05.2026. Band 8: 28.07.2026. Von Takeru Hokazono.',
  genres: ['Shōnen', 'Action', 'Supernatural'],
});

// ─── Seed: Jujutsu Kaisen ────────────────────────────────────────────────
upsertManga('jujutsu kaisen', {
  title: 'Jujutsu Kaisen', pub: 'Kazé Manga',
  status: 'reading', owned: 2, total: 30, current: 1,
  ongoing: 'false', nextDate: null, // Serie abgeschlossen, Band 2–30 alle verfügbar
  cover: null,
  notes: 'Abgeschlossen – 30 Bände (inkl. Band 0). Band 2–30 alle bereits verfügbar. Von Gege Akutami.',
  genres: ['Shōnen', 'Action', 'Supernatural'],
});

// ─── Seed: Happiness ─────────────────────────────────────────────────────
upsertManga('happiness', {
  title: 'Happiness', pub: 'Manga Cult',
  status: 'reading', owned: 5, total: 5, current: 5,
  ongoing: 'false', nextDate: null,
  cover: null,
  notes: 'Abgeschlossen – 5 Doppelbände (= 10 Orig.-Bände). Von Shuzo Oshimi.',
  genres: ['Horror', 'Supernatural', 'Drama'],
});

// ─── Seed: Gute Nacht, Punpun ────────────────────────────────────────────
upsertManga('punpun', {
  title: 'Gute Nacht, Punpun', pub: 'Tokyopop',
  status: 'reading', owned: 13, total: 13, current: 13,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842006874-L.jpg',
  notes: 'Abgeschlossen – 13 Bände. Auch als Komplettbox erhältlich. Von Inio Asano.',
  genres: ['Seinen', 'Drama', 'Slice of Life'],
});

// ─── Seed: Real Account ──────────────────────────────────────────────────
upsertManga('real account', {
  title: 'Real Account', pub: 'Tokyopop',
  status: 'reading', owned: 5, total: 6, current: 5,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842072787-L.jpg',
  notes: 'DE-Ausgabe scheinbar bei Band 6 eingestellt (Band 6 vergriffen). Original JP: 24 Bände. Von Okushou & Shizumu Watanabe.',
  genres: ['Thriller', 'Mystery', 'Action'],
});

// ─── Seed: Neon Genesis Evangelion – Perfect Edition ─────────────────────
upsertManga('evangelion', {
  title: 'Neon Genesis Evangelion – Perfect Edition', pub: 'Carlsen Manga',
  status: 'reading', owned: 7, total: 7, current: 7,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551775450-L.jpg',
  notes: 'Abgeschlossene Perfect Edition – 7 Sammelbände (komplette Serie). Von Yoshiyuki Sadamoto.',
  genres: ['Mecha', 'Sci-Fi', 'Drama'],
});

// ─── Seed: Neck mich nicht, Nagatoro-san ─────────────────────────────────
upsertManga('nagatoro', {
  title: 'Neck mich nicht, Nagatoro-san', pub: 'dani books',
  status: 'reading', owned: 4, total: 6, current: 4,
  ongoing: 'true', nextDate: null, // Band 5 seit 31.03.2026 verfügbar; Band 6 Sommer 2026 (ISBN 978-3-95956-176-1)
  cover: 'https://covers.openlibrary.org/b/isbn/9783959561717-L.jpg',
  notes: 'Band 5 seit 31.03.2026 verfügbar. Von Nanashi. Auch als Special Edition + Schuber erhältlich.',
  genres: ['Romance', 'Comedy', 'Slice of Life'],
});

// ─── Seed: Reincarnated as a Sword: Another Wish ─────────────────────────
upsertManga('reincarnated as a sword', {
  title: 'Reincarnated as a Sword: Another Wish', pub: 'Dokico',
  status: 'reading', owned: 1, total: 4, current: 1,
  ongoing: 'true', nextDate: null, // Band 2: April 2026 ✓; Band 3: August 2026 (kein genauer Termin)
  cover: 'https://covers.openlibrary.org/b/isbn/9783987451750-L.jpg',
  notes: '6 Bände geplant (3-Monats-Rhythmus). Band 2: 21.04.2026 ✓. Band 3: ca. Aug. 2026. Von Yuu Tanaka & Hinako Inoue.',
  genres: ['Isekai', 'Fantasy', 'Action'],
});

// ─── Seed: Sakura – I want to eat your pancreas ──────────────────────────
upsertManga('pancreas', {
  title: 'Sakura – I want to eat your pancreas', pub: 'Carlsen Manga',
  status: 'reading', owned: 2, total: 2, current: 2,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551735794-L.jpg',
  notes: 'Abgeschlossene Serie – 2 Bände. Von Yoru Sumino & Idumi Kirihara. Neue Pearls Edition (Doppelband) erscheint 28.07.2026.',
  genres: ['Drama', 'Romance'],
});

// ─── Seed: Solo Leveling ─────────────────────────────────────────────────
upsertManga('solo leveling', {
  title: 'Solo Leveling', pub: 'Altraverse',
  status: 'reading', owned: 15, total: 15, current: 15,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783753940274-L.jpg',
  notes: 'Hauptstory abgeschlossen (15 Bände). Band 14: Nov. 2025, Band 15: 27.02.2026. Manhwa von Chugong & DUBU. Sequel: Solo Leveling: Ragnarok.',
  genres: ['Action', 'Fantasy', 'Supernatural'],
});

// ─── Seed: Spy x Family ──────────────────────────────────────────────────
upsertManga('spy x family', {
  title: 'Spy x Family', pub: 'Crunchyroll Manga',
  status: 'reading', owned: 3, total: 15, current: 3,
  ongoing: 'true', nextDate: null, // Band 4–15 alle bereits verfügbar (DE)
  cover: null,
  notes: 'Band 15 (DE) seit 03.04.2026 verfügbar. Japan: 17 Bände. Von Tatsuya Endo.',
  genres: ['Comedy', 'Action', 'Slice of Life'],
});

// ─── Seed: Takopi und die Sache mit dem Glück ────────────────────────────
upsertManga('takopi', {
  title: 'Takopi und die Sache mit dem Glück', pub: 'Hayabusa',
  status: 'reading', owned: 2, total: 2, current: 2,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551624048-L.jpg',
  notes: 'Abgeschlossene Serie – 2 Bände. Von taizan5.',
  genres: ['Drama', 'Sci-Fi'],
});

// ─── Seed: The Eminence in Shadow ────────────────────────────────────────
upsertManga('eminence in shadow', {
  title: 'The Eminence in Shadow', pub: 'Tokyopop',
  status: 'reading', owned: 8, total: 9, current: 8,
  ongoing: 'true',
  nextDate: '2026-06-01', // Band 9 ca. Sommer 2026 (Schätzung, Tokyopop-Programm Mär–Aug 2026)
  cover: 'https://covers.openlibrary.org/b/isbn/9783842097179-L.jpg',
  notes: 'Band 9 im Tokyopop-Programm Mär–Aug 2026 (ca. Juni 2026). Quartalsweise Erscheinung. Von Daisuke Aizawa & Anri Sakano.',
  genres: ['Isekai', 'Fantasy', 'Comedy'],
});

// ─── Seed: Tengu – Das Böse im Blut ─────────────────────────────────────
upsertManga('tengu', {
  title: 'Tengu – Das Böse im Blut', pub: 'Kazé Manga',
  status: 'reading', owned: 7, total: 7, current: 7,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9782832471487-L.jpg',
  notes: 'Abgeschlossene Serie – Band 7 ist der Abschlussband. Von Shinta Harekawa.',
  genres: ['Supernatural', 'Horror'],
});

// ─── Seed: The Vote ──────────────────────────────────────────────────────
upsertManga('the vote', {
  title: 'The Vote', pub: 'Hayabusa',
  status: 'reading', owned: 7, total: 7, current: 7,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551620835-L.jpg',
  notes: 'Abgeschlossene Serie, 7 Bände (DE = JP). Von Ryuya Kasai & Edogawa Edogawa. Ab 16 Jahren.',
  genres: ['Thriller', 'Drama'],
});

// ─── Seed: Witch and Hound ────────────────────────────────────────────────
(function seedWitchAndHound() {
  const existing = db.m.find(m => m.title.toLowerCase().includes('witch and hound'));
  const seedData = {
    title: 'Witch and Hound',
    pub: 'Egmont Manga',
    status: 'reading',
    owned: 2,
    total: 4,         // Band 3: 11.05.2026 (erschienen) | Band 4: 04.08.2026
    current: 2,
    ongoing: 'true',
    nextDate: '2026-08-04', // Band 4 erscheint 04.08.2026 (Band 3 am 11.05.2026 erschienen)
    cover: 'https://covers.openlibrary.org/b/isbn/9783755506485-L.jpg',
    notes: 'Band 1: 19.01.2026 | Band 2: 10.03.2026 | Band 3: 11.05.2026 | Band 4: 04.08.2026 (ISBN 978-3-7555-0748-2). Von Rainy Kamitsuki & LAM.',
  genres: ['Fantasy', 'Action', 'Romance'],
  };
  if (seedData.genres && seedData.genres.length) SEED_GENRES['witch and hound'] = [...seedData.genres];
  let changed = false;
  if (existing) {
    changed = setIfEmpty(existing, 'pub', seedData.pub) || changed;
    changed = setIfEmpty(existing, 'total', seedData.total) || changed;
    changed = setIfEmpty(existing, 'ongoing', seedData.ongoing) || changed;
    changed = setNextDateIfEmpty(existing, seedData.nextDate) || changed;
    changed = setIfEmpty(existing, 'cover', seedData.cover) || changed;
    changed = setIfEmpty(existing, 'notes', seedData.notes) || changed;
    if (seedData.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...seedData.genres];
      changed = true;
    }
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
    changed = true;
  }
  seedDirty = seedDirty || changed;
})();

// ─── Seed: Yakuza Reincarnation ──────────────────────────────────────────
(function seedYakuzaReincarnation() {
  const existing = db.m.find(m => m.title.toLowerCase().includes('yakuza reincarnation'));
  const seedData = {
    title: 'Yakuza Reincarnation',
    pub: 'Manga Cult',
    status: 'reading',
    owned: 14,
    total: 16,   // Band 15 (DE) erschienen 02.10.2025; Band 16 (DE) erscheint 11.06.2026
    current: 14,
    ongoing: 'true',
    nextDate: '2026-06-11',  // Band 16 (DE) erscheint 11.06.2026 (Quelle: cross-cult.de)
    cover: 'https://covers.openlibrary.org/b/isbn/3964337056-L.jpg',
    notes: 'Band 15 (DE) seit Okt. 2025 verfügbar. Band 16 bei cross-cult.de gelistet – Anzahl ggf. anpassen. Japan: 19+ Bände. Von Takeshi Natsuhara & Hiroki Miyashita.',
  genres: ['Isekai', 'Action', 'Comedy'],
  };
  if (seedData.genres && seedData.genres.length) SEED_GENRES['yakuza reincarnation'] = [...seedData.genres];
  let changed = false;
  if (existing) {
    changed = setIfEmpty(existing, 'pub', seedData.pub) || changed;
    changed = setIfEmpty(existing, 'total', seedData.total) || changed;
    changed = setIfEmpty(existing, 'ongoing', seedData.ongoing) || changed;
    changed = setNextDateIfEmpty(existing, seedData.nextDate) || changed;
    changed = setIfEmpty(existing, 'cover', seedData.cover) || changed;
    changed = setIfEmpty(existing, 'notes', seedData.notes) || changed;
    if (seedData.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...seedData.genres];
      changed = true;
    }
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
    changed = true;
  }
  seedDirty = seedDirty || changed;
})();

// ─── Seed: Yandere Dark Elf ───────────────────────────────────────────────
(function seedYandereDarkElf() {
  const existing = db.m.find(m => m.title.toLowerCase().includes('yandere dark elf'));
  const seedData = {
    title: 'Yandere Dark Elf',
    pub: 'MangaMoon',
    status: 'reading',
    owned: 2,
    total: 3,      // Band 3 erscheint 29.05.2026
    current: 2,
    ongoing: 'true',
    nextDate: '2026-05-29',  // Band 3 (DE)
    cover: 'https://covers.openlibrary.org/b/isbn/9783691940053-L.jpg',
    notes: 'Band 3 erscheint 29. Mai 2026 (ISBN: 978-3-69194-007-7). Von Nakanosora.',
  genres: ['Isekai', 'Romance', 'Comedy'],
  };
  if (seedData.genres && seedData.genres.length) SEED_GENRES['yandere dark elf'] = [...seedData.genres];
  let changed = false;
  if (existing) {
    changed = setIfEmpty(existing, 'pub', seedData.pub) || changed;
    changed = setIfEmpty(existing, 'total', seedData.total) || changed;
    changed = setIfEmpty(existing, 'ongoing', seedData.ongoing) || changed;
    changed = setNextDateIfEmpty(existing, seedData.nextDate) || changed;
    changed = setIfEmpty(existing, 'cover', seedData.cover) || changed;
    changed = setIfEmpty(existing, 'notes', seedData.notes) || changed;
    if (seedData.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...seedData.genres];
      changed = true;
    }
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
    changed = true;
  }
  seedDirty = seedDirty || changed;
})();

// ─── Seed: Gushing over Magical Girls ─────────────────────────────────────
upsertManga('gushing over magical girls', {
  title: 'Gushing over Magical Girls', pub: 'MangaMoon',
  status: 'reading', owned: 2, total: 4, current: 2,
  ongoing: 'true', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783691940282-L.jpg',
  notes: 'Laufende Serie bei MangaMoon. Von Akihiro Ononaka.',
  genres: ['Action', 'Fantasy', 'Drama'],
});

// ─── Seed: Goodbye, Eri ───────────────────────────────────────────────────
upsertManga('goodbye, eri', {
  title: 'Goodbye, Eri', pub: 'Egmont Manga',
  status: 'completed', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783770404278-L.jpg',
  notes: 'Einzelband. Erschienen April 2023. Von Tatsuki Fujimoto.',
  genres: ['Drama', 'Slice of Life'],
});

// ─── Seed: Gannibal ───────────────────────────────────────────────────────
upsertManga('gannibal', {
  title: 'Gannibal', pub: 'Hayabusa',
  status: 'reading', owned: 13, total: 13, current: 13,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783833246227-L.jpg',
  notes: 'Abgeschlossene Serie, 13 Bände. Von Masaaki Ninomiya.',
  genres: ['Seinen', 'Horror', 'Thriller'],
});

// ─── Seed: From the Red Fog ───────────────────────────────────────────────
upsertManga('from the red fog', {
  title: 'From the Red Fog', pub: 'Manga Cult',
  status: 'reading', owned: 1, total: 5, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783964337047-L.jpg',
  notes: 'Abgeschlossene Serie, 5 Bände. Von Mosae Nohara.',
  genres: ['Horror', 'Supernatural', 'Mystery'],
});

// ─── Seed: Frankenstein von Junji Ito ─────────────────────────────────────
upsertManga('frankenstein', {
  title: 'Frankenstein von Junji Ito', pub: 'Carlsen Manga',
  status: 'completed', owned: 1, total: 1, current: 1,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551792674-L.jpg',
  notes: 'Einzelband. Erschienen Februar 2023. ISBN: 978-3-551-79267-4. Von Junji Ito.',
  genres: ['Horror', 'Supernatural'],
});

// ─── Seed: Fairy Tail ─────────────────────────────────────────────────────
upsertManga('fairy tail', {
  title: 'Fairy Tail', pub: 'Carlsen Manga',
  status: 'reading', owned: 15, total: 63, current: 15,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551763570-L.jpg',
  notes: 'Abgeschlossene Serie, 63 Bände (DE). Von Hiro Mashima.',
  genres: ['Shōnen', 'Fantasy', 'Action'],
});

// ─── Seed: Elfen Lied ─────────────────────────────────────────────────────
upsertManga('elfen lied', {
  title: 'Elfen Lied', pub: 'Tokyopop',
  status: 'completed', owned: 6, total: 6, current: 6,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842069831-L.jpg',
  notes: 'Abgeschlossen, 6 Doppelbände (DE). Von Lynn Okamoto.',
  genres: ['Horror', 'Sci-Fi', 'Drama'],
});

// ─── Seed: Die letzte Elfe ────────────────────────────────────────────────
upsertManga('letzte elfe', {
  title: 'Die letzte Elfe', pub: 'Yomeru',
  status: 'reading', owned: 1, total: 3, current: 1,
  ongoing: 'true', nextDate: '2026-12-25', // Band 3 erscheint 25.12.2026
  cover: 'https://covers.openlibrary.org/b/isbn/9783911024549-L.jpg',
  notes: 'Band 2 (DE) erschienen 27.03.2026. Band 3: 25.12.2026. Von Waichi Shinta.',
  genres: ['Fantasy', 'Drama'],
});

// ─── Seed: Die Blutprinzessin ─────────────────────────────────────────────
upsertManga('blutprinzessin', {
  title: 'Die Blutprinzessin', pub: 'Egmont Manga',
  status: 'completed', owned: 5, total: 5, current: 5,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783770457649-L.jpg',
  notes: 'Abgeschlossene Serie, 5 Bände (DE). Von Setz Shiina.',
  genres: ['Horror', 'Supernatural', 'Drama'],
});

// ─── Seed: Demon King of God Killing ──────────────────────────────────────
upsertManga('demon king', {
  title: 'Demon King of God Killing', pub: 'Egmont Manga',
  status: 'reading', owned: 3, total: 4, current: 3,
  ongoing: 'true', nextDate: null, // Band 4 erschienen 11.05.2026; Serie laufend (JP 5+ Bände)
  cover: 'https://covers.openlibrary.org/b/isbn/9783770458417-L.jpg',
  notes: 'Band 4 erschienen 11.05.2026. Serie laufend (JP: 5+ Bände). Von Riku Misora & BUNBUN.',
  genres: ['Fantasy', 'Action'],
});

// ─── Seed: Dandadan ───────────────────────────────────────────────────────
upsertManga('dandadan', {
  title: 'Dandadan', pub: 'Kazé Manga',
  status: 'reading', owned: 20, total: 21, current: 20,
  ongoing: 'true', nextDate: null, // Band 21 erscheint 03.07.2026
  cover: 'https://covers.openlibrary.org/b/isbn/9782889517190-L.jpg',
  notes: 'Laufende Serie. Band 20 (DE) erschienen 06.03.2026. Band 21: 03.07.2026. Von Yukinobu Tatsu.',
  genres: ['Action', 'Supernatural', 'Comedy'],
});

// ─── Seed: Dai Dark ───────────────────────────────────────────────────────
upsertManga('dai dark', {
  title: 'Dai Dark', pub: 'Manga Cult',
  status: 'reading', owned: 7, total: 9, current: 7,
  ongoing: 'true', nextDate: '2026-06-11', // Band 9 erscheint 11.06.2026
  cover: 'https://covers.openlibrary.org/b/isbn/9783964337573-L.jpg',
  notes: 'Band 8 (DE) erschienen 05.02.2026. Band 9: 11.06.2026. Von Q Hayashida.',
  genres: ['Sci-Fi', 'Fantasy', 'Action'],
});

// ─── Seed: Colorless ──────────────────────────────────────────────────────
upsertManga('colorless', {
  title: 'Colorless', pub: 'Manga Cult',
  status: 'reading', owned: 2, total: 7, current: 2,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783964337313-L.jpg',
  notes: 'Abgeschlossen, 7 Bände (DE bei Manga Cult, Abschlussband August 2024). Von KENT.',
  genres: ['Action', 'Adventure', 'Drama', 'Mystery', 'Sci-Fi'],
});

// ─── Seed: CHILDEATH ──────────────────────────────────────────────────────
upsertManga('childeath', {
  title: 'CHILDEATH', pub: 'Altraverse',
  status: 'completed', owned: 3, total: 3, current: 3,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783753907314-L.jpg',
  notes: 'Abgeschlossen, 3 Bände. Band 1: Feb 2025. Von Hirokazu Mukoura.',
  genres: ['Horror', 'Drama'],
});

// ─── Seed: Chainsaw Man ───────────────────────────────────────────────────
upsertManga('chainsaw man', {
  title: 'Chainsaw Man', pub: 'Egmont Manga',
  status: 'reading', owned: 20, total: 23, current: 20,
  ongoing: 'true', nextDate: null, // Band 22 erscheint 04.08.2026
  cover: 'https://covers.openlibrary.org/b/isbn/9783770403172-L.jpg',
  notes: 'Band 21 (DE) erschienen 07.04.2026. Band 22: 04.08.2026. Serie hat 23 DE-Bände. Von Tatsuki Fujimoto.',
  genres: ['Shōnen', 'Action', 'Horror'],
});

// ─── Seed: Call of the Night ──────────────────────────────────────────────
upsertManga('call of the night', {
  title: 'Call of the Night', pub: 'Tokyopop',
  status: 'completed', owned: 20, total: 20, current: 20,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842082571-L.jpg',
  notes: 'Abgeschlossen mit Band 20 (Abschlussband, Okt 2025). Von Kotoyama.',
  genres: ['Romance', 'Supernatural', 'Comedy'],
});

// ─── Seed: Brynhildr in the Darkness ─────────────────────────────────────
upsertManga('brynhildr', {
  title: 'Brynhildr in the Darkness', pub: 'Tokyopop',
  status: 'reading', owned: 11, total: 18, current: 11,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842009240-L.jpg',
  notes: 'Abgeschlossene Serie, 18 Bände (DE). Von Lynn Okamoto.',
  genres: ['Sci-Fi', 'Horror', 'Romance'],
});

// ─── Seed: Blood on the Tracks ────────────────────────────────────────────
upsertManga('blood on the tracks', {
  title: 'Blood on the Tracks', pub: 'Manga Cult',
  status: 'completed', owned: 17, total: 17, current: 17,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783964337818-L.jpg',
  notes: 'Abgeschlossene Serie, 17 Bände (DE). Von Shuzo Oshimi.',
  genres: ['Drama', 'Thriller', 'Horror'],
});

// ─── Seed: Blood Lad EXTREME ──────────────────────────────────────────────
upsertManga('blood lad extreme', {
  title: 'Blood Lad EXTREME', pub: 'Tokyopop',
  status: 'completed', owned: 8, total: 8, current: 8,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842083479-L.jpg',
  notes: 'Abgeschlossen, 8 Sammelbände (je ~2 Originalbände, exklusive Cover & Buchrücken). Von Yuuki Kodama.',
  genres: ['Action', 'Supernatural', 'Comedy'],
});

// ─── Seed: Blood Blade ────────────────────────────────────────────────────
upsertManga('blood blade', {
  title: 'Blood Blade', pub: 'Hayabusa',
  status: 'reading', owned: 3, total: 5, current: 3,
  ongoing: 'true', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551624860-L.jpg',
  notes: 'Band 5 (DE) erscheint 30.06.2026. Band 4 bereits erhältlich. Von Sei Oma.',
  genres: ['Action', 'Supernatural', 'Horror'],
});

// ─── Seed: Berserk Master Edition ─────────────────────────────────────────
upsertManga('berserk master', {
  title: 'Berserk Master Edition', pub: 'Panini Manga',
  status: 'reading', owned: 4, total: 14, current: 4,
  ongoing: 'true', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783741641756-L.jpg',
  notes: 'Je 3 Originalbände im Hardcover. Band 5 erschienen 17.03.2026 (bereits erhältlich). Band 6: 16.06.2026. Ca. 14 ME-Bände gesamt. Von Kentaro Miura.',
  genres: ['Seinen', 'Action', 'Fantasy'],
});

// ─── Seed: August 9th, I will be eaten by you ─────────────────────────────
upsertManga('august 9th', {
  title: 'August 9th, I will be eaten by you', pub: 'Hayabusa',
  status: 'reading', owned: 4, total: 6, current: 4,
  ongoing: 'true', nextDate: '2026-12-01',
  cover: 'https://covers.openlibrary.org/b/isbn/9783551622464-L.jpg',
  notes: 'Band 6 (DE) angekündigt für Dezember 2026. Laufende Serie. Von tomomi.',
  genres: ['Horror', 'Romance', 'Drama'],
});

// ─── Seed: Attack on Titan ────────────────────────────────────────────────
upsertManga('attack on titan', {
  title: 'Attack on Titan', pub: 'Carlsen Manga',
  status: 'completed', owned: 34, total: 34, current: 34,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783551737649-L.jpg',
  notes: 'Abgeschlossene Serie, 34 Bände (DE = JP). Abschlussband erschienen 01.02.2022. Von Hajime Isayama.',
  genres: ['Shōnen', 'Action', 'Drama'],
});

// ─── Seed: Arifureta Zero ─────────────────────────────────────────────────
upsertManga('arifureta', {
  title: 'Arifureta: Der Kampf zurück in meine Welt – Zero', pub: 'Altraverse',
  status: 'reading', owned: 2, total: 8, current: 2,
  ongoing: 'true', nextDate: '2026-06-01',
  cover: 'https://covers.openlibrary.org/b/isbn/9783753907468-L.jpg',
  notes: 'Prequel-Manga, 8 Bände gesamt (JP abgeschlossen). Quartalsweise DE-Release: Band 1 Dez 2025, Band 2 Mrz 2026, Band 3 ~Jun 2026. Von Ataru Kamichi.',
  genres: ['Isekai', 'Fantasy', 'Action'],
});

// ─── Seed: Adou ───────────────────────────────────────────────────────────
upsertManga('adou', {
  title: 'Adou', pub: 'Altraverse',
  status: 'reading', owned: 2, total: 12, current: 2,
  ongoing: 'true', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783753907093-L.jpg',
  notes: 'Band 11 (DE) erschienen 23.03.2026. Serie nähert sich dem Abschluss. Band 3+ bereits erhältlich. Von Hajime Isayama Nao Emoto.',
  genres: ['Horror', 'Thriller', 'Drama'],
});

// ─── Seed: Adabana ────────────────────────────────────────────────────────
upsertManga('adabana', {
  title: 'adabana', pub: 'Tokyopop',
  status: 'completed', owned: 3, total: 3, current: 3,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783842093973-L.jpg',
  notes: 'Abgeschlossen, 3 Bände. Band 1 erschienen 14.05.2025. Von NON.',
  genres: ['Drama', 'Mystery'],
});

// ─── Seed: Isekai Soapland ───────────────────────────────────────────────
upsertManga('isekai soapland', {
  title: 'Isekai Soapland', pub: 'MangaMoon',
  status: 'reading', owned: 1, total: 8, current: 1,
  ongoing: 'true', nextDate: null,
  cover: null,
  notes: 'Band 1 April 2026, Band 2: 31.07.2026. JP 8+ Bände (Nihon Bungeisha, ab 2018). Ab 18. Von Shinobu Inokuma.',
  genres: ['Isekai', 'Comedy', 'Seinen'],
});

// ─── Seed-Phase abschließen: ein einziger localStorage-Write statt ~58 ────
// Phase 15g: Nur speichern, wenn Migration oder Seeds tatsächlich etwas geändert haben.
_seeding = false;
if (seedDirty || bootDataBefore !== JSON.stringify(db)) saveLoc();

// ─── Phase 22 → Phase 44a-followup ─────────────────────────────────────────
// Der lokale Dashboard-Button für Cache-Coverage-Diagnose und seine
// Hilfsfunktionen sind weggefallen. Source-Gaps werden ausschließlich über
// data/release-watchlist.json und data/release-source-review-queue.json
// sowie die GitHub-Action-Pipelines (Phase 25/32/42) verwaltet — eine lokale
// Coverage-Diagnose ist nicht mehr nötig.

// ─── Event-Bindings (Phase 21c: keine Inline-Script-Handler) ──────────────
function bindStaticEvents() {
  // Header buttons werden per data-action in bindDelegatedEvents behandelt.

  // Tabs
  document.getElementById('tabs')?.addEventListener('click', function(event) {
    const tabEl = event.target.closest?.('[data-tab]');
    if (!tabEl) return;
    setTab(tabEl.dataset.tab);
  });

  // Search
  document.getElementById('search-input')?.addEventListener('input', function(event) {
    onSearch(event.target.value);
  });
  // Filters
  document.getElementById('pub-filter')?.addEventListener('change', function(event) {
    setPubFilter(event.target.value);
  });
  document.getElementById('sort-select')?.addEventListener('change', function(event) {
    setSort(event.target.value);
  });

  // View toggle
  document.getElementById('view-toggle')?.addEventListener('click', function(event) {
    const btn = event.target.closest?.('[data-view]');
    if (!btn) return;
    setView(btn.dataset.view);
  });

  // Modal buttons / overlays
  document.getElementById('overlay')?.addEventListener('click', overlayClick);
  document.getElementById('release-preview-overlay')?.addEventListener('click', overlayClickReleasePreview);
  document.getElementById('import-file-input')?.addEventListener('change', function(event) {
    handleImportFile(event.target);
  });

  // Bild-Fallback ohne Inline-onerror. Error-Events bubblen nicht, daher Capture.
  document.addEventListener('error', function(event) {
    const img = event.target?.closest?.('img[data-remove-on-error]');
    if (img) img.remove();
  }, true);
}

function bindDelegatedEvents() {
  document.addEventListener('click', function(event) {
    const target = event.target.closest?.('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    switch (action) {
      case 'manual-sync':
        manualSync();
        break;
      case 'share-profile':
        shareProfile();
        break;
      case 'open-add':
        openAdd();
        break;
      case 'start-own-collection':
        startOwnCollection();
        break;
      case 'clear-search':
        clearSearch();
        break;
      case 'mp-sync-all':
        mpSyncAll();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'add-next-band':
        addNextBand();
        break;
      case 'bulk-complete':
        bulkComplete();
        break;
      case 'open-release-preview':
        openReleasePreviewForCurrentSeries();
        break;
      case 'mp-sync-one':
        mpSyncOne();
        break;
      case 'do-delete':
        doDelete();
        break;
      case 'do-save':
        doSave();
        break;
      case 'close-release-preview':
        closeReleasePreview();
        break;
      case 'apply-release-updates':
        applySelectedReleaseUpdates();
        break;
      case 'copy-local-release-coverage-watchlist-batch':
        copyLocalReleaseCoverageWatchlistBatch();
        break;
      case 'ignore-local-release-coverage-pending':
        ignoreLocalReleaseCoveragePending();
        break;
      case 'mark-reviewed-local-release-coverage-pending':
        markReviewedLocalReleaseCoveragePending();
        break;
      case 'delete-local-release-coverage-pending':
        deleteLocalReleaseCoveragePending();
        break;
      case 'clear-local-release-coverage-resolved':
        clearResolvedLocalReleaseCoveragePending();
        break;
      case 'toggle-auto-release-intake':
        toggleAutoReleaseIntake();
        break;
      case 'seed-catalog-backfill':
        seedCatalogBackfill();
        break;
      case 'set-tab':
        setTab(target.dataset.tab);
        break;
      case 'open-edit':
        openEdit(target.dataset.mangaId, event);
        break;
      case 'share-manga':
        shareManga(target.dataset.mangaId, event);
        break;
      case 'mark-bought':
        markBought(target.dataset.mangaId, event);
        break;
      case 'set-band-status':
        setBandStatus(target.dataset.mangaId, target.dataset.bandNr, target.dataset.status, event);
        break;
      case 'set-genre-filter':
        setGenreFilter(target.dataset.genre || '');
        break;
      case 'export-json':
        exportJSON();
        break;
      case 'trigger-import':
        triggerImport();
        break;
      case 'export-obsidian':
        exportObsidian();
        break;
      case 'cycle-band':
        cycleBand(target.dataset.bandNr);
        break;
      case 'edit-band-cover':
        editBandCover(target.dataset.bandNr);
        break;
      case 'remove-band':
        removeBand(target.dataset.bandNr);
        break;
      case 'copy-text':
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(target.dataset.clipboard || '')
            .then(() => toast('📋 Kopiert'))
            .catch(() => toast('⚠️ Kopieren nicht möglich'));
        }
        break;
      default:
        console.warn('Unbekannte Aktion:', action);
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────
bindStaticEvents();
bindDelegatedEvents();
render();
// Deferred-Style-Mechanik aktivieren: wendet data-style-background/-width/-height
// CSP-konform per CSSOM an (Cover-Farb-Fallbacks, Fortschrittsbalken-Breiten,
// Monats-Balkenhöhen). Ohne diesen Aufruf blieb die Funktion ungenutzt.
bindDeferredStyleObserver();
applyReadOnly();
// Phase 15b: Release-Cache laden (non-blocking; Fehler dürfen App-Start nicht blockieren)
loadReleaseCache().catch(e => console.warn('[Phase 15] Unerwarteter Ladefehler:', e));
loadReleaseCoverageKnownData().catch(e => console.warn('[Phase 34] Release-System-Index nicht vollständig ladbar:', e));
loadReleaseVolumeCounts().catch(e => console.warn('[Phase 43] Release-Volume-Counts nicht ladbar:', e));
if (_viewColl) {
  // Öffentliche Ansicht: fremde Sammlung laden (immer read-only)
  loadViewCollection();
} else if (_collId) {
  // Eigene Cloud-Daten laden – ohne Owner-Token bleibt der Modus read-only,
  // gesteuert ueber die readOnly-Konstante und die RLS-Policy.
  loadFromCloud();
} else if (SupabaseAdapter.hasValidSession && SupabaseAdapter.hasValidSession()) {
  // Phase 51: angemeldeter Owner auf frischem Browser ohne Adopt-Link. Die an
  // auth.uid() gebundene Sammlung per Session finden, ID lokal merken und laden.
  discoverAndLoadOwnCollection();
} else {
  // Kein Cloud-Sync konfiguriert: rein lokale Sammlung. Adopt-Link auf einem
  // Owner-Geraet einmalig oeffnen, um mtCollId + mtOwnerToken zu setzen.
  setSyncStatus('💾', 'Lokal – kein Cloud-Sync (Adopt-Link öffnen)');
}

// Phase 51: Sammlungs-Discovery für angemeldete Owner ohne lokale Collection-ID.
async function discoverAndLoadOwnCollection() {
  setSyncStatus('🔄', 'Sammlung wird gesucht…');
  try {
    const ids = await SupabaseAdapter.fetchMyCollectionIds();
    if (ids && ids.length) {
      _collId = ids[0];
      try { localStorage.setItem('mtCollId', _collId); } catch (_) {}
      await loadFromCloud();
    } else {
      setSyncStatus('💾', 'Angemeldet – keine eigene Sammlung gefunden (zuerst „Sammlung übernehmen“)');
    }
  } catch (e) {
    console.warn('[Phase 51] Sammlungs-Discovery fehlgeschlagen:', e && e.message);
    setSyncStatus('⚠️', 'Sammlung konnte nicht gefunden werden');
  }
}

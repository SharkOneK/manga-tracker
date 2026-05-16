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
// Seed-Termine: von upsertManga() befüllt, überschreiben Cloud-Daten beim Laden
// → die geplante Aufgabe aktualisiert nur den HTML-Seed, kein JSONBin-Zugriff nötig
const SEED_DATES = {};
// Seed-Genres: werden nach Cloud-Load auf Einträge ohne Genres angewandt,
// damit neue HTML-Genres auch in der bereits in der Cloud existierenden Sammlung greifen
const SEED_GENRES = {};

function setSyncStatus(icon, tip) {
  const el = document.getElementById('sync-dot');
  if (el) { el.textContent = icon; el.title = tip; }
}

function saveLoc() { localStorage.setItem('mtDE', JSON.stringify(db)); }

function persist() {
  if (_seeding) return; // Seeds werden gebündelt am Ende geschrieben
  saveLoc();
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
  if (readOnly) return;
  if (!_collId || !_ownerToken) return;
  if (!validateDatabase()) { setSyncStatus('⚠️', 'Daten ungültig – Sync übersprungen'); return; }
  setSyncStatus('🔄', 'Synchronisiert…');
  try {
    await SupabaseAdapter.patchCollection(_collId, _ownerToken, db);
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
      // Seed-Termine immer aktuell halten: HTML-Seed schlägt Cloud-Daten
      db.m.forEach(m => {
        const titleLc = m.title.toLowerCase();
        const dateKey = Object.keys(SEED_DATES).find(k => titleLc.includes(k));
        if (dateKey) {
          const s = SEED_DATES[dateKey];
          if (s.nextDate !== null && s.nextDate !== undefined) m.nextDate = s.nextDate;
          m.total = s.total;
          m.ongoing = s.ongoing;
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

// ─── Modal Band-Manager state ──────────────────────────────────────────────
let modalBands = {};
let modalBandCovers = {};
const ST_LABEL = { owned: '📚 Zu lesen', reading: '📖 Lese ich', completed: '✅ Gelesen' };
const ST_CYCLE = { owned: 'reading', reading: 'completed', completed: 'owned' };

function renderBandMgr() {
  const c = document.getElementById('band-mgr');
  const sorted = Object.entries(modalBands).sort(([a],[b]) => Number(a)-Number(b));
  if (!sorted.length) {
    c.innerHTML = `<div style="color:var(--text-muted);font-size:0.78rem;padding:6px 0">Noch keine Bände eingetragen</div>`;
    return;
  }
  c.innerHTML = sorted.map(([nr, st]) => {
    const cov = modalBandCovers[nr] || '';
    const hasCov = !!cov;
    const tip = hasCov ? ('Cover ändern – aktuell: ' + cov) : ('Cover-URL für Band ' + nr + ' setzen');
    return `<div class="band-row">
      <span class="band-nr">Band ${nr}</span>
      <button type="button" class="band-status-btn st-${st}" onclick="cycleBand('${nr}')">${ST_LABEL[st]}</button>
      <button type="button" class="band-cover-btn${hasCov ? ' has-cover' : ''}" onclick="editBandCover('${nr}')" title="${tip.replace(/"/g,'&quot;')}">🖼️</button>
      <button type="button" class="band-remove-btn" onclick="removeBand('${nr}')" title="Entfernen">✕</button>
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
  if (_mpBusy) return;
  _mpBusy = true;
  const btn = document.getElementById('btn-mp-sync');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
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
  if (btn) { btn.disabled = false; btn.textContent = '🖼️'; }
  _mpBusy = false;
}

// ─── State ────────────────────────────────────────────────────────────────
let tab = 'reading';
let editId = null;
let searchQ = '';
let viewMode = 'series'; // 'series' | 'volumes'
let sortMode = 'az';     // 'az' | 'za' | 'next' | 'added'
let filterPub = '';      // Verlagsfilter

function setView(mode) {
  viewMode = mode;
  document.getElementById('vbtn-series').classList.toggle('active', mode === 'series');
  document.getElementById('vbtn-volumes').classList.toggle('active', mode === 'volumes');
  document.getElementById('view-toggle').style.display = (tab === 'buy' || tab === 'wishlist') ? 'none' : 'flex';
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
function toBuyList() {
  const today = new Date(); today.setHours(0,0,0,0);
  return db.m
    .filter(m => {
      const total = Number(m.total);
      const owned = mOwned(m);
      return !isNaN(total) && total > 0 && total > owned;
    })
    .map(m => ({ ...m, next: mNextBand(m) }))
    .sort((a, b) => {
      // available first, then by date, then alpha
      const da = a.nextDate ? new Date(a.nextDate) : null;
      const db2 = b.nextDate ? new Date(b.nextDate) : null;
      const aAvail = !da || da <= today;
      const bAvail = !db2 || db2 <= today;
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return 1;
      if (da && db2) return da - db2;
      if (da && !db2) return -1;
      if (!da && db2) return 1;
      return a.title.localeCompare(b.title, 'de');
    });
}

// ─── Volume list helpers ──────────────────────────────────────────────────
function bandStatus(m, bandNr) {
  return (m.bands || {})[String(bandNr)] || 'owned';
}

function volumeRow(v) {
  const c = colorFor(v.title);
  const bandCover = (v.bandCovers || {})[String(v._band)] || v.cover;
  return `<div class="vol-row" onclick="openEdit('${v.id}')">
    <div class="vol-cover" style="background:${c}">
      ${bandCover ? `<img src="${bandCover}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div class="vol-cover-gradient"></div>
      <div class="vol-band-badge">Band ${v._band}</div>
    </div>
    <div class="vol-info">
      <div class="vol-title">${v.title}</div>
      <div class="vol-pub">${v.pub || ''}</div>
    </div>
  </div>`;
}

// ─── Render helpers ───────────────────────────────────────────────────────
function coverEl(m, size = 'full', bandNr = null) {
  const c = colorFor(m.title);
  const bc = m.bandCovers || {};
  // Serienansicht (bandNr=null): Band-1-Cover bevorzugen, sonst Serien-Fallback
  const img = bandNr ? (bc[String(bandNr)] || m.cover)
                     : (bc['1'] || m.cover);
  if (size === 'full') {
    return `<div class="cover" style="background:${c}">
      ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div class="cover-gradient"></div>
    </div>`;
  }
  return `<div class="mini-cover" style="background:${c}">
    ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.remove()">` : ''}
  </div>`;
}

function mangaCard(m) {
  const total = Number(m.total);
  const owned = mOwned(m);
  const cur   = mCurrent(m);
  const hasProg = !isNaN(total) && total > 0;
  const prog = hasProg ? Math.min(100, Math.round(owned / total * 100)) : 0;
  const volText = hasProg ? `${owned} / ${total} Bände` : `${owned} Bände`;
  const statusPill = m.ongoing === 'true'
    ? '<span class="ongoing-pill">laufend</span>'
    : '<span class="done-pill">abgeschlossen</span>';
  const readingBadge = cur ? `<div class="reading-badge">Band ${cur}</div>` : '';
  const wishBadge = mSeriesStatus(m) === 'wishlist' ? `<div class="wishlist-badge">💜 Wunsch</div>` : '';

  return `<div class="manga-card"${readOnly ? '' : ` onclick="openEdit('${m.id}')"`}>
    <div style="position:relative">
      ${coverEl(m)}
      ${readingBadge}
      ${wishBadge}
    </div>
    <div class="card-info">
      <div class="card-title">${m.title}</div>
      <div class="card-pub">${m.pub || 'Unbekannt'} ${statusPill}</div>
      <div class="card-vols">${volText}</div>
      ${hasProg ? `<div class="progress"><div class="progress-fill" style="width:${prog}%"></div></div>` : ''}
      ${(m.genres||[]).length ? `<div class="card-genres">${(m.genres).map(g=>`<span class="card-genre">${g}</span>`).join('')}</div>` : ''}
      ${(m.startedAt||m.finishedAt) ? `<div class="card-dates">${m.startedAt?'📖 '+new Date(m.startedAt+'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}):''}${m.startedAt&&m.finishedAt?' – ':''}${m.finishedAt?'✅ '+new Date(m.finishedAt+'T00:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}):''}</div>`:''}
      <button class="share-btn" onclick="shareManga('${m.id}',event)" title="Empfehlung teilen">📤</button>
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
      <div class="buy-title">${m.title}</div>
      <div class="buy-band">Band ${m.next} kaufen</div>
      <div class="buy-pub">${m.pub || ''}</div>
      ${dateLabel}
      ${shopLinks}
    </div>
    <div class="buy-btns">
      <button class="btn-xs btn-buy" onclick="markBought('${m.id}',event)">Gekauft ✓</button>
      <button class="btn-xs btn-edit" onclick="openEdit('${m.id}',event)">Bearbeiten</button>
    </div>
  </div>`;
}

// ─── AniList Datenbank-Suche ──────────────────────────────────────────────
const GENRE_MAP = {
  'Action':'Action','Adventure':'Action','Comedy':'Comedy','Drama':'Drama',
  'Fantasy':'Fantasy','Horror':'Horror','Mystery':'Mystery','Romance':'Romance',
  'Sci-Fi':'Sci-Fi','Science Fiction':'Sci-Fi','Slice of Life':'Slice of Life',
  'Sports':'Sports','Supernatural':'Supernatural','Thriller':'Thriller','Mecha':'Mecha',
  'Psychological':'Thriller','Ecchi':'Shōnen','Shounen':'Shōnen','Shoujo':'Shōjo',
  'Seinen':'Seinen','Josei':'Josei',
};
let _dbTimer = null;
let _dbResults = [];

function onDbSearch(val) {
  clearTimeout(_dbTimer);
  const q = val.trim();
  const res = document.getElementById('db-results');
  if (q.length < 2) { res.style.display = 'none'; return; }
  _dbTimer = setTimeout(() => fetchAniList(q), 400);
}

async function fetchAniList(query) {
  document.getElementById('db-spinner').style.display = 'block';
  const gql = `query($s:String){Page(perPage:6){media(search:$s,type:MANGA,isAdult:false){id title{romaji english native}coverImage{medium}genres status volumes}}}`;
  try {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { s: query } })
    });
    const j = await r.json();
    _dbResults = j.data?.Page?.media || [];
    renderDbResults();
  } catch {
    _dbResults = [];
    renderDbResults();
  } finally {
    document.getElementById('db-spinner').style.display = 'none';
  }
}

function renderDbResults() {
  const el = document.getElementById('db-results');
  if (!_dbResults.length) {
    el.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:0.8rem;text-align:center">Keine Ergebnisse</div>';
    el.style.display = 'block'; return;
  }
  el.style.display = 'block';
  el.innerHTML = _dbResults.map((m,i) => {
    const title = m.title.english || m.title.romaji || m.title.native || '';
    const vols = m.volumes ? `${m.volumes} Bde.` : (m.status === 'RELEASING' ? 'laufend' : '');
    const genres = (m.genres||[]).slice(0,2).join(', ');
    return `<div class="db-result-item" onclick="applyDbResult(${i})">
      ${m.coverImage?.medium ? `<img class="db-result-cover" src="${m.coverImage.medium}" loading="lazy">` : '<div class="db-result-cover"></div>'}
      <div class="db-result-info">
        <div class="db-result-title">${title}</div>
        <div class="db-result-sub">${[vols,genres].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`;
  }).join('');
}

function applyDbResult(i) {
  const m = _dbResults[i];
  if (!m) return;
  const title = m.title.english || m.title.romaji || m.title.native || '';
  document.getElementById('f-title').value = title;
  if (m.volumes) document.getElementById('f-total').value = m.volumes;
  document.getElementById('f-ongoing').value = m.status === 'RELEASING' ? 'true' : 'false';
  if (m.coverImage?.medium) document.getElementById('f-cover').value = m.coverImage.medium;
  // Genres mappen
  const mapped = [...new Set((m.genres||[]).map(g => GENRE_MAP[g]).filter(Boolean))];
  modalGenres = mapped.filter(g => ALL_GENRES.includes(g));
  renderGenrePicker();
  // Suche schließen
  document.getElementById('db-results').style.display = 'none';
  document.getElementById('db-search').value = '';
  toast(`✅ „${title}" aus Datenbank übernommen`);
}

// ─── Öffentliches Profil ──────────────────────────────────────────────────
const _viewColl = new URLSearchParams(window.location.search).get('view');
// Read-only sobald ?view= gesetzt ist ODER kein Owner-Token im Browser liegt.
// Der Frontend-Check ist nur UX; der harte Schutz ist die RLS-Policy collections_update_owner.
const readOnly = !!_viewColl || !_ownerToken;

function applyReadOnly() {
  if (!readOnly) return;
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
  if (!_viewColl) return;
  try {
    const record = await SupabaseAdapter.fetchCollection(_viewColl, _ownerToken);
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
        if (s.nextDate !== null && s.nextDate !== undefined) m.nextDate = s.nextDate;
        m.total = s.total; m.ongoing = s.ongoing;
      });
      render();
    }
  } catch { toast('⚠️ Sammlung konnte nicht geladen werden'); }
}

// ─── Statistiken ──────────────────────────────────────────────────────────
function renderStats() {
  const year = new Date().getFullYear();
  const MONATE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  const el = document.getElementById('content');
  document.getElementById('view-toggle').style.display = 'none';
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

  // Top-bewertete Serien

  el.innerHTML = `<div class="stats-page">
    ${renderImportExport()}
    <div class="stats-section">
      <h3>Sammlung gesamt</h3>
      <div class="stat-big-grid">
        <div class="stat-big-card"><div class="stat-big-n">${totalSeries}</div><div class="stat-big-l">Serien</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${totalVols}</div><div class="stat-big-l">Bände besessen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${readingSeries}</div><div class="stat-big-l">Aktiv lesend</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${completedVols}</div><div class="stat-big-l">Bände abgeschlossen</div></div>
        <div class="stat-big-card"><div class="stat-big-n">${buyCount}</div><div class="stat-big-l">Zu kaufen</div></div>
      </div>
    </div>

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
          <div class="month-bar" style="height:${Math.round(monthCount[i]/maxMonth*100)}%" title="${monthCount[i]} abgeschlossen"></div>
          <div class="month-lbl">${m}</div>
        </div>`).join('')}
      </div>
    </div>

    ${pubEntries.length ? `<div class="stats-section">
      <h3>Verlage</h3>
      <div class="bar-chart">
        ${pubEntries.map(([p,n])=>`<div class="bar-row">
          <div class="bar-label">${p}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(n/maxPub*100)}%"></div></div>
          <div class="bar-val">${n}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${genreEntries.length ? `<div class="stats-section">
      <h3>Genre-Verteilung</h3>
      <div class="bar-chart">
        ${genreEntries.map(([g,n])=>`<div class="bar-row">
          <div class="bar-label">${g}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(n/maxGenre*100)}%;background:#7c3aed"></div></div>
          <div class="bar-val">${n}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}

  </div>`;
}

// ─── Genre / Tags ─────────────────────────────────────────────────────────
const ALL_GENRES = ['Shōnen','Shōjo','Seinen','Josei','Isekai','Fantasy','Action',
  'Romance','Horror','Sci-Fi','Comedy','Slice of Life','Sports','Mecha','Thriller',
  'Mystery','Drama','Supernatural'];

let modalGenres = [];
let filterGenre = '';

function renderGenrePicker() {
  const el = document.getElementById('genre-picker');
  el.innerHTML = ALL_GENRES.map(g =>
    `<span class="genre-chip${modalGenres.includes(g)?' on':''}" onclick="toggleGenre('${g}')">${g}</span>`
  ).join('');
}

function toggleGenre(g) {
  if (modalGenres.includes(g)) modalGenres = modalGenres.filter(x => x !== g);
  else modalGenres.push(g);
  renderGenrePicker();
}

function updateGenreFilter() {
  const wrap = document.getElementById('genre-filter-wrap');
  const usedGenres = [...new Set(db.m.flatMap(m => m.genres||[]))].sort();
  if (!usedGenres.length || ['buy','kalender','stats'].includes(tab)) {
    wrap.style.display = 'none'; return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = ['', ...usedGenres].map(g =>
    `<span class="genre-filter-chip${filterGenre===g?' on':''}" onclick="setGenreFilter('${g}')">${g||'Alle'}</span>`
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
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <button class="add-btn" onclick="exportJSON()" style="background:#1e40af;padding:9px 14px;font-size:0.82rem">💾 JSON-Backup</button>
      <button class="add-btn" onclick="triggerImport()" style="background:#065f46;padding:9px 14px;font-size:0.82rem">📂 Importieren</button>
      <button class="add-btn" onclick="exportObsidian()" style="background:#5b21b6;padding:9px 14px;font-size:0.82rem">📦 Obsidian-Export (ZIP)</button>
    </div>
    <p style="color:var(--text-muted);font-size:0.75rem;margin:0">Vor dem Import wird automatisch ein lokales Backup heruntergeladen. Supabase bleibt die einzige Cloud-Sync-Lösung.</p>
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
    `title: "${(m.title || '').replace(/"/g, '\\"')}"`,
    `publisher: "${(m.pub || '').replace(/"/g, '\\"')}"`,
    `status: "${status}"`,
    `collectionStatus: "${collectionStatus}"`,
    `ownedVolumes: ${owned}`,
    `totalVolumes: ${total !== null ? total : ''}`,
    `isOngoing: ${m.ongoing === 'true'}`,
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
    `**Status:** ${m.ongoing === 'true' ? 'Laufend' : 'Abgeschlossen'}`,
  );
  if (m.nextDate) lines.push(`**Nächster Band:** ${m.nextDate}`);
  if (bandLines) lines.push('', '## Bände', bandLines);
  return lines.join('\n');
}

function buildVolumeMd(m, bandNr, bandStatus) {
  const nr = Number(bandNr);
  const releaseDate = (m.nextDate && nr === mNextBand(m)) ? m.nextDate : '';
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
  const ongoing = m.ongoing === 'true' ? 'laufend 🔄' : 'abgeschlossen ✓';
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
  const ownedCount = cnt.owned;
  const buyItems = toBuyList();
  const wishItems = db.m.filter(m => mSeriesStatus(m) === 'wishlist');
  // Kalender: alle Serien mit nextDate die noch kommen oder jetzt erschienen sind
  const kalItems = db.m.filter(m => m.nextDate).sort((a,b) => new Date(a.nextDate)-new Date(b.nextDate));
  document.getElementById('c-reading').textContent = cnt.reading;
  document.getElementById('c-completed').textContent = cnt.completed;
  document.getElementById('c-owned').textContent = ownedCount;
  document.getElementById('c-wishlist').textContent = wishItems.length;
  document.getElementById('c-buy').textContent = buyItems.length;
  document.getElementById('c-kalender').textContent = kalItems.length;

  // search hint
  const hint = document.getElementById('search-hint');

  const el = document.getElementById('content');

  if (tab === 'stats') { renderStats(); return; }

  if (tab === 'kalender') {
    document.getElementById('view-toggle').style.display = 'none';
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
        const next = mNextBand(m);
        html += `<div class="kal-row${isAvail?' kal-avail':''}" onclick="openEdit('${m.id}')">
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
      el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${searchQ}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
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

  if (tab === 'wishlist') {
    document.getElementById('view-toggle').style.display = 'none';
    const filtered = applySearch(applySort(applyPubFilter(wishItems)));
    if (searchQ) hint.textContent = `${filtered.length} von ${wishItems.length} Ergebnis${filtered.length!==1?'se':''}`;
    else hint.textContent = '';
    if (!wishItems.length) {
      el.innerHTML = `<div class="empty">
        <div class="empty-icon">💜</div>
        <h3>Wunschliste ist leer</h3>
        <p>Füge Serien hinzu, die du noch kaufen oder starten möchtest.<br>Beim Bearbeiten einfach „Auf Wunschliste setzen" anhaken.</p>
        <button class="add-btn" onclick="openAdd()" style="margin:0 auto;display:flex">＋ Manga hinzufügen</button>
      </div>`;
      return;
    }
    if (!filtered.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${searchQ}"</h3></div>`;
      return;
    }
    el.innerHTML = `<div class="manga-grid">${filtered.map(mangaCard).join('')}</div>`;
    return;
  }

  document.getElementById('view-toggle').style.display = 'flex';

  // ── Bändenmodus: quer durch alle Manga, nur Bände mit passendem Bandstatus ──
  if (viewMode === 'volumes') {
    const searched = applySearch(db.m);
    const vols = [];
    searched.forEach(m => {
      Object.entries(m.bands || {}).forEach(([bandNr, st]) => {
        if (st === tab) vols.push({ ...m, _band: Number(bandNr) });
      });
    });
    if (!vols.length) {
      const emptyInfo = {
        reading:   ['📖', 'Kein Band aktuell in Bearbeitung', 'Trage bei einer Serie den aktuell gelesenen Band ein.'],
        completed: ['✅', 'Noch keine Bände als gelesen markiert', 'Sobald du eine Serie liest, erscheinen abgeschlossene Bände hier.'],
        owned:     ['📚', 'Keine ungelesenen Bände zum Lesen', 'Gekaufte, noch ungelesene Bände erscheinen hier.'],
      };
      const [ic, tt, sub] = emptyInfo[tab] || ['📦','Leer',''];
      hint.textContent = '';
      el.innerHTML = `<div class="empty"><div class="empty-icon">${ic}</div><h3>${tt}</h3><p>${sub}</p></div>`;
      return;
    }
    const serienCount = new Set(vols.map(v => v.id)).size;
    hint.textContent = `${vols.length} Band${vols.length!==1?'e':''} aus ${serienCount} Serie${serienCount!==1?'n':''}`;
    // Sortierung auch in der Bändenansicht anwenden (primär nach sortMode, sekundär nach Bandnummer)
    const sortedVols = vols.slice().sort((a, b) => {
      if (sortMode === 'za') { const t = b.title.localeCompare(a.title,'de'); return t !== 0 ? t : a._band - b._band; }
      if (sortMode === 'added') { const t = (b.at||0)-(a.at||0); return t !== 0 ? t : a._band - b._band; }
      // az (default)
      const t = a.title.localeCompare(b.title,'de'); return t !== 0 ? t : a._band - b._band;
    });
    el.innerHTML = `<div class="vol-list">${sortedVols.map(volumeRow).join('')}</div>`;
    return;
  }

  // ── Serienansicht (Standard) ───────────────────────────────────────────
  const rawItems = applySort(applyGenreFilter(applyPubFilter(db.m.filter(m => mSeriesStatus(m) === tab))));
  const items = applySearch(rawItems);

  if (searchQ) hint.textContent = `${items.length} von ${rawItems.length} Ergebnis${items.length!==1?'se':''}`;
  else hint.textContent = '';

  if (!rawItems.length) {
    const info = {
      reading:   ['📖', 'Noch nichts in Bearbeitung', 'Füge Mangas hinzu, die du gerade liest.'],
      completed: ['✅', 'Noch nichts abgeschlossen', 'Hier landen Serien, die du vollständig gelesen hast.'],
      owned:     ['📚', 'Noch nichts zum Lesen', 'Sobald du einen Band als „Gekauft" markierst, erscheint er hier.'],
    };
    const [ic, tt, sub] = info[tab]||['📦','Leer',''];
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">${ic}</div>
      <h3>${tt}</h3>
      <p>${sub}</p>
      <button class="add-btn" onclick="openAdd()" style="margin:0 auto;display:flex">＋ Manga hinzufügen</button>
    </div>`;
    return;
  }
  if (!items.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Keine Treffer für „${searchQ}"</h3><p>Versuche einen anderen Suchbegriff.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="manga-grid">${items.map(mangaCard).join('')}</div>`;
  updatePubFilter();
  updateGenreFilter();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === t);
  });
  document.getElementById('view-toggle').style.display = (t === 'buy' || t === 'wishlist' || t === 'kalender' || t === 'stats') ? 'none' : 'flex';
  render();
}

// ─── Modal ────────────────────────────────────────────────────────────────
function openAdd() {
  editId = null;
  modalBands = {};
  modalBandCovers = {};
  modalGenres = [];
  document.getElementById('modal-title').textContent = 'Manga hinzufügen';
  document.getElementById('f-title').value = '';
  document.getElementById('f-publisher').value = '';
  document.getElementById('f-total').value = '';
  document.getElementById('f-ongoing').value = 'true';
  document.getElementById('f-nextdate').value = '';
  document.getElementById('f-cover').value = '';
  document.getElementById('f-notes').value = '';
  document.getElementById('f-started').value = '';
  document.getElementById('f-finished').value = '';
  document.getElementById('f-wishlist').checked = (tab === 'wishlist');
  document.getElementById('btn-del').style.display = 'none';
  renderBandMgr();
  renderGenrePicker();
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
  modalGenres = [...(m.genres || [])];
  document.getElementById('modal-title').textContent = 'Manga bearbeiten';
  document.getElementById('f-title').value = m.title||'';
  document.getElementById('f-publisher').value = m.pub||'';
  document.getElementById('f-total').value = m.total??'';
  document.getElementById('f-ongoing').value = m.ongoing??'true';
  document.getElementById('f-nextdate').value = m.nextDate??'';
  document.getElementById('f-cover').value = m.cover??'';
  document.getElementById('f-notes').value = m.notes??'';
  document.getElementById('f-started').value = m.startedAt || '';
  document.getElementById('f-finished').value = m.finishedAt || '';
  document.getElementById('f-wishlist').checked = (m.status === 'wishlist');
  document.getElementById('btn-del').style.display = 'block';
  renderBandMgr();
  renderGenrePicker();
  document.getElementById('overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('db-results').style.display = 'none';
  document.getElementById('db-search').value = '';
  editId = null;
}

function overlayClick(e) {
  if (e.target === document.getElementById('overlay')) closeModal();
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
  const _rawTotal = parseInt(document.getElementById('f-total').value);
  const total = (!isNaN(_rawTotal) && _rawTotal > 0) ? _rawTotal : null;
  const ongoing = document.getElementById('f-ongoing').value;

  // ── Auto-Setting für startedAt / finishedAt ─────────────────────────────
  // Nicht überschreiben was der User manuell eingegeben hat oder was schon im Eintrag steht
  const existing = editId ? db.m.find(x => x.id === editId) : null;
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

  // bandCovers: nur Einträge behalten, deren Band noch existiert
  const bandCovers = {};
  Object.entries(modalBandCovers).forEach(([k, v]) => { if (bands[k] && v) bandCovers[k] = v; });

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
    nextDate: document.getElementById('f-nextdate').value || null,
    cover: document.getElementById('f-cover').value.trim() || null,
    notes: document.getElementById('f-notes').value.trim(),
    genres: [...modalGenres],
    startedAt,
    finishedAt,
    at: existing?.at || Date.now(),
    // Manga-Passion-Mapping erhalten
    mpEditionId: existing?.mpEditionId,
    mpVerifiedAt: existing?.mpVerifiedAt,
  };
  if (editId) {
    const i = db.m.findIndex(x => x.id === editId);
    if (i !== -1) db.m[i] = entry;
  } else {
    db.m.push(entry);
  }
  persist();
  closeModal();
  render();
  toast(editId ? '✅ Manga aktualisiert' : `✅ „${title}" hinzugefügt`);
}

function doDelete() {
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
  const m = db.m.find(x => x.id === id);
  if (!m) return;
  if (!m.bands) m.bands = {};
  const nextBand = String(mNextBand(m));
  m.bands[nextBand] = 'owned';
  m.owned = mOwned(m); // Rückwärtskompatibilität
  m.nextDate = null;
  if (m.status === 'wishlist') m.status = 'owned'; // Von Wunschliste in "Zu lesen"
  persist();
  render();
  toast(`✅ Band ${nextBand} von „${m.title}" zu „Zu lesen" hinzugefügt`);
}

// ─── Toast ───────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

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
  if (existing) {
    existing.pub     = seedData.pub;
    existing.total   = seedData.total;
    existing.ongoing = seedData.ongoing;
    existing.cover   = existing.cover || seedData.cover;
    existing.notes   = existing.notes || seedData.notes;
    if (!existing.genres || !existing.genres.length) existing.genres = [...seedData.genres];
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
  }
  persist();
})();

// ─── Seed helper ─────────────────────────────────────────────────────────
function upsertManga(key, data) {
  // Seed-Termine für Cloud-Merge merken (geplante Aufgabe aktualisiert nur diese)
  SEED_DATES[key] = { nextDate: data.nextDate, total: data.total, ongoing: data.ongoing };
  // Seed-Genres für Cloud-Merge merken (Einträge ohne Genres werden ergänzt)
  if (data.genres && data.genres.length) SEED_GENRES[key] = [...data.genres];
  // Bei mehreren Treffern den spezifischsten (kürzesten Titel) nehmen,
  // damit z.B. 'kaiju no.8' nicht 'Kaiju No.8 Side' trifft
  const matches = db.m.filter(m => m.title.toLowerCase().includes(key));
  const existing = matches.sort((a, b) => a.title.length - b.title.length)[0];
  if (existing) {
    if (!existing.pub)      existing.pub      = data.pub;
    if (!existing.cover)    existing.cover    = data.cover;
    if (!existing.notes)    existing.notes    = data.notes;
    // Genres nur setzen wenn der Eintrag noch keine hat (manuelle Tags bleiben erhalten)
    if (data.genres && (!existing.genres || !existing.genres.length)) {
      existing.genres = [...data.genres];
    }
    existing.total    = data.total;
    existing.ongoing  = data.ongoing;
    // nextDate: Seed-Datum nur setzen wenn seed einen konkreten Wert hat ODER
    // wenn der bestehende Wert null/leer ist (kein Datum vorhanden)
    if (data.nextDate !== null && data.nextDate !== undefined) {
      existing.nextDate = data.nextDate;
    } else if (!existing.nextDate) {
      existing.nextDate = null;
    }
    // → bestehende Termine (von geplanter Aufgabe gesetzt) bleiben erhalten wenn seed null hat
  } else {
    db.m.push({ ...data, id: uid(), at: Date.now() });
  }
  persist();
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
  ongoing: 'true', nextDate: '2026-06-09', // 2-in-1 Format; Band 3 April 2026 ✓, Band 4 09.06.2026
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
  ongoing: 'true', nextDate: '2026-06-09', // Band 8 (DE) erscheint 09.06.2026
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
  ongoing: 'true', nextDate: '2026-05-26', // Band 7 erscheint 26.05.2026!
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
  if (existing) {
    existing.pub     = existing.pub || seedData.pub;
    existing.total   = seedData.total;
    existing.ongoing = seedData.ongoing;
    // Force-update nextDate (wie upsertManga): Seed überschreibt bestehende Termine
    if (seedData.nextDate !== null && seedData.nextDate !== undefined) {
      existing.nextDate = seedData.nextDate;
    } else if (!existing.nextDate) {
      existing.nextDate = null;
    }
    existing.cover   = existing.cover || seedData.cover;
    existing.notes   = existing.notes || seedData.notes;
    if (!existing.genres || !existing.genres.length) existing.genres = [...seedData.genres];
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
  }
  persist();
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
  if (existing) {
    existing.pub     = existing.pub || seedData.pub;
    existing.total   = seedData.total;
    existing.ongoing = seedData.ongoing;
    // Force-update nextDate (wie upsertManga): Seed überschreibt bestehende Termine
    if (seedData.nextDate !== null && seedData.nextDate !== undefined) {
      existing.nextDate = seedData.nextDate;
    } else if (!existing.nextDate) {
      existing.nextDate = null;
    }
    existing.cover   = existing.cover || seedData.cover;
    existing.notes   = existing.notes || seedData.notes;
    if (!existing.genres || !existing.genres.length) existing.genres = [...seedData.genres];
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
  }
  persist();
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
  if (existing) {
    existing.pub      = existing.pub || seedData.pub;
    existing.total    = seedData.total;
    existing.ongoing  = seedData.ongoing;
    // Force-update nextDate (wie upsertManga): Seed überschreibt bestehende Termine
    if (seedData.nextDate !== null && seedData.nextDate !== undefined) {
      existing.nextDate = seedData.nextDate;
    } else if (!existing.nextDate) {
      existing.nextDate = null;
    }
    existing.cover    = existing.cover || seedData.cover;
    existing.notes    = existing.notes || seedData.notes;
    if (!existing.genres || !existing.genres.length) existing.genres = [...seedData.genres];
  } else {
    db.m.push({ ...seedData, id: uid(), at: Date.now() });
  }
  persist();
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
  ongoing: 'true', nextDate: '2026-07-03', // Band 21 erscheint 03.07.2026
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
  status: 'completed', owned: 2, total: 2, current: 2,
  ongoing: 'false', nextDate: null,
  cover: 'https://covers.openlibrary.org/b/isbn/9783964337313-L.jpg',
  notes: 'Abgeschlossen, 2 Bände (Aug 2023 – Aug 2024). Von Natsume Ono.',
  genres: ['Drama', 'Mystery'],
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
  ongoing: 'true', nextDate: '2026-08-04', // Band 22 erscheint 04.08.2026
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
  ongoing: 'true', nextDate: '2026-06-30',
  cover: 'https://covers.openlibrary.org/b/isbn/9783551624860-L.jpg',
  notes: 'Band 5 (DE) erscheint 30.06.2026. Band 4 bereits erhältlich. Von Sei Oma.',
  genres: ['Action', 'Supernatural', 'Horror'],
});

// ─── Seed: Berserk Master Edition ─────────────────────────────────────────
upsertManga('berserk master', {
  title: 'Berserk Master Edition', pub: 'Panini Manga',
  status: 'reading', owned: 4, total: 14, current: 4,
  ongoing: 'true', nextDate: '2026-06-16',
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
  ongoing: 'true', nextDate: '2026-07-31',
  cover: null,
  notes: 'Band 1 April 2026, Band 2: 31.07.2026. JP 8+ Bände (Nihon Bungeisha, ab 2018). Ab 18. Von Shinobu Inokuma.',
  genres: ['Isekai', 'Comedy', 'Seinen'],
});

// ─── Seed-Phase abschließen: ein einziger localStorage-Write statt ~58 ────
_seeding = false;
saveLoc();

// ─── Init ─────────────────────────────────────────────────────────────────
render();
applyReadOnly();
if (_viewColl) {
  // Öffentliche Ansicht: fremde Sammlung laden (immer read-only)
  loadViewCollection();
} else if (_collId) {
  // Eigene Cloud-Daten laden – ohne Owner-Token bleibt der Modus read-only,
  // gesteuert ueber die readOnly-Konstante und die RLS-Policy.
  loadFromCloud();
} else {
  // Kein Cloud-Sync konfiguriert: rein lokale Sammlung. Adopt-Link auf einem
  // Owner-Geraet einmalig oeffnen, um mtCollId + mtOwnerToken zu setzen.
  setSyncStatus('💾', 'Lokal – kein Cloud-Sync (Adopt-Link öffnen)');
}

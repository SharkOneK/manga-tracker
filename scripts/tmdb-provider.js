'use strict';

/**
 * scripts/tmdb-provider.js — Phase 75: TMDB-Provider für Realserien
 *
 * Reine Mapping-/Normalisierungslogik + injizierbarer Fetch-Glue für den
 * server-seitigen Import (scripts/update-tmdb-catalog.js, GitHub Actions).
 * Node-Modul (kein UMD nötig — der Client braucht diese Mapping-Logik nie,
 * siehe Phase-75-Spec E3): der Client liest ausschließlich den fertigen,
 * committeten Katalog (data/tmdb-series-catalog.json), NIE TMDB direkt.
 *
 * fetchSeries() nimmt fetchImpl als Argument entgegen — dadurch offline in
 * scripts/test-tmdb-provider.js testbar, ohne Netzzugriff in CI.
 *
 * Der API-Key wird ausschließlich als Argument entgegengenommen (der Runner
 * liest ihn aus process.env.TMDB_API_KEY) — dieses Modul liest nie selbst aus
 * process.env und loggt/gibt den Key nie zurück.
 */

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
// Bilder werden ausschließlich relativ zu diesem Host aufgelöst (safeCoverUrl
// akzeptiert nur TMDB-eigene poster_path-Werte, keine absoluten Fremd-URLs).
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

// Obergrenzen gegen Datenmüll aus einer fremden Quelle (analog src/anilist-utils.js).
const MAX_GENRES = 12;
// DE-flatrate ist real ~≤10 Anbieter — Kappung gegen Datenmüll (Phase 77).
const MAX_PROVIDERS = 20;
// Dauerserien (Talkshows, Soaps) können > 2000 Episoden haben — eine so lange
// Bandliste friert die Bandverwaltung ein. seasons wird deshalb hart gekappt,
// total bleibt der volle (ungekappte) Summenwert (E1, spec.md Phase 75).
const MAX_EPISODES = 2000;
const DEFAULT_TIMEOUT_MS = 10000;

// TMDB-Statuswerte → interner String-Tristate ('true' | 'false' | null).
// Unbekannte/andere Werte (z. B. "Planned", "In Production", "Pilot") bleiben
// bewusst null statt geraten — genau wie bei AniList (Phase 73).
const ONGOING_BY_STATUS = {
  'Returning Series': 'true',
  Ended: 'false',
  Canceled: 'false',
};

// episode_count nur ganzzahlig ≥ 0 zählt, alles andere normalisiert auf 0
// (spec.md: "ganzzahlig, ≥0 normalisierte" Staffelsumme — keine geratenen Werte).
function normalizeEpisodeCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * Fortlaufende Bandzählung über alle regulären Staffeln (season_number >= 1,
 * Season 0/Specials ausgeschlossen), sortiert nach season_number aufsteigend.
 * total = Summe der normalisierten episode_count (NICHT number_of_episodes —
 * die kann Specials enthalten und mit der Staffelsumme divergieren).
 * seasons-Map: Band N → season_number, gekappt bei MAX_EPISODES; total bleibt
 * dabei der volle Summenwert (E1, spec.md Phase 75).
 * seasonCount zählt die realen regulären Staffeln, unabhängig davon, ob deren
 * Episodenzahl bekannt ist (sonst würde eine kaputte episode_count auch die
 * an sich bekannte Staffelanzahl verschlucken).
 */
function computeSeasonsAndTotal(seasons) {
  const list = Array.isArray(seasons) ? seasons : [];
  const regular = list
    .filter(s => s && typeof s === 'object' && Number.isFinite(Number(s.season_number)) && Number(s.season_number) >= 1)
    .map(s => ({ seasonNumber: Number(s.season_number), episodeCount: normalizeEpisodeCount(s.episode_count) }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  const seasonCount = regular.length;
  const total = regular.reduce((sum, s) => sum + s.episodeCount, 0);

  // Leerfall: keine reguläre Staffel oder Summe 0 ⇒ keine geratenen Bänder.
  if (total <= 0) return { total: null, seasons: {}, seasonCount };

  const seasonsMap = {};
  let band = 0;
  outer:
  for (const s of regular) {
    for (let i = 0; i < s.episodeCount; i++) {
      band += 1;
      if (band > MAX_EPISODES) break outer;
      seasonsMap[String(band)] = s.seasonNumber;
    }
  }
  return { total, seasons: seasonsMap, seasonCount };
}

// Erster Netzwerkname aus tmdb.networks — reine Textauskunft, kein Ranking nötig.
function pickNetwork(tmdb) {
  const networks = Array.isArray(tmdb && tmdb.networks) ? tmdb.networks : [];
  for (const n of networks) {
    if (n && typeof n.name === 'string' && n.name.trim()) return n.name.trim();
  }
  return '';
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return [];
  const out = [];
  for (const g of genres) {
    if (typeof g !== 'string') continue;
    const v = g.trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_GENRES) break;
  }
  return out;
}

// DE-Region, NUR flatrate (Abo) — bewusst NIE rent/buy gelesen (Nutzerwunsch
// ist "wo kann ich es mit meinen Abos sehen", nicht Kauf-/Leihpreise, spec.md
// Phase 77 Scope-Entscheidung 1). Reihenfolge = TMDB-Reihenfolge (deterministisch).
function pickStreamingProviders(tmdb) {
  const flatrate = tmdb && tmdb['watch/providers'] && tmdb['watch/providers'].results
    && tmdb['watch/providers'].results.DE && tmdb['watch/providers'].results.DE.flatrate;
  if (!Array.isArray(flatrate)) return [];
  const out = [];
  for (const p of flatrate) {
    if (!p || typeof p.provider_name !== 'string') continue;
    const v = p.provider_name.trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_PROVIDERS) break;
  }
  return out;
}

// Nur TMDB-eigene, relative poster_path-Werte werden zu einer https-Cover-URL
// aufgelöst — kein absoluter Fremd-Link, kein http:/javascript:.
function safeCoverUrl(posterPath) {
  if (!posterPath || typeof posterPath !== 'string') return '';
  if (!posterPath.startsWith('/')) return '';
  const url = TMDB_IMG_BASE + posterPath;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? url : '';
  } catch (_) { return ''; }
}

/**
 * TMDB-Rohantwort (GET /tv/{id}) → Katalogrecord.
 * Strikte Allowlist — kein {...tmdb}-Spread, kein api_key, kein Roh-Blob.
 * Rückgabe: Record oder null (kein verwertbarer Titel).
 */
function mapSeriesToRecord(tmdb) {
  if (!tmdb || typeof tmdb !== 'object') return null;
  const title = typeof tmdb.name === 'string' ? tmdb.name.trim() : '';
  if (!title) return null;
  const tmdbId = Number(tmdb.id);
  if (!Number.isFinite(tmdbId) || tmdbId < 1) return null;

  const { total, seasons, seasonCount } = computeSeasonsAndTotal(tmdb.seasons);
  const genreNames = Array.isArray(tmdb.genres) ? tmdb.genres.map(g => g && g.name) : [];

  return {
    tmdbId,
    title,
    network: pickNetwork(tmdb),
    total,
    seasonCount,
    ongoing: ONGOING_BY_STATUS[tmdb.status] || null,
    cover: safeCoverUrl(tmdb.poster_path),
    genres: normalizeGenres(genreNames),
    overview: typeof tmdb.overview === 'string' ? tmdb.overview.trim() : '',
    seasons,
    streamingProviders: pickStreamingProviders(tmdb),
  };
}

/**
 * Fehlerklassifikation rein aus übergebenen Werten (kein globaler Zustand).
 * → 'timeout' | 'rate-limited' | 'http' | 'malformed' | 'empty' | 'network'
 */
function classifyError(err, httpStatus, body) {
  if (err) {
    const name = err.name || '';
    if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
    return 'network';
  }
  const status = Number(httpStatus);
  if (status === 429) return 'rate-limited';
  if (Number.isFinite(status) && status >= 400) return 'http';
  if (!body || typeof body !== 'object') return 'malformed';
  // TMDB signalisiert manche Fachfehler (z. B. unbekannte ID) mit HTTP 200 und
  // success:false — HTTP-Status allein ist deshalb kein Erfolgssignal.
  if (body.success === false) return 'http';
  if (typeof body.name !== 'string' || !body.name.trim()) return 'empty';
  return null;
}

/**
 * Holt eine einzelne TMDB-Serie und mappt sie direkt auf einen Katalogrecord.
 * fetchImpl ist injizierbar (kein globaler fetch-Zugriff in diesem Modul),
 * apiKey kommt vom Aufrufer (liest process.env.TMDB_API_KEY) — wird hier nie
 * geloggt und nie in der Rückgabe gespiegelt.
 */
async function fetchSeries(id, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl;
  const apiKey = o.apiKey;
  const timeoutMs = Number.isFinite(Number(o.timeoutMs)) ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') throw new Error('fetchSeries: fetchImpl (injizierbar) ist erforderlich');

  const url = `${TMDB_API_BASE}/tv/${encodeURIComponent(String(id))}`
    + `?api_key=${encodeURIComponent(String(apiKey || ''))}&language=de-DE`
    + `&append_to_response=${encodeURIComponent('watch/providers')}`;

  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: classifyError(e), record: null };
  }

  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }

  const reason = classifyError(null, res.status, body);
  if (reason) return { ok: false, reason, record: null };

  const record = mapSeriesToRecord(body);
  if (!record) return { ok: false, reason: 'empty', record: null };
  return { ok: true, reason: null, record };
}

module.exports = {
  TMDB_IMG_BASE,
  MAX_GENRES,
  MAX_EPISODES,
  MAX_PROVIDERS,
  ONGOING_BY_STATUS,
  computeSeasonsAndTotal,
  pickNetwork,
  normalizeGenres,
  pickStreamingProviders,
  safeCoverUrl,
  mapSeriesToRecord,
  classifyError,
  fetchSeries,
};

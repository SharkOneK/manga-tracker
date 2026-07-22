// src/anilist-utils.js — Phase 73: AniList-Provider (UMD)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.MangaTrackerAniListUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Reine Mapping-/Normalisierungslogik ohne fetch und ohne globalen Zustand:
  // dadurch im Browser nutzbar (index.html lädt die Datei vor app.js) und in Node
  // offline testbar (scripts/test-anilist-provider.js), ohne Netzzugriff in CI.

  const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

  // Obergrenzen gegen Datenmüll aus einer fremden Quelle.
  const MAX_GENRES = 12;
  // Sazae-san & Co. haben > 7000 Episoden — eine so lange Bandliste friert die
  // Bandverwaltung ein. seasons wird deshalb hart gekappt (total bleibt unangetastet).
  const MAX_EPISODES = 2000;
  const DEFAULT_PER_PAGE = 10;

  // AniList-Statuswerte → interner String-Tristate ('true' | 'false' | null).
  // NOT_YET_RELEASED/CANCELLED/HIATUS bleiben bewusst „unbekannt" (null) statt 'false':
  // ein geratenes 'false' würde die Serie fälschlich als abgeschlossen führen.
  const ONGOING_BY_STATUS = {
    RELEASING: 'true',
    FINISHED: 'false',
  };

  // Nur HTTPS-Cover übernehmen (javascript:/http: ergeben null).
  function safeCoverUrl(v) {
    if (!v || typeof v !== 'string') return null;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' ? v : null;
    } catch (_) { return null; }
  }

  // Baut die GraphQL-Suchanfrage. Der Suchtitel steckt ausschließlich in `variables`,
  // wird also nie in den Query-Text interpoliert (keine Query-Injection).
  function buildSearchQuery(title, perPage) {
    const n = Number(perPage);
    const limit = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 25) : DEFAULT_PER_PAGE;
    const query = [
      'query ($q: String, $perPage: Int) {',
      '  Page(page: 1, perPage: $perPage) {',
      '    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {',
      '      id',
      '      title { romaji english native }',
      '      episodes',
      '      status',
      '      format',
      '      seasonYear',
      '      season',
      '      coverImage { large }',
      '      genres',
      '      nextAiringEpisode { episode airingAt }',
      '      relations { edges { relationType node { id } } }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    return { query, variables: { q: (title == null ? '' : String(title)).trim(), perPage: limit } };
  }

  // Titelauswahl: english → romaji → native. Alle leer ⇒ null (Eintrag verwerfen).
  function pickTitle(media) {
    const t = (media && media.title) || {};
    const candidates = [t.english, t.romaji, t.native];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }

  function normForScore(s) {
    return (s == null ? '' : String(s))
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Bewusst schlichter als mpScore(): AniList hat keinen Verlag, an dem sich ein
  // zusätzliches Signal festmachen ließe. Exakter Treffer über eine der drei
  // Titelvarianten schlägt Präfix, Präfix schlägt Substring.
  function scoreCandidate(query, media) {
    const q = normForScore(query);
    if (!q || !media) return 0;
    const t = (media.title || {});
    const variants = [t.english, t.romaji, t.native].map(normForScore).filter(Boolean);
    let best = 0;
    for (const v of variants) {
      let s = 0;
      if (v === q) s = 100;
      else if (v.startsWith(q) || q.startsWith(v)) s = 60;
      else if (v.includes(q) || q.includes(v)) s = 35;
      if (s > best) best = s;
    }
    return best;
  }

  // Wählt den besten Treffer. `ambiguous` erzwingt in der UI den Auswahldialog:
  // entweder liegt der zweitbeste Treffer nah dran, oder gar kein Treffer sitzt gut.
  function pickBestCandidate(query, list) {
    const items = Array.isArray(list) ? list.filter(function (x) { return x && typeof x === 'object'; }) : [];
    if (!items.length) return { best: null, ambiguous: false };
    const scored = items
      .map(function (media) { return { media, score: scoreCandidate(query, media) }; })
      .sort(function (a, b) { return b.score - a.score; });
    const best = scored[0];
    const second = scored[1];
    const close = !!second && (best.score - second.score) < 20;
    return { best: best.media, ambiguous: close || best.score < 60 };
  }

  // Staffel-Ordinal aus dem Titel ableiten („Season 2", „2nd Season", „Part 3").
  // Fallback 1 — es wird nichts geraten, was nicht im Titel steht.
  function deriveSeasonOrdinal(media) {
    const t = (media && media.title) || {};
    const sources = [t.english, t.romaji, t.native].filter(function (x) { return typeof x === 'string'; });
    for (const raw of sources) {
      const s = raw.toLowerCase();
      const m = s.match(/\b(?:season|part|cour)\s+(\d{1,2})\b/)
        || s.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:season|part|cour)\b/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n >= 1) return n;
      }
    }
    return 1;
  }

  // Unix-Sekunden (UTC) → YYYY-MM-DD in lokaler Zeitzone. Bewusst über die lokalen
  // Date-Getter statt toISOString(), sonst entsteht der Off-by-one-Tag.
  function airingDateToLocalIso(airingAt) {
    const secs = Number(airingAt);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    const d = new Date(secs * 1000);
    if (Number.isNaN(d.getTime())) return null;
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Gesamt-Episoden: nur ganzzahlig ≥ 1 zählt, alles andere ist „unbekannt".
  function normalizeTotal(episodes) {
    const n = Number(episodes);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
    return n;
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

  // Anker der PREQUEL-Kette — best effort NUR aus dieser Antwort, keine Zusatzabfrage.
  // Findet keine Kante einen Knoten, ist die Media-ID selbst der Anker.
  function deriveRootId(media) {
    const self = Number(media && media.id);
    const fallback = Number.isFinite(self) ? self : null;
    const edges = (media && media.relations && Array.isArray(media.relations.edges))
      ? media.relations.edges : [];
    let root = fallback;
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object') continue;
      if (edge.relationType !== 'PREQUEL') continue;
      const nodeId = Number(edge.node && edge.node.id);
      if (!Number.isFinite(nodeId)) continue;
      // Kleinere AniList-IDs sind älter — als Heuristik für „ältester Knoten" ausreichend,
      // solange (E1) jede Media-ID ohnehin ein eigener Eintrag bleibt.
      if (root === null || nodeId < root) root = nodeId;
    }
    return root;
  }

  /**
   * AniList-Media → interner Sammlungseintrag.
   * Allowlist, kein {...media}-Spread: keine API-Antwort darf id/mediaType oder
   * fremde Felder in den Eintrag schmuggeln.
   * opts: { id, now, wishlist }
   * Rückgabe: Eintrag oder null (wenn kein verwertbarer Titel vorhanden ist).
   */
  function mapMediaToEntry(media, opts) {
    if (!media || typeof media !== 'object') return null;
    const o = opts || {};
    const title = pickTitle(media);
    if (!title) return null;

    const total = normalizeTotal(media.episodes);
    const ongoing = ONGOING_BY_STATUS[media.status] || null;
    const seasonOrdinal = deriveSeasonOrdinal(media);

    // seasons nur befüllen, wenn die Episodenzahl bekannt ist — keine geratenen Bänder.
    const seasons = {};
    if (total !== null) {
      const upTo = Math.min(total, MAX_EPISODES);
      for (let i = 1; i <= upTo; i++) seasons[String(i)] = seasonOrdinal;
    }

    const airing = media.nextAiringEpisode;
    const nextDate = (airing && typeof airing === 'object') ? airingDateToLocalIso(airing.airingAt) : null;
    const airingEpisode = (airing && Number.isFinite(Number(airing.episode))) ? Number(airing.episode) : null;
    const airingAt = (airing && Number.isFinite(Number(airing.airingAt))) ? Number(airing.airingAt) : null;

    const anilistId = Number.isFinite(Number(media.id)) ? Number(media.id) : null;

    return {
      id: o.id || null,
      title,
      pub: '',                       // Anime hat keinen Verlag — Studio gehört nicht in dieses Feld
      mediaType: 'anime',
      bands: {},                     // Import legt keine Sehstatus an, der Nutzer markiert selbst
      bandCovers: {},
      owned: 0,
      status: o.wishlist ? 'wishlist' : 'owned',
      current: null,
      total,
      ongoing,
      nextDate,
      cover: safeCoverUrl(media.coverImage && media.coverImage.large),
      notes: '',
      genres: normalizeGenres(media.genres),
      startedAt: null,
      finishedAt: null,
      at: Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now(),
      seasons,
      externalIds: { anilistId, anilistRootId: deriveRootId(media) },
      // Privat, für Phase 74 (Airing-Kalender) — kein UI in dieser Phase.
      anilistAiring: (airingEpisode !== null || airingAt !== null)
        ? { episode: airingEpisode, airingAt }
        : null,
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
    // AniList meldet Fachfehler mit HTTP 200 und einem errors-Array — res.ok allein
    // ist deshalb kein Erfolgssignal.
    if (Array.isArray(body.errors) && body.errors.length) return 'http';
    const media = body.data && body.data.Page && body.data.Page.media;
    if (!Array.isArray(media)) return 'malformed';
    if (!media.filter(function (x) { return x && typeof x === 'object'; }).length) return 'empty';
    return null;
  }

  // Extrahiert die Trefferliste aus einer als valide klassifizierten Antwort.
  function extractMediaList(body) {
    const media = body && body.data && body.data.Page && body.data.Page.media;
    if (!Array.isArray(media)) return [];
    return media.filter(function (x) { return x && typeof x === 'object'; });
  }

  return {
    ANILIST_ENDPOINT,
    MAX_GENRES,
    MAX_EPISODES,
    buildSearchQuery,
    pickTitle,
    scoreCandidate,
    pickBestCandidate,
    deriveSeasonOrdinal,
    airingDateToLocalIso,
    normalizeTotal,
    normalizeGenres,
    deriveRootId,
    mapMediaToEntry,
    classifyError,
    extractMediaList,
    safeCoverUrl,
  };
});

(function () {
  var SUPA_URL  = 'https://sssxiqtnkctvyghyrqff.supabase.co';
  var SUPA_KEY  = 'sb_publishable_dHER8ble5X15bPpByKRs8g_fK_01io7';
  var SUPA_REST = SUPA_URL + '/rest/v1/collections';
  var SUPA_PUBLIC_REST = SUPA_URL + '/rest/v1/collection_public_projection';
  var SUPA_RPC = SUPA_URL + '/rest/v1/rpc';

  // Phase 51: Supabase Auth session (JWT) is the primary owner path; the legacy
  // x-owner-token is the fallback. The session is read straight from the persisted
  // supabase-js storage so we never have to load the ~200 KB auth bundle just to sync.
  var PROJECT_REF = 'sssxiqtnkctvyghyrqff';
  var SESSION_STORAGE_KEY = 'sb-' + PROJECT_REF + '-auth-token';

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function adoptOwnerIfPresent() {
    try {
      // Prefer fragment-based adopt (hash): token never sent to server
      var fp = new URLSearchParams(window.location.hash.slice(1));
      var fa = fp.get('adopt');
      var ft = fp.get('token');
      if (fa && ft && UUID_RE.test(fa) && UUID_RE.test(ft)) {
        localStorage.setItem('mtCollId', fa);
        localStorage.setItem('mtOwnerToken', ft);
        // Clear fragment
        history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
      }

      // Legacy: query-parameter adopt (deprecated, kept for backwards compatibility)
      var p = new URLSearchParams(window.location.search);
      var a = p.get('adopt');
      var t = p.get('token');
      if (a && t && UUID_RE.test(a) && UUID_RE.test(t)) {
        console.warn('[security] adopt via query params is deprecated, use fragment links');
        localStorage.setItem('mtCollId', a);
        localStorage.setItem('mtOwnerToken', t);
        p.delete('adopt');
        p.delete('token');
        var qs = p.toString();
        history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      }
    } catch (_) {}
  }

  function getOwnerState() {
    return {
      collId: localStorage.getItem('mtCollId') || null,
      ownerToken: localStorage.getItem('mtOwnerToken') || null,
    };
  }

  function headers(ownerToken, write) {
    var h = {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + SUPA_KEY,
    };
    if (write && ownerToken) h['x-owner-token'] = ownerToken;
    return h;
  }

  // Phase 51: Authorization carries the user's JWT instead of the anon key, so
  // PostgREST/RLS evaluate auth.uid(). apikey stays the publishable key.
  function sessionHeaders(accessToken) {
    return {
      apikey: SUPA_KEY,
      Authorization: 'Bearer ' + accessToken,
    };
  }

  // Read a non-expired access token from the persisted supabase-js session WITHOUT
  // loading the auth bundle. Returns null if absent or (about to be) expired, which
  // makes every caller fall back to the owner-token path safely.
  function getStoredAccessToken() {
    try {
      var raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var sess = (parsed && parsed.access_token) ? parsed : (parsed && parsed.currentSession) || null;
      if (!sess || !sess.access_token) return null;
      // 60s skew: don't use a token that is expired or expires imminently.
      if (sess.expires_at && (Number(sess.expires_at) * 1000) < (Date.now() + 60000)) return null;
      return sess.access_token;
    } catch (_) { return null; }
  }

  // Phase 51b: sync check whether a usable (non-expired) access token exists.
  function hasValidSession() {
    return !!getStoredAccessToken();
  }

  // Phase 51 (Etappe 7): is the user signed in at all? True when a session object
  // exists with an access OR refresh token, even if the access token is currently
  // expired (the token-fallback path still covers reads/writes until Etappe 7/2).
  // Used by the strict login gate to decide "locked" vs "owner".
  function hasSession() {
    try {
      var raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      var sess = (parsed && (parsed.access_token || parsed.refresh_token)) ? parsed
        : (parsed && parsed.currentSession) || null;
      return !!(sess && (sess.access_token || sess.refresh_token));
    } catch (_) { return false; }
  }

  // Phase 51 (Etappe 7/2): keep the session alive without loading the 200 KB bundle.
  function getStoredSession() {
    try {
      var raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && (parsed.access_token || parsed.refresh_token)) ? parsed
        : (parsed && parsed.currentSession) || null;
    } catch (_) { return null; }
  }

  function persistSession(sess) {
    try {
      if (sess && sess.expires_in && !sess.expires_at) {
        sess.expires_at = Math.floor(Date.now() / 1000) + Number(sess.expires_in);
      }
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sess));
    } catch (_) {}
  }

  // Returns a valid access token, refreshing via the refresh_token if the stored
  // one is (about to be) expired. Returns null when the user is not signed in or
  // the refresh fails (→ caller surfaces "nicht angemeldet"; the strict gate then
  // forces a re-login).
  async function ensureFreshAccessToken() {
    var tok = getStoredAccessToken();
    if (tok) return tok;
    var sess = getStoredSession();
    var refreshToken = sess && sess.refresh_token;
    if (!refreshToken) return null;
    try {
      var r = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!r.ok) return null;
      var fresh = await r.json();
      if (!fresh || !fresh.access_token) return null;
      persistSession(fresh);
      return fresh.access_token;
    } catch (_) { return null; }
  }

  // Phase 51b: discover the collection ids bound to the signed-in user (auth.uid()).
  // Lets a fresh browser (valid session but no adopt link / owner token) find which
  // collection to load. Returns [] when not signed in or none owned.
  async function fetchMyCollectionIds() {
    var token = getStoredAccessToken();
    if (!token) return [];
    var rows = await requestJson(SUPA_RPC + '/get_my_collection_ids', sessionHeaders(token), {
      method: 'POST',
      headers: Object.assign({}, sessionHeaders(token), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    if (!Array.isArray(rows)) return [];
    return rows
      .map(function (r) { return (r && typeof r === 'object') ? r.id : r; })
      .filter(function (v) { return typeof v === 'string' && v; });
  }

  function httpError(status, text) {
    var e = new Error('HTTP ' + status + ': ' + String(text || '').slice(0, 160));
    e.status = status;
    e.responseText = text || '';
    return e;
  }

  function isPublicDataUnavailableError(error) {
    if (!error) return false;
    var status = Number(error.status);
    var text = String(error.responseText || error.message || '').toLowerCase();
    if (status !== 400 && status !== 403 && status !== 404) return false;
    return text.includes('public_data') ||
      text.includes('column') ||
      text.includes('schema cache') ||
      text.includes('permission denied');
  }

  async function requestJson(url, requestHeaders, options) {
    var requestOptions = Object.assign({ headers: requestHeaders }, options || {});
    var r = await fetch(url, requestOptions);
    if (!r.ok) {
      throw httpError(r.status, await r.text());
    }
    return r.json();
  }

  function firstCollectionField(rows, fieldName) {
    return Array.isArray(rows) && rows[0] ? rows[0][fieldName] : null;
  }

  async function fetchCollection(collId) {
    // Phase 51 (Etappe 7): session-only. The signed-in owner reads via the
    // auth.uid() RPC; there is no owner-token fallback anymore.
    var token = await ensureFreshAccessToken();
    if (!token) throw new Error('Nicht angemeldet — bitte einloggen.');
    return requestJson(SUPA_RPC + '/get_owner_collection_for_user', sessionHeaders(token), {
      method: 'POST',
      headers: Object.assign({}, sessionHeaders(token), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ collection_id: collId }),
    });
  }

  async function fetchPublicCollection(collId) {
    // Phase 27b: Public-Views lesen ausschliesslich die Public Projection.
    // Es gibt keinen Legacy-Fallback auf die private data-Spalte mehr.
    var publicRows = await requestJson(
      SUPA_PUBLIC_REST + '?id=eq.' + collId + '&select=public_data',
      headers(null, false)
    );
    return firstCollectionField(publicRows, 'public_data');
  }

  async function patchCollectionPayload(collId, ownerToken, payload) {
    var r = await fetch(SUPA_REST + '?id=eq.' + collId, {
      method: 'PATCH',
      headers: Object.assign({}, headers(ownerToken, true), {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      }),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      throw httpError(r.status, await r.text());
    }
    return r;
  }

  // ── Phase 36b: Release Intake Staging ─────────────────────────────────────
  // Submits a single allowlist-sanitized release candidate to Supabase staging.
  // Only called when the user has enabled auto-intake AND is in cloud-owner mode.
  // Never contains private collection data; only the fields in INTAKE_ALLOWED_FIELDS.
  //
  // Returns { result: string } where result is one of:
  //   'submitted'       — new pending row inserted in staging
  //   'updated'         — existing row updated (seen again)
  //   'already_adopted' — candidate already adopted into watchlist
  //   'blocked'         — RPC rejected the submission (validation failed)
  //   'error'           — network or unexpected error (non-fatal)
  var INTAKE_ALLOWED_FIELDS = new Set([
    'seriesTitle', 'publisher', 'volumeNumber', 'sourceUrl', 'notes', 'enabled',
  ]);

  async function submitReleaseIntakeCandidate(candidate, ownerToken) {
    if (!ownerToken) return { result: 'blocked' };
    if (!candidate || typeof candidate !== 'object') return { result: 'blocked' };

    var seriesTitle  = String(candidate.seriesTitle  || '').trim();
    var publisher    = String(candidate.publisher    || '').trim();
    var volumeNumber = Number(candidate.volumeNumber);

    if (!seriesTitle || !publisher) return { result: 'blocked' };
    if (!Number.isInteger(volumeNumber) || volumeNumber < 1) return { result: 'blocked' };

    // Strict allowlist: build the body from scratch to prevent field leakage
    var body = {
      p_series_title:  seriesTitle,
      p_publisher:     publisher,
      p_volume_number: volumeNumber,
      p_source_url:    (typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.startsWith('https://'))
                         ? candidate.sourceUrl : null,
      p_notes:         (typeof candidate.notes === 'string' && candidate.notes)
                         ? candidate.notes.slice(0, 500) : null,
      p_enabled:       candidate.enabled !== false,
    };

    // Verify no private fields leaked into the submitted body
    var bodyKeys = Object.keys(body);
    for (var i = 0; i < bodyKeys.length; i++) {
      if (!INTAKE_ALLOWED_FIELDS.has(bodyKeys[i].replace(/^p_/, '').replace(/_([a-z])/g, function(_, c) { return c.toUpperCase(); }))) {
        // Extra safety: reject body if any unexpected key appears
        if (!['p_series_title','p_publisher','p_volume_number','p_source_url','p_notes','p_enabled'].includes(bodyKeys[i])) {
          return { result: 'blocked' };
        }
      }
    }

    try {
      var rpcHeaders = Object.assign({}, headers(ownerToken, true), { 'Content-Type': 'application/json' });
      var result = await requestJson(SUPA_RPC + '/submit_release_intake_candidate', rpcHeaders, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // PostgREST returns scalar text result as a JSON string
      var resultStr = typeof result === 'string' ? result : String(result || 'blocked');
      return { result: resultStr };
    } catch (e) {
      return { result: 'error', message: String(e.message || e).slice(0, 200) };
    }
  }

  // ── Phase 39b: Manga Catalog Candidate Intake (Dual-Write) ───────────────
  // Spiegelt den Phase-36b-Intake zusaetzlich in den zentralen Supabase-Katalog
  // (public.manga_catalog_candidates). Laeuft parallel zum bestehenden RPC,
  // bis Phase 39e die JSON-Queue ersetzt. Nie blockierend, nie privat.
  //
  // Allowlist-Felder (zusaetzlich zu 36b):
  //   sourceKey    — referenziert public.manga_catalog_sources.source_key
  //   releaseDate  — ISO-8601 (YYYY-MM-DD)
  //   isbn13       — optionale ISBN
  //   coverUrl     — optionale https-URL
  //   origin       — Whitelist: browser | pending-queue | coverage-gap | watchlist | provider | manual | intake
  //
  // Returns { result: string } analog zu submitReleaseIntakeCandidate; zusaetzliche
  // Werte: 'already_verified', 'already_rejected'.
  var CATALOG_INTAKE_ALLOWED_KEYS = [
    'p_series_title', 'p_publisher', 'p_volume_number',
    'p_source_url', 'p_source_key', 'p_release_date',
    'p_isbn13', 'p_cover_url', 'p_origin', 'p_metadata',
  ];
  var CATALOG_INTAKE_ORIGINS = new Set([
    'browser', 'pending-queue', 'coverage-gap', 'watchlist', 'provider', 'manual', 'intake',
  ]);
  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var ISBN_RE = /^[0-9Xx]{10,13}$/;

  async function submitMangaCatalogCandidate(candidate, ownerToken) {
    if (!ownerToken) return { result: 'blocked' };
    if (!candidate || typeof candidate !== 'object') return { result: 'blocked' };

    var seriesTitle  = String(candidate.seriesTitle  || '').trim();
    var publisher    = String(candidate.publisher    || '').trim();
    var volumeNumber = Number(candidate.volumeNumber);

    if (!seriesTitle || !publisher) return { result: 'blocked' };
    if (!Number.isInteger(volumeNumber) || volumeNumber < 0) return { result: 'blocked' };

    var origin = (typeof candidate.origin === 'string' && CATALOG_INTAKE_ORIGINS.has(candidate.origin))
      ? candidate.origin : 'browser';

    var body = {
      p_series_title:  seriesTitle,
      p_publisher:     publisher,
      p_volume_number: volumeNumber,
      p_source_url:    (typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.startsWith('https://'))
                         ? candidate.sourceUrl : null,
      p_source_key:    (typeof candidate.sourceKey === 'string' && candidate.sourceKey)
                         ? candidate.sourceKey.toLowerCase().slice(0, 64) : null,
      p_release_date:  (typeof candidate.releaseDate === 'string' && ISO_DATE_RE.test(candidate.releaseDate))
                         ? candidate.releaseDate : null,
      p_isbn13:        (typeof candidate.isbn13 === 'string' && ISBN_RE.test(candidate.isbn13))
                         ? candidate.isbn13 : null,
      p_cover_url:     (typeof candidate.coverUrl === 'string' && candidate.coverUrl.startsWith('https://'))
                         ? candidate.coverUrl : null,
      p_origin:        origin,
      p_metadata:      {},
    };

    // Strict allowlist: reject body if it has any unexpected key
    var bodyKeys = Object.keys(body);
    for (var i = 0; i < bodyKeys.length; i++) {
      if (CATALOG_INTAKE_ALLOWED_KEYS.indexOf(bodyKeys[i]) === -1) {
        return { result: 'blocked' };
      }
    }

    try {
      var rpcHeaders = Object.assign({}, headers(ownerToken, true), { 'Content-Type': 'application/json' });
      var result = await requestJson(SUPA_RPC + '/submit_manga_catalog_candidate', rpcHeaders, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      var resultStr = typeof result === 'string' ? result : String(result || 'blocked');
      return { result: resultStr };
    } catch (e) {
      return { result: 'error', message: String(e.message || e).slice(0, 200) };
    }
  }

  // Phase 51 (Etappe 7): session PATCH via the auth.uid() RLS policy. Uses
  // return=representation to count updated rows; 0 rows means the row is not owned
  // by this user (not claimed) — surfaced as an error, never a silent no-op write.
  async function sessionPatch(collId, accessToken, payload) {
    // select=id limits the returned representation to the id column, which the
    // authenticated role IS allowed to read. Returning the full row would include
    // the private `data` column (no SELECT grant for authenticated) → permission
    // denied. We still get the updated-row count for the 0-row check.
    var r = await fetch(SUPA_REST + '?id=eq.' + collId + '&select=id', {
      method: 'PATCH',
      headers: {
        apikey: SUPA_KEY,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw httpError(r.status, await r.text());
    var rows = await r.json();
    return Array.isArray(rows) ? rows.length : 0;
  }

  async function patchCollection(collId, data, publicData) {
    // Phase 51 (Etappe 7): session-only. No owner-token fallback anymore.
    var token = await ensureFreshAccessToken();
    if (!token) throw new Error('Nicht angemeldet — bitte einloggen.');
    var payload = (publicData !== undefined) ? { data: data, public_data: publicData } : { data: data };
    var n = await sessionPatch(collId, token, payload);
    if (n < 1) throw new Error('Sammlung nicht dem angemeldeten Konto zugeordnet (0 Zeilen).');
    return { publicDataWritten: publicData !== undefined, via: 'session' };
  }

  window.MangaTrackerSupabase = {
    adoptOwnerIfPresent: adoptOwnerIfPresent,
    getOwnerState: getOwnerState,
    headers: headers,
    fetchCollection: fetchCollection,
    fetchPublicCollection: fetchPublicCollection,
    patchCollection: patchCollection,
    hasValidSession: hasValidSession,
    hasSession: hasSession,
    fetchMyCollectionIds: fetchMyCollectionIds,
    submitReleaseIntakeCandidate: submitReleaseIntakeCandidate,
    submitMangaCatalogCandidate:  submitMangaCatalogCandidate,
  };
})();

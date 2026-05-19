(function () {
  var SUPA_URL  = 'https://sssxiqtnkctvyghyrqff.supabase.co';
  var SUPA_KEY  = 'sb_publishable_dHER8ble5X15bPpByKRs8g_fK_01io7';
  var SUPA_REST = SUPA_URL + '/rest/v1/collections';

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

  async function requestJson(url, requestHeaders) {
    var r = await fetch(url, { headers: requestHeaders });
    if (!r.ok) {
      throw httpError(r.status, await r.text());
    }
    return r.json();
  }

  function firstCollectionField(rows, fieldName) {
    return Array.isArray(rows) && rows[0] ? rows[0][fieldName] : null;
  }

  async function fetchCollection(collId, ownerToken) {
    var j = await requestJson(SUPA_REST + '?id=eq.' + collId + '&select=data', headers(ownerToken, false));
    return firstCollectionField(j, 'data');
  }

  async function fetchPublicCollection(collId) {
    // Phase 27a: Public-Views bevorzugen die sichere Projektion.
    // Wenn public_data remote noch fehlt/noch nicht freigegeben ist oder noch keinen
    // Inhalt hat, bleibt der Legacy-Fallback auf data erhalten.
    try {
      var publicRows = await requestJson(SUPA_REST + '?id=eq.' + collId + '&select=public_data', headers(null, false));
      var publicData = firstCollectionField(publicRows, 'public_data');
      if (publicData && Array.isArray(publicData.m)) return publicData;
    } catch (e) {
      if (!isPublicDataUnavailableError(e)) throw e;
    }

    var legacyRows = await requestJson(SUPA_REST + '?id=eq.' + collId + '&select=data', headers(null, false));
    return firstCollectionField(legacyRows, 'data');
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

  async function patchCollection(collId, ownerToken, data, publicData) {
    if (publicData !== undefined) {
      try {
        await patchCollectionPayload(collId, ownerToken, {
          data: data,
          public_data: publicData,
        });
        return { publicDataWritten: true };
      } catch (e) {
        if (!isPublicDataUnavailableError(e)) throw e;
        console.warn('[Phase 27a] public_data not writable yet; falling back to legacy data-only sync.');
      }
    }

    await patchCollectionPayload(collId, ownerToken, { data: data });
    return { publicDataWritten: false };
  }

  window.MangaTrackerSupabase = {
    adoptOwnerIfPresent: adoptOwnerIfPresent,
    getOwnerState: getOwnerState,
    headers: headers,
    fetchCollection: fetchCollection,
    fetchPublicCollection: fetchPublicCollection,
    patchCollection: patchCollection,
  };
})();

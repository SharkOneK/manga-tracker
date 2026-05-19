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

  async function fetchCollection(collId, ownerToken) {
    var r = await fetch(SUPA_REST + '?id=eq.' + collId + '&select=data', {
      headers: headers(ownerToken, false),
    });
    if (!r.ok) {
      var t = await r.text();
      throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 80));
    }
    var j = await r.json();
    return Array.isArray(j) && j[0] ? j[0].data : null;
  }

  async function patchCollection(collId, ownerToken, data) {
    var r = await fetch(SUPA_REST + '?id=eq.' + collId, {
      method: 'PATCH',
      headers: Object.assign({}, headers(ownerToken, true), {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      }),
      body: JSON.stringify({ data: data }),
    });
    if (!r.ok) {
      var t = await r.text();
      throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 80));
    }
  }

  window.MangaTrackerSupabase = {
    adoptOwnerIfPresent: adoptOwnerIfPresent,
    getOwnerState: getOwnerState,
    headers: headers,
    fetchCollection: fetchCollection,
    patchCollection: patchCollection,
  };
})();

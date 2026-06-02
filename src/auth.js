/*
 * Phase 51 — Supabase Auth + Passkeys (Login-UI).
 *
 * Self-contained, opt-in auth layer. It is INERT unless explicitly enabled, so it
 * never affects the public share view or the normal owner-token workflow until the
 * owner turns it on for their own browser.
 *
 * Enable (owner browser only):
 *   localStorage.setItem('mtAuthEnabled', '1')   // then reload
 *   (or set window.MT_AUTH_ENABLED = true before this script runs)
 *
 * Design notes:
 *  - NO @supabase/supabase-js <script> tag in index.html. The ~200 KB UMD bundle is
 *    LAZY-LOADED (dynamic same-origin <script>, allowed under CSP `script-src 'self'`)
 *    only when an auth action actually needs it — public viewers never download it.
 *  - The signed-in display (email in the sidebar foot) is restored from the persisted
 *    Supabase session in localStorage WITHOUT loading the bundle.
 *  - Passkeys need a confirmed, non-anonymous user. The first login bootstraps via
 *    email OTP; afterwards the passkey is the primary login.
 *  - Data sync (src/supabase.js) is intentionally NOT changed here. This step adds
 *    login + passkey + owner-claim. Switching pull/push to the session JWT is a
 *    separate, later step. The owner-claim binds the existing collection to auth.uid()
 *    so that switch becomes possible.
 */
(function () {
  'use strict';

  var SUPA_URL = 'https://sssxiqtnkctvyghyrqff.supabase.co';
  var SUPA_KEY = 'sb_publishable_dHER8ble5X15bPpByKRs8g_fK_01io7';
  var PROJECT_REF = 'sssxiqtnkctvyghyrqff';
  var SESSION_STORAGE_KEY = 'sb-' + PROJECT_REF + '-auth-token';
  var BUNDLE_SRC = './vendor/supabase-js/supabase.umd.js';

  var client = null;
  var bundlePromise = null;

  // ── Enablement / context guards ─────────────────────────────────────────────
  function authEnabled() {
    try {
      if (typeof window !== 'undefined' && window.MT_AUTH_ENABLED === true) return true;
      return localStorage.getItem('mtAuthEnabled') === '1';
    } catch (_) { return false; }
  }

  function isPublicViewContext() {
    try { return !!new URLSearchParams(window.location.search).get('view'); }
    catch (_) { return false; }
  }

  // ── Lazy bundle load (CSP-safe dynamic same-origin script) ──────────────────
  function loadBundle() {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      return Promise.resolve();
    }
    if (bundlePromise) return bundlePromise;
    bundlePromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BUNDLE_SRC;
      s.async = true;
      s.onload = function () {
        if (window.supabase && typeof window.supabase.createClient === 'function') resolve();
        else reject(new Error('supabase-js geladen, aber createClient fehlt'));
      };
      s.onerror = function () { reject(new Error('supabase-js-Bundle konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
    return bundlePromise;
  }

  async function ensureClient() {
    await loadBundle();
    if (client) return client;
    client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        experimental: { passkey: true },
      },
    });
    return client;
  }

  // ── Session display without the bundle ──────────────────────────────────────
  // Reads the persisted Supabase session straight from localStorage so we can show
  // "signed in as X" on reload without paying the 200 KB.
  function readStoredSession() {
    try {
      var raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var sess = parsed && parsed.access_token ? parsed : (parsed && parsed.currentSession) || null;
      if (!sess || !sess.access_token) return null;
      if (sess.expires_at && Number(sess.expires_at) * 1000 < Date.now()) {
        // expired; refresh token may still work, but treat display as signed-out-ish
        return { user: (sess.user || null), expired: true };
      }
      return { user: (sess.user || null), expired: false };
    } catch (_) { return null; }
  }

  // ── Auth operations (each lazy-loads the bundle) ────────────────────────────
  async function getSession() {
    var c = await ensureClient();
    var res = await c.auth.getSession();
    return (res && res.data) ? res.data.session : null;
  }
  async function getUser() {
    var s = await getSession();
    return s ? s.user : null;
  }
  async function signOut() {
    var c = await ensureClient();
    await c.auth.signOut();
  }
  async function startEmailOtp(email) {
    var c = await ensureClient();
    return c.auth.signInWithOtp({ email: email });
  }
  async function verifyEmailOtp(email, token) {
    var c = await ensureClient();
    return c.auth.verifyOtp({ email: email, token: token, type: 'email' });
  }
  async function signInWithPasskey() {
    var c = await ensureClient();
    return c.auth.signInWithPasskey();
  }
  async function registerPasskey() {
    var c = await ensureClient();
    var user = await getUser();
    if (!user) throw new Error('Zum Registrieren eines Passkeys zuerst anmelden.');
    return c.auth.registerPasskey();
  }
  async function listPasskeys() {
    var c = await ensureClient();
    return c.auth.passkey.list();
  }
  async function deletePasskey(passkeyId) {
    var c = await ensureClient();
    return c.auth.passkey.delete({ passkeyId: passkeyId });
  }

  // Bind the legacy token-owned collection to the signed-in user (idempotent).
  async function claimLegacyCollection() {
    await ensureClient();
    var legacy = (window.MangaTrackerSupabase && window.MangaTrackerSupabase.getOwnerState)
      ? window.MangaTrackerSupabase.getOwnerState()
      : { collId: null, ownerToken: null };
    if (!legacy.collId || !legacy.ownerToken) return null;

    var session = await getSession();
    var accessToken = session ? session.access_token : null;
    if (!accessToken) throw new Error('Zum Übernehmen zuerst anmelden.');

    var resp = await fetch(SUPA_URL + '/rest/v1/rpc/claim_collection_for_current_user', {
      method: 'POST',
      headers: {
        apikey: SUPA_KEY,
        Authorization: 'Bearer ' + accessToken,
        'x-owner-token': legacy.ownerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ collection_id: legacy.collId }),
    });
    if (!resp.ok) throw new Error('Claim fehlgeschlagen: HTTP ' + resp.status);
    var claimedId = await resp.json();
    if (claimedId) { try { localStorage.setItem('mtCollectionClaimed', '1'); } catch (_) {} }
    return claimedId;
  }

  // ── Sidebar UI ──────────────────────────────────────────────────────────────
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function setUserName(name) {
    var nameEl = document.getElementById('side-user-name');
    if (nameEl && name) nameEl.textContent = name;
  }

  function setStatus(container, msg, isError) {
    var s = container.querySelector('.auth-status');
    if (!s) { s = el('div', { class: 'auth-status' }); container.appendChild(s); }
    s.textContent = msg || '';
    s.style.color = isError ? 'var(--danger, #ff6b6b)' : 'var(--text-dim, #9aa)';
  }

  function clearChildrenKeepStatus(container) {
    Array.prototype.slice.call(container.children).forEach(function (ch) {
      if (!ch.classList.contains('auth-status')) container.removeChild(ch);
    });
  }

  function renderSignedOut(container) {
    clearChildrenKeepStatus(container);
    var loginBtn = el('button', { type: 'button', class: 'auth-btn' }, '🔑 Anmelden');
    loginBtn.addEventListener('click', function () { onPrimaryLogin(container, loginBtn); });
    container.appendChild(loginBtn);

    var otpToggle = el('button', { type: 'button', class: 'auth-btn auth-btn-soft' }, '✉️ Per E-Mail-Code');
    otpToggle.addEventListener('click', function () { renderEmailOtp(container); });
    container.appendChild(otpToggle);
  }

  function renderEmailOtp(container) {
    clearChildrenKeepStatus(container);
    var emailInput = el('input', { type: 'email', class: 'auth-input', placeholder: 'E-Mail', autocomplete: 'email' });
    var sendBtn = el('button', { type: 'button', class: 'auth-btn' }, 'Code senden');
    var codeInput = el('input', { type: 'text', class: 'auth-input', placeholder: '6-stelliger Code', inputmode: 'numeric', autocomplete: 'one-time-code' });
    codeInput.style.display = 'none';
    var verifyBtn = el('button', { type: 'button', class: 'auth-btn' }, 'Bestätigen');
    verifyBtn.style.display = 'none';
    var back = el('button', { type: 'button', class: 'auth-btn auth-btn-soft' }, '← Zurück');

    sendBtn.addEventListener('click', async function () {
      var email = (emailInput.value || '').trim();
      if (!email) { setStatus(container, 'Bitte E-Mail eingeben.', true); return; }
      sendBtn.disabled = true; setStatus(container, 'Sende Code …');
      try {
        var r = await startEmailOtp(email);
        if (r && r.error) throw r.error;
        codeInput.style.display = ''; verifyBtn.style.display = '';
        setStatus(container, 'Code per E-Mail gesendet. Eintragen und bestätigen.');
      } catch (e) {
        setStatus(container, 'Fehler: ' + (e && e.message ? e.message : e), true);
      } finally { sendBtn.disabled = false; }
    });

    verifyBtn.addEventListener('click', async function () {
      var email = (emailInput.value || '').trim();
      var code = (codeInput.value || '').trim();
      if (!code) { setStatus(container, 'Bitte Code eingeben.', true); return; }
      verifyBtn.disabled = true; setStatus(container, 'Prüfe Code …');
      try {
        var r = await verifyEmailOtp(email, code);
        if (r && r.error) throw r.error;
        await refreshUi();
      } catch (e) {
        setStatus(container, 'Fehler: ' + (e && e.message ? e.message : e), true);
      } finally { verifyBtn.disabled = false; }
    });

    back.addEventListener('click', function () { setStatus(container, ''); renderSignedOut(container); });

    container.appendChild(emailInput);
    container.appendChild(sendBtn);
    container.appendChild(codeInput);
    container.appendChild(verifyBtn);
    container.appendChild(back);
  }

  async function onPrimaryLogin(container, btn) {
    btn.disabled = true; setStatus(container, 'Passkey-Anmeldung …');
    try {
      var r = await signInWithPasskey();
      if (r && r.error) throw r.error;
      await refreshUi();
    } catch (e) {
      // No passkey yet / unsupported / cancelled -> offer email bootstrap.
      setStatus(container, 'Kein Passkey nutzbar — per E-Mail anmelden.', true);
      renderEmailOtp(container);
    } finally { btn.disabled = false; }
  }

  function renderSignedIn(container, user) {
    clearChildrenKeepStatus(container);
    if (user && user.email) setUserName(user.email);

    var passkeyBtn = el('button', { type: 'button', class: 'auth-btn' }, '➕ Passkey hinzufügen');
    passkeyBtn.addEventListener('click', async function () {
      passkeyBtn.disabled = true; setStatus(container, 'Passkey-Registrierung …');
      try {
        var r = await registerPasskey();
        if (r && r.error) throw r.error;
        setStatus(container, 'Passkey registriert ✓');
      } catch (e) {
        setStatus(container, 'Fehler: ' + (e && e.message ? e.message : e), true);
      } finally { passkeyBtn.disabled = false; }
    });
    container.appendChild(passkeyBtn);

    // Owner-claim: show only if a legacy owner token exists and not yet claimed.
    var owner = (window.MangaTrackerSupabase && window.MangaTrackerSupabase.getOwnerState)
      ? window.MangaTrackerSupabase.getOwnerState() : { collId: null, ownerToken: null };
    var alreadyClaimed = false;
    try { alreadyClaimed = localStorage.getItem('mtCollectionClaimed') === '1'; } catch (_) {}
    if (owner.collId && owner.ownerToken && !alreadyClaimed) {
      var claimBtn = el('button', { type: 'button', class: 'auth-btn' }, '🔗 Sammlung übernehmen');
      claimBtn.addEventListener('click', async function () {
        claimBtn.disabled = true; setStatus(container, 'Übernehme Sammlung …');
        try {
          var id = await claimLegacyCollection();
          if (id) { setStatus(container, 'Sammlung übernommen ✓'); claimBtn.remove(); }
          else { setStatus(container, 'Nichts zu übernehmen.', true); }
        } catch (e) {
          setStatus(container, 'Fehler: ' + (e && e.message ? e.message : e), true);
          claimBtn.disabled = false;
        }
      });
      container.appendChild(claimBtn);
    }

    var outBtn = el('button', { type: 'button', class: 'auth-btn auth-btn-soft' }, '↩ Abmelden');
    outBtn.addEventListener('click', async function () {
      outBtn.disabled = true; setStatus(container, 'Abmelden …');
      try { await signOut(); } catch (_) {}
      setUserName('SharkOneK');
      setStatus(container, '');
      renderSignedOut(container);
    });
    container.appendChild(outBtn);
  }

  // Decide UI state. Uses the stored session for display; only loads the bundle
  // when an action requires it.
  async function refreshUi() {
    var container = document.getElementById('auth-controls');
    if (!container) return;
    // If the bundle is already loaded (after an action), trust the live session.
    if (window.supabase && client) {
      try {
        var s = await getSession();
        if (s && s.user) { renderSignedIn(container, s.user); return; }
      } catch (_) {}
      renderSignedOut(container);
      return;
    }
    // Otherwise rely on the persisted session for display (no bundle download).
    var stored = readStoredSession();
    if (stored && stored.user && !stored.expired) renderSignedIn(container, stored.user);
    else renderSignedOut(container);
  }

  function initAuthUi() {
    if (!authEnabled() || isPublicViewContext()) return;
    var container = document.getElementById('auth-controls');
    if (!container) return;
    container.hidden = false;
    refreshUi();
  }

  // ── Public API (for console/testing and future wiring) ──────────────────────
  window.MangaTrackerAuth = {
    isEnabled: authEnabled,
    ensureClient: ensureClient,
    getSession: getSession,
    getUser: getUser,
    signOut: signOut,
    startEmailOtp: startEmailOtp,
    verifyEmailOtp: verifyEmailOtp,
    signInWithPasskey: signInWithPasskey,
    registerPasskey: registerPasskey,
    listPasskeys: listPasskeys,
    deletePasskey: deletePasskey,
    claimLegacyCollection: claimLegacyCollection,
    refreshUi: refreshUi,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthUi);
  } else {
    initAuthUi();
  }
})();

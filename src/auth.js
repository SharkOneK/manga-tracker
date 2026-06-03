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
  // The login is shown by default now (feature verified). It can be force-disabled
  // per browser via window.MT_AUTH_ENABLED === false or localStorage.mtAuthDisabled.
  // The public share view is excluded separately (isPublicViewContext).
  function authEnabled() {
    try {
      if (typeof window !== 'undefined' && window.MT_AUTH_ENABLED === false) return false;
      if (localStorage.getItem('mtAuthDisabled') === '1') return false;
      return true;
    } catch (_) { return true; }
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


  // ── Sidebar UI ──────────────────────────────────────────────────────────────
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function setUserName(name) {
    if (!name) return;
    // Phase 53: Sidebar-Name (Desktop) UND mobiler Konto-Sheet-Name aktualisieren.
    Array.prototype.forEach.call(
      document.querySelectorAll('#side-user-name, .auth-user-name'),
      function (nameEl) { nameEl.textContent = name; }
    );
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
        // Reload so the app re-boots with the session and loads the owner's
        // collection (incl. discovery by auth.uid() on a fresh browser).
        setStatus(container, 'Angemeldet ✓ — lade Sammlung …');
        window.location.reload();
      } catch (e) {
        setStatus(container, 'Fehler: ' + (e && e.message ? e.message : e), true);
        verifyBtn.disabled = false;
      }
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
      // Reload so the app re-boots with the session and loads the collection.
      setStatus(container, 'Angemeldet ✓ — lade Sammlung …');
      window.location.reload();
    } catch (e) {
      // No passkey yet / unsupported / cancelled -> offer email bootstrap.
      setStatus(container, 'Kein Passkey nutzbar — per E-Mail anmelden.', true);
      renderEmailOtp(container);
      btn.disabled = false;
    }
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

    var outBtn = el('button', { type: 'button', class: 'auth-btn auth-btn-soft' }, '↩ Abmelden');
    outBtn.addEventListener('click', async function () {
      outBtn.disabled = true; setStatus(container, 'Abmelden …');
      try { await signOut(); } catch (_) {}
      // Phase 51 (Etappe 7): strict gate — clear local owner data on logout so the
      // collection is not visible without a session. Reload into the locked state.
      try {
        localStorage.removeItem('mtDE');
        localStorage.removeItem('mtCollId');
        localStorage.removeItem('mtOwnerToken');
        localStorage.removeItem('mtCollectionClaimed');
      } catch (_) {}
      window.location.reload();
    });
    container.appendChild(outBtn);
  }

  // Phase 53: render the same state into EVERY .auth-controls container (sidebar
  // on desktop + account sheet on mobile). One logic path, multiple render slots —
  // no duplicate IDs, no second state machine.
  function renderInto(container, signedIn, user) {
    if (signedIn) renderSignedIn(container, user);
    else renderSignedOut(container);
  }

  // Decide UI state. Uses the stored session for display; only loads the bundle
  // when an action requires it.
  async function refreshUi() {
    var containers = document.querySelectorAll('.auth-controls');
    if (!containers.length) return;
    // If the bundle is already loaded (after an action), trust the live session.
    if (window.supabase && client) {
      var liveUser = null;
      try {
        var s = await getSession();
        liveUser = (s && s.user) || null;
      } catch (_) {}
      Array.prototype.forEach.call(containers, function (c) {
        renderInto(c, !!liveUser, liveUser);
      });
      return;
    }
    // Otherwise rely on the persisted session for display (no bundle download).
    // Consistent with the app's strict gate (hasSession): a present session counts
    // as signed-in even if the access token is currently expired — actions refresh
    // it on demand. This avoids showing "Anmelden" while the app shows the data.
    var stored = readStoredSession();
    var signedIn = !!(window.MangaTrackerSupabase &&
      window.MangaTrackerSupabase.hasSession && window.MangaTrackerSupabase.hasSession());
    Array.prototype.forEach.call(containers, function (c) {
      renderInto(c, signedIn, stored && stored.user);
    });
  }

  function initAuthUi() {
    if (!authEnabled() || isPublicViewContext()) return;
    var containers = document.querySelectorAll('.auth-controls');
    if (!containers.length) return;
    Array.prototype.forEach.call(containers, function (c) { c.hidden = false; });
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
    refreshUi: refreshUi,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthUi);
  } else {
    initAuthUi();
  }
})();

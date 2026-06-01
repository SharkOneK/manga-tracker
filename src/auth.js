/*
 * Phase 51 (SCAFFOLD — not wired into index.html yet): Supabase Auth + Passkeys.
 *
 * Why this exists:
 *   The app today authenticates the owner only via an x-owner-token header
 *   (see src/supabase.js) and uses NO @supabase/supabase-js client. Passkeys
 *   (WebAuthn) require a confirmed, non-anonymous Supabase Auth user, which in
 *   turn requires the supabase-js client with `experimental: { passkey: true }`.
 *
 * What this module is:
 *   A thin, feature-flagged wrapper around the vendored supabase-js UMD build
 *   (window.supabase). It is INERT until:
 *     1. vendor/supabase-js/supabase.umd.js is added (see vendor README), and
 *     2. <script src="./vendor/supabase-js/supabase.umd.js"></script> and this
 *        file are added to index.html, and
 *     3. AUTH_ENABLED is flipped on (or window.MT_AUTH_ENABLED is set).
 *
 * Bootstrap reality (important):
 *   signInWithPasskey() only works for a user that already registered a passkey,
 *   and registerPasskey() requires an already-confirmed user. So the very first
 *   onboarding cannot be passkey-only: we bootstrap the user once via email OTP
 *   (signInWithOtp / verifyOtp), then register a passkey for subsequent logins.
 *
 * CSP: index.html uses `script-src 'self'` and a fixed connect-src allowlist.
 *   supabase-js must be vendored locally (no CDN). The Supabase origin is already
 *   in connect-src; no CSP change is needed for the existing project URL.
 */
(function () {
  'use strict';

  // Reuse the same project endpoint/key already used by src/supabase.js.
  var SUPA_URL = 'https://sssxiqtnkctvyghyrqff.supabase.co';
  var SUPA_KEY = 'sb_publishable_dHER8ble5X15bPpByKRs8g_fK_01io7';

  // Master kill-switch. Keep false until vendoring + wiring + DB migration are done.
  var AUTH_ENABLED = (typeof window !== 'undefined' && window.MT_AUTH_ENABLED === true);

  var client = null;

  function isAvailable() {
    return AUTH_ENABLED &&
      typeof window !== 'undefined' &&
      window.supabase &&
      typeof window.supabase.createClient === 'function';
  }

  // Lazily create the singleton client with the passkey opt-in flag.
  function getClient() {
    if (!isAvailable()) return null;
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

  // ── Session helpers ────────────────────────────────────────────────────────
  async function getSession() {
    var c = getClient();
    if (!c) return null;
    var res = await c.auth.getSession();
    return (res && res.data) ? res.data.session : null;
  }

  async function getUser() {
    var s = await getSession();
    return s ? s.user : null;
  }

  async function signOut() {
    var c = getClient();
    if (!c) return;
    await c.auth.signOut();
  }

  // ── Email OTP bootstrap (one-time account creation/confirmation) ────────────
  // Sends a magic-link / OTP code to the address. Required at least once before
  // a passkey can be registered for a brand-new user.
  async function startEmailOtp(email) {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    return c.auth.signInWithOtp({ email: email });
  }

  async function verifyEmailOtp(email, token) {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    return c.auth.verifyOtp({ email: email, token: token, type: 'email' });
  }

  // ── Passkeys (primary day-to-day login) ────────────────────────────────────
  // Sign in via a discoverable credential — no email/username prompt needed.
  async function signInWithPasskey() {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    return c.auth.signInWithPasskey();
  }

  // Register a passkey for the CURRENTLY signed-in user. Call from a settings
  // page or right after the OTP bootstrap.
  async function registerPasskey() {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    var user = await getUser();
    if (!user) throw new Error('must be signed in to register a passkey');
    return c.auth.registerPasskey();
  }

  async function listPasskeys() {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    return c.auth.passkey.list();
  }

  async function deletePasskey(passkeyId) {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');
    return c.auth.passkey.delete({ passkeyId: passkeyId });
  }

  // ── Bridge to the legacy collection (Bestandsmigration) ─────────────────────
  // After sign-in, bind the existing token-owned collection to auth.uid() exactly
  // once, by calling the claim RPC WITH the legacy x-owner-token header as proof.
  // Requires the Phase 51 migration to be applied. Returns the claimed id or null.
  async function claimLegacyCollection() {
    var c = getClient();
    if (!c) throw new Error('auth unavailable');

    var legacy = (window.MangaTrackerSupabase && window.MangaTrackerSupabase.getOwnerState)
      ? window.MangaTrackerSupabase.getOwnerState()
      : { collId: null, ownerToken: null };

    if (!legacy.collId || !legacy.ownerToken) return null; // nothing to claim

    var session = await getSession();
    var accessToken = session ? session.access_token : null;
    if (!accessToken) throw new Error('must be signed in to claim');

    // Direct PostgREST RPC call so we can send BOTH the auth JWT and the
    // x-owner-token proof header in the same request.
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
    if (!resp.ok) {
      throw new Error('claim failed: HTTP ' + resp.status);
    }
    return resp.json(); // claimed uuid or null
  }

  window.MangaTrackerAuth = {
    isAvailable: isAvailable,
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
  };
})();

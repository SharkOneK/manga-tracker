# Vendored `@supabase/supabase-js` (Phase 51)

The app runs on GitHub Pages with a strict CSP (`script-src 'self'`) and **no build
step**. External scripts (e.g. JSZip) are vendored locally, never loaded from a CDN.
Supabase Auth + passkeys need the `@supabase/supabase-js` client, so it must be
vendored here the same way.

> [!NOTE] Status 2026-06-01
> **`supabase.umd.js` is vendored: `@supabase/supabase-js@2.106.2` (≈200 KB, UMD).**
> Verified in the bundle: `signInWithPasskey`, `registerPasskey`, the
> `/passkeys/registration|authentication/*` endpoints (list/update/delete),
> `signInWithOtp`/`verifyOtp` (OTP bootstrap) and the `createClient` export.
> **Not yet wired into `index.html`** — the `<script>` tags are deliberately added
> together with the login UI so the 200 KB are not shipped to public viewers before
> the feature exists. The steps below document how the bundle was produced.

## What to add

A single UMD bundle that exposes a global `window.supabase` with `createClient`:

```
vendor/supabase-js/supabase.umd.js
```

## How to produce it

> Network installs are not available inside the agent sandbox, so this is a
> documented manual step, performed once on a machine with npm access.

```bash
# In a scratch dir (NOT the repo), fetch a pinned version.
# Recommended floor: 2.106.2 (see "Version requirement" below).
npm pack @supabase/supabase-js@2.106.2
tar -xzf supabase-supabase-js-*.tgz
# The UMD build ships in the package:
cp package/dist/umd/supabase.js \
   <repo>/vendor/supabase-js/supabase.umd.js
```

Then load it BEFORE `src/auth.js` in `index.html`:

```html
<script src="./vendor/supabase-js/supabase.umd.js"></script>
<script src="./src/auth.js"></script>
```

## Version requirement (verify before pinning)

The official passkeys docs (https://supabase.com/docs/guides/auth/passkeys, checked
2026-05-31) only require the client opt-in flag:

```ts
createClient(url, key, { auth: { experimental: { passkey: true } } })
```

They do **not** publish a concrete minimum SemVer, and the supabase-js release notes
do not mention passkeys by name — the WebAuthn logic ships inside the bundled
`@supabase/auth-js` dependency. The `v2.105.0+` figure from Backlog 7.5 is **not**
confirmed by any source.

**Research result (2026-06-01):** Passkeys for Supabase Auth (Beta) were announced
**2026-05-25** (changelog 46458). The latest stable supabase-js at that date is
**v2.106.2 (2026-05-25)**. There is no published version floor, so:

- **Recommended pin: `@supabase/supabase-js@2.106.2` or newer stable.** Avoid beta
  channels (e.g. `2.103.0-beta.x`) for production GitHub Pages.
- The pin is only provisional until **empirically verified** — that verification is
  the real gate, not the version number.

Before committing the vendored bundle:

1. **Verify the build exposes** `auth.signInWithPasskey`, `auth.registerPasskey` and
   the `auth.passkey.*` namespace (grep the UMD file or test in a browser console).
   If a given stable lacks them, bump to the next stable and re-check.
2. Record the exact pinned version here and in the Phase 51 plan note.
3. Re-run `scripts/check-secrets.js` and `scripts/security-audit-static.js` — a new
   vendored file must not trip the secret scanner and must keep the audit green.

Sources: https://supabase.com/changelog/46458-passkeys-for-supabase-auth-beta ·
https://github.com/supabase/supabase-js/releases · https://supabase.com/docs/guides/auth/passkeys

## CSP note

`connect-src` in `index.html` already allows the project origin
`https://sssxiqtnkctvyghyrqff.supabase.co`, which is what supabase-js talks to for
auth. No CSP change is needed for the existing project URL. WebAuthn itself uses the
browser `navigator.credentials` API (no extra network origin).

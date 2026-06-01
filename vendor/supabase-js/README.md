# Vendored `@supabase/supabase-js` (Phase 51)

The app runs on GitHub Pages with a strict CSP (`script-src 'self'`) and **no build
step**. External scripts (e.g. JSZip) are vendored locally, never loaded from a CDN.
Supabase Auth + passkeys need the `@supabase/supabase-js` client, so it must be
vendored here the same way.

## What to add

A single UMD bundle that exposes a global `window.supabase` with `createClient`:

```
vendor/supabase-js/supabase.umd.js
```

## How to produce it

> Network installs are not available inside the agent sandbox, so this is a
> documented manual step, performed once on a machine with npm access.

```bash
# In a scratch dir (NOT the repo), fetch a pinned version:
npm pack @supabase/supabase-js@<VERSION>
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

They do **not** publish a concrete minimum SemVer. The `v2.105.0+` figure from
Backlog 7.5 is **not** confirmed by the docs. Before pinning `<VERSION>`:

1. Confirm the chosen build exposes `auth.signInWithPasskey`, `auth.registerPasskey`
   and the `auth.passkey.*` namespace (grep the UMD file or test in a browser).
2. Record the exact pinned version here and in the Phase 51 plan note.
3. Re-run `scripts/check-secrets.js` and `scripts/security-audit-static.js` — a new
   vendored file must not trip the secret scanner and must keep the audit green.

## CSP note

`connect-src` in `index.html` already allows the project origin
`https://sssxiqtnkctvyghyrqff.supabase.co`, which is what supabase-js talks to for
auth. No CSP change is needed for the existing project URL. WebAuthn itself uses the
browser `navigator.credentials` API (no extra network origin).

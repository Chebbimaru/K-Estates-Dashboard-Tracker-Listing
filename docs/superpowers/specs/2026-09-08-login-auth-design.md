# Login & Session Auth — Design

## Purpose

The dashboard (`index.html` + `server.js`) currently has no authentication —
anyone who can reach the server can view and refresh booking data. This adds
a single-account login gate: a user must sign in with `admin` / `admin123`
before the dashboard or its API endpoints are accessible.

## Scope

- One hardcoded account (`admin` / `admin123`), no signup/registration flow,
  no per-employee accounts, no password reset.
- Session-cookie based auth, sessions persisted in the existing SQLite
  database so they survive server restarts.
- Session lifetime: 8 hours from login.
- Out of scope: multi-user accounts, RBAC/permissions, password change UI,
  rate limiting / brute-force protection, HTTPS termination (assumed to be
  handled by whatever reverse proxy/hosting fronts this in production, same
  as today).

## Data model

New table in `db.js` (same SQLite file used for bookings):

```sql
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

- `token`: 32-byte random hex string (`crypto.randomBytes(32).toString('hex')`).
- `expires_at`: ISO timestamp, `created_at + 8h`.
- No `user_id` column — there is only one account, so a valid, unexpired
  session is sufficient proof of identity.

`db.js` gains:
- `createSession(token, createdAt, expiresAt)`
- `getSession(token)` → row or `undefined`
- `deleteSession(token)`
- `deleteExpiredSessions()` — called opportunistically on each session check
  to keep the table small (no need for a cron/interval).

## Credential storage

`auth.js` (new file) hardcodes:
- `ADMIN_USERNAME = 'admin'`
- A scrypt hash + salt for `admin123`, generated once via
  `crypto.scryptSync(password, salt, 64)` and stored as hex constants in the
  file (not the plaintext password). Verifying login re-runs `scryptSync`
  with the stored salt and does a constant-time compare
  (`crypto.timingSafeEqual`) against the stored hash.

This is a static, single-account credential — no user table, no self-service
changes. If the password ever needs to change, the constants in `auth.js`
are regenerated (a short one-off script, not part of this feature).

## Server changes (`server.js`)

New routes:
- `GET /login` → serves `login.html` (public, no auth required).
- `POST /api/login` → body `{ username, password }`. On success: create a
  session row, `Set-Cookie: session_token=<token>; HttpOnly; Path=/;
  Max-Age=28800; SameSite=Lax`, respond `{ ok: true }`. On failure: `401
  { error: 'Invalid username or password' }`.
- `POST /api/logout` → reads the cookie, deletes the matching session row,
  clears the cookie (`Max-Age=0`), responds `{ ok: true }`.

Auth guard (applied to `GET /` and all existing `/api/*` routes except
`/api/login`):
1. Parse `session_token` from the `Cookie` header.
2. Look up the session; if missing or `expires_at` is in the past →
   unauthenticated.
3. Unauthenticated + `GET /` → serve `login.html` instead of the dashboard.
4. Unauthenticated + any `/api/*` route → `401 { error: 'Unauthorized' }`.
5. Authenticated → proceed to the existing handler unchanged.

`getDashboardHtml()`'s mtime-based caching pattern is reused for
`getLoginHtml()` so `login.html` is cached the same way `index.html` is.

## Frontend changes

- New `login.html`: a minimal page styled consistent with the dashboard's
  existing look (same font/color tokens), a form with username + password
  fields, submits via `fetch('/api/login', { method: 'POST', ... })`. On
  success, `window.location.href = '/'`. On failure, show an inline error
  message near the form (no `alert()`).
- `index.html`:
  - Add a "Logout" button next to the existing "Refresh data" button in the
    header.
  - Logout handler: `POST /api/logout`, then `window.location.href =
    '/login'`.
  - `apiGet()` (used by all data-loading calls): if the response status is
    `401`, redirect to `/login` instead of showing the generic error banner.

## Error handling

- Wrong credentials: `401` with a clear error message, shown inline on the
  login form (no distinction between "wrong username" vs "wrong password" —
  avoids leaking which part was wrong).
- Expired/missing session hitting any API route: `401`, frontend redirects
  to `/login`.
- Malformed login request body (missing fields): `400 { error: 'username
  and password are required' }`.

## Testing plan

Manual verification (no existing test framework in this project):
1. `curl -i http://localhost:3055/` with no cookie → serves the login page,
   not the dashboard.
2. `curl -i -X POST http://localhost:3055/api/login -d
   '{"username":"admin","password":"wrong"}'` → `401`.
3. Same with `"admin123"` → `200`, `Set-Cookie` header present.
4. `curl -i http://localhost:3055/api/status` with the returned cookie →
   `200` with booking data.
5. `curl -i -X POST http://localhost:3055/api/logout` with the cookie, then
   repeat step 4 → `401`.
6. Browser pass: open `/`, confirm redirect/login page shown, log in,
   confirm dashboard loads and "Logout" works end-to-end.

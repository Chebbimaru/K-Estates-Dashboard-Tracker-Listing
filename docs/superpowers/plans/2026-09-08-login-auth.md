# Login & Session Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the dashboard behind a single hardcoded login (`admin` / `admin123`) using session-cookie auth, so the dashboard and its API are inaccessible without signing in.

**Architecture:** A new `auth.js` module verifies the one hardcoded credential (stored as a salted scrypt hash, not plaintext) and mints session tokens. Sessions are persisted in the existing SQLite database (`data/bookings.db`, via `db.js`) so they survive server restarts. `server.js` gains a cookie-based auth guard in front of `/` and all `/api/*` routes (except the login endpoint itself), plus `GET /login`, `POST /api/login`, `POST /api/logout` routes. The frontend (`index.html`) gets a Logout button and redirects to `/login` on any `401`.

**Tech Stack:** Plain Node.js `http` server (no framework), `better-sqlite3`, Node's built-in `crypto` module. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-login-auth-design.md`

## Global Constraints

- Single hardcoded account: username `admin`, password `admin123`. Verified via a salted scrypt hash in `auth.js` — the plaintext password is never stored in source.
- Session cookie name: `session_token`, flags `HttpOnly; Path=/; SameSite=Lax`.
- Session lifetime: 8 hours (`SESSION_DURATION_MS = 8 * 60 * 60 * 1000` = `28800000`).
- Sessions are persisted in the existing SQLite database, not in-memory — they must survive a server restart within their 8h window.
- No new npm dependencies — use Node's built-in `crypto` and the existing `better-sqlite3`/`db.js`.

---

## Task 1: Sessions table and helpers in `db.js`

**Files:**
- Modify: `db.js:14-42` (schema block), after the existing prepared statements (`db.js:89-92`), and after the existing functions (`db.js:156-158`) and `module.exports` (`db.js:160-171`)

**Interfaces:**
- Produces: `createSession(token: string, createdAt: string, expiresAt: string): void`, `getSession(token: string): {token, created_at, expires_at} | undefined`, `deleteSession(token: string): void`, `deleteExpiredSessions(): void` — all exported from `./db`.

- [ ] **Step 1: Add the `sessions` table to the schema**

In `db.js`, inside the `db.exec(\`...\`)` template literal (currently `db.js:14-42`), add a new table alongside the existing ones — insert this right after the `status_log` table definition and before the `CREATE INDEX` lines:

```sql
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
```

- [ ] **Step 2: Add prepared statements**

After the existing `AGENT_SUMMARY` prepared statement (`db.js:89-92`), add:

```js
const INSERT_SESSION = db.prepare(`
  INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)
`);

const GET_SESSION = db.prepare(`SELECT * FROM sessions WHERE token = ?`);

const DELETE_SESSION = db.prepare(`DELETE FROM sessions WHERE token = ?`);

const DELETE_EXPIRED_SESSIONS = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);
```

- [ ] **Step 3: Add the session functions**

After the existing `getAgentSummary` function (`db.js:156-158`), add:

```js
function createSession(token, createdAt, expiresAt) {
  INSERT_SESSION.run(token, createdAt, expiresAt);
}

function getSession(token) {
  return GET_SESSION.get(token);
}

function deleteSession(token) {
  DELETE_SESSION.run(token);
}

function deleteExpiredSessions() {
  DELETE_EXPIRED_SESSIONS.run(new Date().toISOString());
}
```

- [ ] **Step 4: Export the new functions**

In `module.exports` (`db.js:160-171`), add the four new functions to the existing list:

```js
module.exports = {
  db,
  upsertBooking,
  markRemoved,
  getBooking,
  getLog,
  getActiveActivityIds,
  getBookings,
  getStatusSummary,
  getStatusEvents,
  getAgentSummary,
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
};
```

- [ ] **Step 5: Verify with an isolated test database**

Run (uses a throwaway DB file so it never touches `data/bookings.db`):

```bash
DB_PATH=/tmp/test-sessions.db node -e "
const assert = require('assert');
const { createSession, getSession, deleteSession, deleteExpiredSessions } = require('./db');

const now = new Date();
const future = new Date(now.getTime() + 60000).toISOString();
const past = new Date(now.getTime() - 60000).toISOString();

createSession('tok-future', now.toISOString(), future);
createSession('tok-past', now.toISOString(), past);

assert.ok(getSession('tok-future'), 'future session should exist');
assert.ok(getSession('tok-past'), 'past session should exist before cleanup');

deleteExpiredSessions();
assert.ok(getSession('tok-future'), 'future session should survive cleanup');
assert.strictEqual(getSession('tok-past'), undefined, 'expired session should be removed by cleanup');

deleteSession('tok-future');
assert.strictEqual(getSession('tok-future'), undefined, 'deleted session should be gone');

console.log('db.js sessions OK');
"
rm -f /tmp/test-sessions.db /tmp/test-sessions.db-wal /tmp/test-sessions.db-shm
```

Expected: prints `db.js sessions OK` with no assertion errors and exit code `0`.

- [ ] **Step 6: Commit**

```bash
git add db.js
git commit -m "$(cat <<'EOF'
Add sessions table and helpers to db.js

Sessions are persisted in the existing SQLite database so logins
survive a server restart within their 8h lifetime.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Np8Y2LvXecEtnfBHeaMKau
EOF
)"
```

---

## Task 2: Credential verification in `auth.js`

**Files:**
- Create: `auth.js`

**Interfaces:**
- Consumes: nothing (self-contained, uses Node's built-in `crypto`)
- Produces: `verifyPassword(username: string, password: string): boolean`, `generateSessionToken(): string` (64 lowercase-hex characters), `SESSION_DURATION_MS: number` (`28800000`) — all exported from `./auth`.

- [ ] **Step 1: Create `auth.js`**

The password `admin123` is never stored in source — only its salted scrypt hash is. The salt/hash below were generated once via `crypto.scryptSync('admin123', salt, 64)`.

```js
const crypto = require('crypto');

const ADMIN_USERNAME = 'admin';
const ADMIN_SALT = 'ec422f7b8f5d960e0eb635a0afdebeef';
const ADMIN_HASH = '6671535daa3af5a1b8cf768607832d1baceebf9c1dd93a456f9002940089de9557dabce43a3f9a507e992956e8c87d5fcb73d3b1993dea510a3859d42ef9a606';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function verifyPassword(username, password) {
  if (username !== ADMIN_USERNAME) return false;
  const hash = crypto.scryptSync(password, ADMIN_SALT, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(ADMIN_HASH, 'hex'));
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { verifyPassword, generateSessionToken, SESSION_DURATION_MS };
```

- [ ] **Step 2: Verify**

```bash
node -e "
const assert = require('assert');
const { verifyPassword, generateSessionToken, SESSION_DURATION_MS } = require('./auth');

assert.strictEqual(verifyPassword('admin', 'admin123'), true, 'correct creds should pass');
assert.strictEqual(verifyPassword('admin', 'wrong'), false, 'wrong password should fail');
assert.strictEqual(verifyPassword('nope', 'admin123'), false, 'wrong username should fail');

const t1 = generateSessionToken();
const t2 = generateSessionToken();
assert.notStrictEqual(t1, t2, 'tokens should be unique');
assert.ok(/^[0-9a-f]{64}\$/.test(t1), 'token should be 64 lowercase-hex chars');
assert.strictEqual(SESSION_DURATION_MS, 28800000, 'session duration should be 8 hours');

console.log('auth.js OK');
"
```

Expected: prints `auth.js OK` with no assertion errors and exit code `0`.

- [ ] **Step 3: Commit**

```bash
git add auth.js
git commit -m "$(cat <<'EOF'
Add auth.js for credential verification and session tokens

Single hardcoded admin account, password stored as a salted scrypt
hash rather than plaintext.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Np8Y2LvXecEtnfBHeaMKau
EOF
)"
```

---

## Task 3: Login page (`login.html`)

**Files:**
- Create: `login.html`

**Interfaces:**
- Consumes: `POST /api/login` (built in Task 4) — sends JSON `{ username, password }`, expects `{ ok: true }` on 200 or `{ error }` on non-2xx.
- Produces: a static page with `#login-form`, `#username`, `#password`, `#submit-btn`, `#login-error` elements, styled consistent with `index.html`'s existing color tokens.

- [ ] **Step 1: Create `login.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in — Property Inventory</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F5F3EE;
    --card: #FFFFFF;
    --ink: #171717;
    --muted: #8C8678;
    --hairline: #E7E1D3;
    --gold: #B08D3E;
    --control-line: #C9C2B2;
    --shadow: 0 2px 6px rgba(20, 16, 8, .05), 0 20px 44px -24px rgba(20, 16, 8, .18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131310;
      --card: #1D1C18;
      --ink: #ECE6D8;
      --muted: #9A9386;
      --hairline: #2E2C27;
      --gold: #C9A950;
      --control-line: #4A463C;
      --shadow: 0 2px 8px rgba(0, 0, 0, .45), 0 24px 60px -24px rgba(0, 0, 0, .7);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-font-smoothing: antialiased; }
  body {
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.5;
    border-top: 3px solid var(--gold);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .login-card {
    background: var(--card); border: 1px solid var(--hairline); box-shadow: var(--shadow);
    padding: 40px 36px; width: 100%; max-width: 360px;
  }
  .eyebrow { font-size: 10px; letter-spacing: .32em; text-transform: uppercase; color: var(--gold); font-weight: 600; margin-bottom: 8px; }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: .08em; margin-bottom: 26px; }
  label { display: block; font-size: 9px; letter-spacing: .24em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; font-weight: 600; }
  .field { margin-bottom: 20px; }
  input {
    width: 100%; padding: 10px 0; border: none; border-bottom: 1px solid var(--control-line); background: transparent;
    font-family: 'Montserrat', sans-serif; font-size: 14px; color: var(--ink); outline: none;
    transition: border-color .25s ease;
  }
  input:focus { border-bottom-color: var(--gold); }
  button {
    width: 100%; margin-top: 8px; padding: 12px; border: 1px solid var(--ink); background: var(--ink); color: var(--bg);
    font-family: 'Montserrat', sans-serif; font-size: 11px; font-weight: 600; letter-spacing: .2em; text-transform: uppercase;
    cursor: pointer; transition: opacity .2s ease;
  }
  button:disabled { opacity: .5; cursor: wait; }
  .error { color: #C0392B; font-size: 12px; margin-top: 14px; display: none; }
</style>
</head>
<body>
  <form class="login-card" id="login-form">
    <div class="eyebrow">K Estates</div>
    <h1>Sign in to Property Inventory</h1>
    <div class="field">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit" id="submit-btn">Sign in</button>
    <div class="error" id="login-error"></div>
  </form>

<script>
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  const errorEl = document.getElementById('login-error');
  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Sign in failed');
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: Verify markup and script syntax**

```bash
grep -c 'id="login-form"' login.html
grep -c 'id="username"' login.html
grep -c 'id="password"' login.html
node -e "
const fs = require('fs');
const html = fs.readFileSync('login.html', 'utf8');
const script = html.split(/<script>/)[1].split('</script>')[0];
new Function(script);
console.log('login.html script syntax OK');
"
```

Expected: each `grep -c` prints `1`, and the syntax check prints `login.html script syntax OK`.

- [ ] **Step 3: Commit**

```bash
git add login.html
git commit -m "$(cat <<'EOF'
Add login page

Standalone page styled consistent with the dashboard; posts
credentials to /api/login (added in the next commit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Np8Y2LvXecEtnfBHeaMKau
EOF
)"
```

---

## Task 4: Wire auth into `server.js`

**Files:**
- Modify: `server.js` (imports at `server.js:1-12`, constants at `server.js:14-16`, `getDashboardHtml` at `server.js:18-25`, `send` at `server.js:27-50`, `readBody` at `server.js:52-60`, route handling at `server.js:62-99`)

**Interfaces:**
- Consumes: Task 1's `createSession`/`getSession`/`deleteSession`/`deleteExpiredSessions` from `./db`; Task 2's `verifyPassword`/`generateSessionToken`/`SESSION_DURATION_MS` from `./auth`; Task 3's `login.html`.
- Produces: `GET /login`, `POST /api/login`, `POST /api/logout`; an auth guard on `GET /` (serves `login.html` when unauthenticated) and every other `/api/*` route (401 JSON when unauthenticated); cookie name `session_token`.

- [ ] **Step 1: Import the new modules**

In `server.js`, replace the existing import block (`server.js:6-12`):

```js
const {
  getBookings,
  getStatusSummary,
  getStatusEvents,
  getAgentSummary,
  getLog,
} = require('./db');
```

with:

```js
const {
  getBookings,
  getStatusSummary,
  getStatusEvents,
  getAgentSummary,
  getLog,
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
} = require('./db');
const { verifyPassword, generateSessionToken, SESSION_DURATION_MS } = require('./auth');
```

- [ ] **Step 2: Add the login page path constant**

Right after `const DASHBOARD = path.join(__dirname, 'index.html');` (`server.js:15`), add:

```js
const LOGIN_PAGE = path.join(__dirname, 'login.html');
```

- [ ] **Step 3: Add `getLoginHtml()`**

Right after the existing `getDashboardHtml()` function (`server.js:18-25`), add:

```js
let loginCache = null; // { mtimeMs, content }
function getLoginHtml() {
  const stat = fs.statSync(LOGIN_PAGE);
  if (!loginCache || loginCache.mtimeMs !== stat.mtimeMs) {
    loginCache = { mtimeMs: stat.mtimeMs, content: fs.readFileSync(LOGIN_PAGE, 'utf-8') };
  }
  return loginCache.content;
}
```

- [ ] **Step 4: Let `send()` accept extra headers (for `Set-Cookie`)**

Replace the `send` function (`server.js:27-50`):

```js
function send(req, res, code, data) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8');
  const headers = {
    'Content-Type': typeof data === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (body.length > COMPRESS_THRESHOLD && acceptEncoding.includes('gzip')) {
    headers.Vary = 'Accept-Encoding';
    return zlib.gzip(body, (err, compressed) => {
      if (err) { res.writeHead(code, headers); return res.end(body); }
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(code, headers);
      res.end(compressed);
    });
  }

  res.writeHead(code, headers);
  res.end(body);
}
```

with:

```js
function send(req, res, code, data, extraHeaders) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8');
  const headers = Object.assign({
    'Content-Type': typeof data === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  }, extraHeaders);

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (body.length > COMPRESS_THRESHOLD && acceptEncoding.includes('gzip')) {
    headers.Vary = 'Accept-Encoding';
    return zlib.gzip(body, (err, compressed) => {
      if (err) { res.writeHead(code, headers); return res.end(body); }
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(code, headers);
      res.end(compressed);
    });
  }

  res.writeHead(code, headers);
  res.end(body);
}
```

(Only the function signature and the `headers` object construction changed — the compression logic is untouched.)

- [ ] **Step 5: Add cookie and session helpers**

Right after the existing `readBody` function (`server.js:52-60`), add:

```js
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function getSessionFromRequest(req) {
  const token = parseCookies(req).session_token;
  if (!token) return null;
  deleteExpiredSessions();
  const session = getSession(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}
```

- [ ] **Step 6: Add the auth routes and guard**

Replace the start of the route handling block (`server.js:66-69`):

```js
  try {
    if (req.method === 'GET' && p === '/') {
      return send(req, res, 200, getDashboardHtml());
    }
```

with:

```js
  try {
    if (req.method === 'GET' && p === '/login') {
      return send(req, res, 200, getLoginHtml());
    }

    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) return send(req, res, 400, { error: 'username and password are required' });
      if (!verifyPassword(username, password)) return send(req, res, 401, { error: 'Invalid username or password' });
      const token = generateSessionToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
      createSession(token, now.toISOString(), expiresAt.toISOString());
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': `session_token=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}; SameSite=Lax`,
      });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const token = parseCookies(req).session_token;
      if (token) deleteSession(token);
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
      });
    }

    if (p.startsWith('/api/') && p !== '/api/login' && !getSessionFromRequest(req)) {
      return send(req, res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'GET' && p === '/') {
      const session = getSessionFromRequest(req);
      return send(req, res, 200, session ? getDashboardHtml() : getLoginHtml());
    }
```

Every other existing route (`/api/bookings`, `/api/status`, `/api/agents`, `/api/history`, `/api/sync`, and the final 404) stays exactly as-is below this — they now sit behind the `/api/*` guard added above them.

- [ ] **Step 7: Verify with curl against an isolated server**

Run this whole block — it starts a throwaway server on port 3099 with a throwaway database, exercises every auth path, then tears itself down:

```bash
PORT=3099 DB_PATH=/tmp/test-auth.db node server.js &
SERVER_PID=$!
sleep 1

echo "-- unauthenticated / should serve login page --"
curl -s http://localhost:3099/ | grep -c 'id="login-form"'   # expect 1

echo "-- wrong password should 401 --"
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3099/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}'  # expect 401

echo "-- correct login should 200 and set a cookie --"
curl -s -c /tmp/test-auth-cookies.txt -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3099/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'  # expect 200
grep -c session_token /tmp/test-auth-cookies.txt  # expect 1

echo "-- authenticated API call should 200 --"
curl -s -b /tmp/test-auth-cookies.txt -o /dev/null -w '%{http_code}\n' http://localhost:3099/api/status  # expect 200

echo "-- unauthenticated API call should 401 --"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3099/api/status  # expect 401

echo "-- logout, then the same session should 401 --"
curl -s -b /tmp/test-auth-cookies.txt -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3099/api/logout  # expect 200
curl -s -b /tmp/test-auth-cookies.txt -o /dev/null -w '%{http_code}\n' http://localhost:3099/api/status  # expect 401

kill $SERVER_PID
rm -f /tmp/test-auth.db /tmp/test-auth.db-wal /tmp/test-auth.db-shm /tmp/test-auth-cookies.txt
```

Expected output, in order: `1`, `401`, `200`, `1`, `200`, `401`, `200`, `401`.

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Wire session auth into server.js

Adds GET /login, POST /api/login, POST /api/logout, and an auth
guard in front of / and every other /api/* route.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Np8Y2LvXecEtnfBHeaMKau
EOF
)"
```

---

## Task 5: Logout button and 401-redirect in `index.html`

**Files:**
- Modify: `index.html` (header markup near `index.html:297-305`, `apiGet` at `index.html:455-459`, listener wiring near `index.html:936-938`)

**Interfaces:**
- Consumes: `POST /api/logout` and the `401` responses from Task 4's auth guard.
- Produces: a `#logout-btn` button in the header; `apiGet()` now redirects to `/login` on `401` instead of surfacing a generic error.

- [ ] **Step 1: Add the Logout button**

In `index.html`, find the `topbar-right` block (`index.html:297-305`):

```html
      <button class="refresh-btn" id="refresh-btn">Refresh data</button>
    </div>
```

Replace with:

```html
      <button class="refresh-btn" id="refresh-btn">Refresh data</button>
      <button class="refresh-btn" id="logout-btn">Logout</button>
    </div>
```

- [ ] **Step 2: Redirect to `/login` on 401 in `apiGet`**

Replace `apiGet` (`index.html:455-459`):

```js
async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('API ' + url + ' failed (HTTP ' + res.status + ')');
  return res.json();
}
```

with:

```js
async function apiGet(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    window.location.href = '/login';
    return new Promise(() => {}); // navigation is underway; don't let callers handle a real response
  }
  if (!res.ok) throw new Error('API ' + url + ' failed (HTTP ' + res.status + ')');
  return res.json();
}
```

- [ ] **Step 3: Wire the Logout button**

Near the existing `document.getElementById('refresh-btn').addEventListener('click', load);` line (`index.html:938`), add:

```js
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});
```

- [ ] **Step 4: Verify markup and script syntax**

```bash
grep -c 'id="logout-btn"' index.html
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const script = html.split(/<script>/)[1].split('</script>')[0];
new Function(script);
console.log('index.html script syntax OK');
"
```

Expected: `1`, then `index.html script syntax OK`.

- [ ] **Step 5: Full browser walkthrough**

Start the real dev server and confirm the end-to-end flow works, matching the spec's testing plan:

```bash
npm run start
```

Then in a browser:
1. Open `http://localhost:3055/` — confirm the login page shows, not the dashboard.
2. Log in with `admin` / `admin123` — confirm you land on the dashboard and it loads booking data.
3. Click "Logout" — confirm you're returned to the login page.
4. Reload `http://localhost:3055/` directly — confirm it still shows the login page (session was actually cleared, not just hidden client-side).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add Logout button and redirect to /login on 401

Completes the login gate: apiGet() now sends the user back to
/login whenever their session is missing or expired.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Np8Y2LvXecEtnfBHeaMKau
EOF
)"
```

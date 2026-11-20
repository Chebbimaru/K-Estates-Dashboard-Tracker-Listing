const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { sync: runSync } = require('./sync');
const {
  getBookings,
  getStatusSummary,
  getStatusEvents,
  getAgentSummary,
  getLog,
  createSession,
  getSession,
  deleteSession,
  deleteAllSessions,
  deleteExpiredSessions,
  getCalendarEvents,
  getSalesDeptAgents,
} = require('./db');
const { verifyPassword, generateSessionToken, changePassword, SESSION_DURATION_MS } = require('./auth');
const { clientIp, isHttps, securityHeaders, createRateLimiter, checkOrigin } = require('./security.cjs');

// Wrong-password guesses (login and change-password): 5 per IP and 50 overall per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginByIp = createRateLimiter({ max: 5, windowMs: LOGIN_WINDOW_MS });
const loginGlobal = createRateLimiter({ max: 50, windowMs: LOGIN_WINDOW_MS });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Single-admin app: the only credential row is 'admin' (see db.js seeding).
// Sessions don't carry a username since there is exactly one account.
const ADMIN_USERNAME = 'admin';

const PORT = process.env.PORT || 3055;
const SYNC_INTERVAL_MS = (Number(process.env.LISTING_SYNC_MINUTES) || 15) * 60 * 1000;

// One sync at a time: the scheduled loop and POST /api/sync share the in-flight run
// instead of starting a second pass against Bitrix.
let syncInFlight = null;
function sync() {
  if (!syncInFlight) syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

// Expired sessions are purged hourly (and once now) instead of on every API request; getSessionFromRequest
// still checks expires_at, so an expired row is never accepted in between.
const SESSION_CLEANUP_MS = 60 * 60 * 1000;
function cleanupSessions() {
  try { deleteExpiredSessions(); } catch (err) { console.error('[listing-tracker] session cleanup failed:', err.message); }
}
cleanupSessions();
setInterval(cleanupSessions, SESSION_CLEANUP_MS).unref();

// Boot-time sync, then on a timer. Runs in the background and never throws, so a slow or
// failing Bitrix can't delay or take down whatever process hosts this app.
function start() {
  const tick = async () => {
    try {
      await sync();
    } catch (err) {
      console.error('[listing-tracker] sync failed:', err.message);
    }
    setTimeout(tick, SYNC_INTERVAL_MS);
  };
  tick();
}

// Path attribute of the session cookie. Root app mounts this at /listing-tracker
// and sets LISTING_COOKIE_PATH accordingly; standalone uses '/'.
const COOKIE_PATH = process.env.LISTING_COOKIE_PATH || '/';
const DASHBOARD = path.join(__dirname, 'index.html');
const LOGIN_SCRIPT = path.join(__dirname, 'login.js');
const COMPRESS_THRESHOLD = 1024;

// Static files are read once per mtime; the gzipped copy is built lazily and kept alongside.
const assetCache = new Map(); // file -> { mtimeMs, body: Buffer, gz: Buffer|null }
function getAsset(file) {
  const stat = fs.statSync(file);
  let entry = assetCache.get(file);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    entry = { mtimeMs: stat.mtimeMs, body: fs.readFileSync(file), gz: null };
    assetCache.set(file, entry);
  }
  return entry;
}

function sendAsset(req, res, file, extraHeaders) {
  const entry = getAsset(file);
  const headers = Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders(req, 'tracker'), extraHeaders);
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (entry.body.length > COMPRESS_THRESHOLD && acceptEncoding.includes('gzip')) {
    if (!entry.gz) entry.gz = zlib.gzipSync(entry.body);
    headers.Vary = 'Accept-Encoding';
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(entry.gz);
  }
  res.writeHead(200, headers);
  res.end(entry.body);
}

function send(req, res, code, data, extraHeaders) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8');
  const headers = Object.assign({
    'Content-Type': typeof data === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, securityHeaders(req, 'tracker'), extraHeaders);

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

// JSON request body, capped at 64 KB. Rejects with HttpError (415 wrong type, 413 too large, 400 bad JSON).
function readBody(req) {
  const MAX_BODY_BYTES = 64 * 1024;
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    let data = '';
    let size = 0;
    let failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        data = '';
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', () => { if (!failed) { failed = true; reject(new HttpError(400, 'Request aborted')); } });
  });
}

function sessionCookie(req, token, maxAgeSeconds) {
  return `session_token=${token}; HttpOnly; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    // Browsers send the most specific Path first; a stale Path=/ cookie from the
    // standalone app must not override the mounted one, so first occurrence wins.
    if (!key || key in cookies) return;
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  });
  return cookies;
}

function getSessionFromRequest(req) {
  const token = parseCookies(req).session_token;
  if (!token) return null;
  const session = getSession(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}

async function handler(req, res) {
  // req.url is already mount-relative when used under Express (prefix stripped).
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/login') {
      res.writeHead(302, { Location: './' });
      return res.end();
    }

    if (req.method === 'GET' && p === '/login.js') {
      return sendAsset(req, res, LOGIN_SCRIPT, { 'Content-Type': 'application/javascript; charset=utf-8' });
    }

    // Cross-site POSTs are refused outright (SameSite=Strict on the cookie is the first line of defence).
    if (req.method === 'POST' && !checkOrigin(req)) return send(req, res, 403, { error: 'Cross-origin request refused' });

    if (req.method === 'POST' && p === '/api/login') {
      const ip = clientIp(req);
      const wait = Math.max(loginByIp.check(ip), loginGlobal.check('*'));
      if (wait) return send(req, res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { 'Retry-After': String(wait) });
      const body = await readBody(req);
      const { username, password } = body;
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return send(req, res, 400, { error: 'username and password are required' });
      }
      if (!(await verifyPassword(username, password))) {
        loginByIp.fail(ip);
        loginGlobal.fail('*');
        console.warn(`[listing-tracker] failed login from ${ip}`);
        return send(req, res, 401, { error: 'Invalid username or password' });
      }
      loginByIp.reset(ip);
      const token = generateSessionToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
      createSession(token, now.toISOString(), expiresAt.toISOString());
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(req, token, Math.floor(SESSION_DURATION_MS / 1000)),
      });
    }

    if (p.startsWith('/api/') && p !== '/api/login' && !getSessionFromRequest(req)) {
      return send(req, res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const token = parseCookies(req).session_token;
      if (token) deleteSession(token);
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(req, '', 0),
      });
    }

    if (req.method === 'POST' && p === '/api/change-password') {
      const ip = clientIp(req);
      const wait = Math.max(loginByIp.check(ip), loginGlobal.check('*'));
      if (wait) return send(req, res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { 'Retry-After': String(wait) });
      const body = await readBody(req);
      const { currentPassword, newPassword } = body;
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
        return send(req, res, 400, { error: 'currentPassword and newPassword are required' });
      }
      const result = await changePassword(ADMIN_USERNAME, currentPassword, newPassword);
      if (!result.ok) {
        const code = result.error === 'current password is incorrect' ? 401 : 400;
        if (code === 401) { loginByIp.fail(ip); loginGlobal.fail('*'); }
        return send(req, res, code, { error: result.error });
      }
      // A new password ends every other session; the caller gets a fresh one.
      deleteAllSessions();
      const token = generateSessionToken();
      const now = new Date();
      createSession(token, now.toISOString(), new Date(now.getTime() + SESSION_DURATION_MS).toISOString());
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(req, token, Math.floor(SESSION_DURATION_MS / 1000)),
      });
    }

    if (req.method === 'GET' && p === '/') {
      return sendAsset(req, res, DASHBOARD);
    }

    if (req.method === 'GET' && p === '/api/bookings') {
      return send(req, res, 200, { bookings: getBookings() });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return send(req, res, 200, {
        bookings: getBookings(),
        summary: getStatusSummary(),
        events: getStatusEvents(),
      });
    }

    if (req.method === 'GET' && p === '/api/agents') {
      return send(req, res, 200, { agents: getAgentSummary() });
    }

    if (req.method === 'GET' && p === '/api/sales-calendar') {
      return send(req, res, 200, { agents: getSalesDeptAgents(), events: getCalendarEvents() });
    }

    if (req.method === 'GET' && p === '/api/history') {
      const activityId = url.searchParams.get('activity_id');
      if (!activityId) return send(req, res, 400, { error: 'activity_id required' });
      return send(req, res, 200, { log: getLog(activityId) });
    }

    if (req.method === 'POST' && p === '/api/sync') {
      const result = await sync();
      return send(req, res, 200, { ok: true, ...result });
    }

    send(req, res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof HttpError) {
      // Drop the rest of an oversized upload once the answer has gone out.
      if (err.status === 413) res.on('finish', () => req.destroy());
      return send(req, res, err.status, { error: err.message }, err.status === 413 ? { Connection: 'close' } : undefined);
    }
    console.error(err);
    send(req, res, 500, { error: 'Internal server error' });
  }
}

module.exports = { handler, start };

if (require.main === module) {
  // Standalone run: pick up ./.env (Node 20.12+); ignore if absent.
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
  const server = http.createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  const port = process.env.PORT || 3055;
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Dashboard + API running at http://localhost:${port}`);
  });
  start();
}

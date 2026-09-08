const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { sync } = require('./sync');
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

const PORT = process.env.PORT || 3055;
const DASHBOARD = path.join(__dirname, 'index.html');
const LOGIN_PAGE = path.join(__dirname, 'login.html');
const COMPRESS_THRESHOLD = 1024;

let dashboardCache = null; // { mtimeMs, content }
function getDashboardHtml() {
  const stat = fs.statSync(DASHBOARD);
  if (!dashboardCache || dashboardCache.mtimeMs !== stat.mtimeMs) {
    dashboardCache = { mtimeMs: stat.mtimeMs, content: fs.readFileSync(DASHBOARD, 'utf-8') };
  }
  return dashboardCache.content;
}

let loginCache = null; // { mtimeMs, content }
function getLoginHtml() {
  const stat = fs.statSync(LOGIN_PAGE);
  if (!loginCache || loginCache.mtimeMs !== stat.mtimeMs) {
    loginCache = { mtimeMs: stat.mtimeMs, content: fs.readFileSync(LOGIN_PAGE, 'utf-8') };
  }
  return loginCache.content;
}

function send(req, res, code, data, extraHeaders) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8');
  const headers = Object.assign({
    'Content-Type': typeof data === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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

function readBody(req) {
  const MAX_BODY_BYTES = 64 * 1024;
  return new Promise((resolve) => {
    let data = '';
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        tooLarge = true;
        data = '';
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) return;
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
  deleteExpiredSessions();
  const session = getSession(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/login') {
      return send(req, res, 200, getLoginHtml());
    }

    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const { username, password } = body;
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return send(req, res, 400, { error: 'username and password are required' });
      }
      if (!verifyPassword(username, password)) return send(req, res, 401, { error: 'Invalid username or password' });
      const token = generateSessionToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
      createSession(token, now.toISOString(), expiresAt.toISOString());
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': `session_token=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}; SameSite=Lax`,
      });
    }

    if (p.startsWith('/api/') && p !== '/api/login' && !getSessionFromRequest(req)) {
      return send(req, res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const token = parseCookies(req).session_token;
      if (token) deleteSession(token);
      return send(req, res, 200, { ok: true }, {
        'Set-Cookie': 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
      });
    }

    if (req.method === 'GET' && p === '/') {
      const session = getSessionFromRequest(req);
      return send(req, res, 200, session ? getDashboardHtml() : getLoginHtml());
    }

    if (req.method === 'GET' && p === '/api/bookings') {
      return send(req, res, 200, { bookings: getBookings() });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return send(req, res, 200, {
        bookings: getBookings(),
        summary: getStatusSummary(),
        events: getStatusEvents(),
        agents: getAgentSummary(),
      });
    }

    if (req.method === 'GET' && p === '/api/agents') {
      return send(req, res, 200, { agents: getAgentSummary() });
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
    console.error(err);
    send(req, res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard + API running at http://localhost:${PORT}`);
});

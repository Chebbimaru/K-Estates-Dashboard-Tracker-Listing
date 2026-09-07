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
} = require('./db');

const PORT = process.env.PORT || 3055;
const DASHBOARD = path.join(__dirname, 'index.html');
const COMPRESS_THRESHOLD = 1024;

let dashboardCache = null; // { mtimeMs, content }
function getDashboardHtml() {
  const stat = fs.statSync(DASHBOARD);
  if (!dashboardCache || dashboardCache.mtimeMs !== stat.mtimeMs) {
    dashboardCache = { mtimeMs: stat.mtimeMs, content: fs.readFileSync(DASHBOARD, 'utf-8') };
  }
  return dashboardCache.content;
}

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

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/') {
      return send(req, res, 200, getDashboardHtml());
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
    send(req, res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard + API running at http://localhost:${PORT}`);
});

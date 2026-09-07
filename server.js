const http = require('http');
const path = require('path');
const fs = require('fs');
const { sync } = require('./sync');
const {
  getBookings,
  getStatusSummary,
  getStatusEvents,
  getAgentSummary,
  getLog,
} = require('./db');

const PORT = process.env.PORT || 3000;
const DASHBOARD = path.join(__dirname, 'index.html');

function send(res, code, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
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
      const html = fs.readFileSync(DASHBOARD, 'utf-8');
      return send(res, 200, html);
    }

    if (req.method === 'GET' && p === '/api/bookings') {
      return send(res, 200, { bookings: getBookings() });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return send(res, 200, {
        bookings: getBookings(),
        summary: getStatusSummary(),
        events: getStatusEvents(),
        agents: getAgentSummary(),
      });
    }

    if (req.method === 'GET' && p === '/api/agents') {
      return send(res, 200, { agents: getAgentSummary() });
    }

    if (req.method === 'GET' && p === '/api/history') {
      const activityId = url.searchParams.get('activity_id');
      if (!activityId) return send(res, 400, { error: 'activity_id required' });
      return send(res, 200, { log: getLog(activityId) });
    }

    if (req.method === 'POST' && p === '/api/sync') {
      const result = await sync();
      return send(res, 200, { ok: true, ...result });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard + API running at http://localhost:${PORT}`);
});

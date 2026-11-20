'use strict';
// Hardening helpers for the listing tracker (headers, rate limiter, origin check).
// Copied from the CRMDash root app so the tracker runs on its own. CommonJS (.cjs) so a root app can still load it.
//
// Environment:
//   TRUST_PROXY=1   believe X-Forwarded-For / X-Forwarded-Proto (only set this behind your own reverse proxy)
//   COOKIE_SECURE=1 always mark session cookies Secure

// Read per call: the tracker loads .env after this module.
const trustProxy = () => process.env.TRUST_PROXY === '1';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientIp(req) {
  if (trustProxy()) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // right-most: the address our own proxy saw
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (req.socket.encrypted) return true;
  return trustProxy() && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// True only for a direct loopback connection. A request relayed by a reverse proxy on the same machine
// also arrives from 127.0.0.1, so any forwarding header disqualifies it.
function isLocalRequest(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  const h = req.headers;
  return !h['x-forwarded-for'] && !h['forwarded'] && !h['x-real-ip'];
}

const BASE_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
};

function buildCsp(kind) {
  const csp = {};
  for (const [k, v] of Object.entries(BASE_CSP)) csp[k] = [...v];
  if (kind === 'dashboard') csp['script-src'].push('https://esm.sh'); // React (and its sub-imports) load from esm.sh
  if (kind === 'tracker') csp['frame-ancestors'] = ["'none'"];
  return Object.entries(csp).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
const CSP = { dashboard: buildCsp('dashboard'), tracker: buildCsp('tracker') };

// kind: 'dashboard' (public, may be framed by signage players) or 'tracker' (login page, never framed)
function securityHeaders(req, kind) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': CSP[kind] || CSP.dashboard,
  };
  if (kind === 'tracker') h['X-Frame-Options'] = 'DENY';
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

// In-memory failure counter per key. check() returns the seconds to wait (0 = allowed).
function createRateLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> [timestamps of failures]
  const recent = key => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  setInterval(() => { for (const k of [...hits.keys()]) recent(k); }, Math.min(windowMs, 60_000)).unref();
  return {
    check(key) {
      const list = recent(key);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - Date.now()) / 1000));
    },
    fail(key) {
      const list = recent(key);
      list.push(Date.now());
      hits.set(key, list);
    },
    reset(key) { hits.delete(key); },
  };
}

// Cross-site POST guard (second line after SameSite): a request that names an Origin must name our own host.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches from older browsers and curl send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = { clientIp, isHttps, isLocalRequest, securityHeaders, createRateLimiter, checkOrigin };

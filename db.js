const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bookings.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    listing TEXT,
    client_name TEXT,
    client_phone TEXT,
    sale_rent TEXT,
    address TEXT,
    responsible TEXT,
    pipeline TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT,
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_responsible ON bookings(responsible);
  CREATE INDEX IF NOT EXISTS idx_statuslog_activity ON status_log(activity_id);
`);

const INSERT_BOOKING = db.prepare(`
  INSERT INTO bookings
    (activity_id, owner_id, listing, client_name, client_phone, sale_rent,
     address, responsible, pipeline, created_at, updated_at, status)
  VALUES
    (@activity_id, @owner_id, @listing, @client_name, @client_phone, @sale_rent,
     @address, @responsible, @pipeline, @created_at, @updated_at, @status)
`);

const GET_BOOKING = db.prepare(`SELECT * FROM bookings WHERE activity_id = ?`);

const UPDATE_BOOKING = db.prepare(`
  UPDATE bookings SET
    owner_id = @owner_id, listing = @listing, client_name = @client_name,
    client_phone = @client_phone, sale_rent = @sale_rent, address = @address,
    responsible = @responsible, pipeline = @pipeline,
    updated_at = @updated_at, status = @status
  WHERE activity_id = @activity_id
`);

const SET_STATUS = db.prepare(
  `UPDATE bookings SET status = ?, updated_at = ? WHERE activity_id = ?`
);

const LOG_EVENT = db.prepare(`
  INSERT INTO status_log (activity_id, event, detail, occurred_at)
  VALUES (?, ?, ?, ?)
`);

const GET_LOG = db.prepare(`
  SELECT * FROM status_log WHERE activity_id = ? ORDER BY occurred_at ASC
`);

const ALL_ACTIVE = db.prepare(`SELECT activity_id FROM bookings WHERE status = 'active'`);

const ALL_BOOKINGS = db.prepare(`SELECT * FROM bookings ORDER BY created_at DESC`);

const STATUS_SUMMARY = db.prepare(`
  SELECT status, COUNT(*) AS count FROM bookings GROUP BY status
`);

const STATUS_EVENTS = db.prepare(`
  SELECT event, COUNT(*) AS count FROM status_log GROUP BY event
`);

const AGENT_SUMMARY = db.prepare(`
  SELECT responsible, status, COUNT(*) AS count
  FROM bookings GROUP BY responsible, status
`);

const INSERT_SESSION = db.prepare(`
  INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)
`);

const GET_SESSION = db.prepare(`SELECT * FROM sessions WHERE token = ?`);

const DELETE_SESSION = db.prepare(`DELETE FROM sessions WHERE token = ?`);

const DELETE_EXPIRED_SESSIONS = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

function upsertBooking(b, now) {
  const existing = GET_BOOKING.get(b.activity_id);
  if (!existing) {
    INSERT_BOOKING.run({ ...b, created_at: now, updated_at: now, status: 'active' });
    LOG_EVENT.run(b.activity_id, 'created', 'Booking created', now);
    return { firstSeen: true, status: 'created' };
  }

  const fields = ['owner_id', 'listing', 'client_name', 'client_phone', 'sale_rent',
                  'address', 'responsible', 'pipeline'];
  const changed = fields.filter(f => (existing[f] || '') !== (b[f] || ''));
  const wasRemoved = existing.status === 'removed';
  const status = wasRemoved ? 'active' : 'active';

  if (wasRemoved) {
    UPDATE_BOOKING.run({ ...b, updated_at: now, status: 'active' });
    LOG_EVENT.run(b.activity_id, 'restored', 'Booking restored / reappeared in CRM', now);
    return { firstSeen: false, status: 'restored' };
  }

  if (changed.length) {
    const detail = changed.map(f => `${f}: ${existing[f] || '(empty)'} -> ${b[f] || '(empty)'}`).join('; ');
    UPDATE_BOOKING.run({ ...b, updated_at: now, status: 'active' });
    LOG_EVENT.run(b.activity_id, 'updated', detail, now);
    return { firstSeen: false, status: 'updated' };
  }

  return { firstSeen: false, status: 'unchanged' };
}

function markRemoved(activity_id, now) {
  const existing = GET_BOOKING.get(activity_id);
  if (!existing || existing.status === 'removed') return { changed: false };
  SET_STATUS.run('removed', now, activity_id);
  LOG_EVENT.run(activity_id, 'removed', 'Booking no longer present in CRM timeline', now);
  return { changed: true };
}

function getBooking(activity_id) {
  return GET_BOOKING.get(activity_id);
}

function getLog(activity_id) {
  return GET_LOG.all(activity_id);
}

function getActiveActivityIds() {
  return ALL_ACTIVE.all().map(r => r.activity_id);
}

function getBookings() {
  return ALL_BOOKINGS.all();
}

function getStatusSummary() {
  return STATUS_SUMMARY.all();
}

function getStatusEvents() {
  return STATUS_EVENTS.all();
}

function getAgentSummary() {
  return AGENT_SUMMARY.all();
}

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

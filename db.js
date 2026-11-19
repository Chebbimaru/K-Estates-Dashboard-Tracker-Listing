const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bookings.db');

// Seed values for the initial admin credential row (only used the very first
// time the credentials table is empty; subsequent password changes replace
// them in the DB via updateCredentials).
const SEED_ADMIN_USERNAME = 'admin';
const SEED_ADMIN_SALT = 'ec422f7b8f5d960e0eb635a0afdebeef';
const SEED_ADMIN_HASH = '6671535daa3af5a1b8cf768607832d1baceebf9c1dd93a456f9002940089de9557dabce43a3f9a507e992956e8c87d5fcb73d3b1993dea510a3859d42ef9a606';

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
    status TEXT NOT NULL DEFAULT 'active',
    sales_department INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS credentials (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_statuslog_activity ON status_log(activity_id);

  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    name TEXT,
    date_from TEXT NOT NULL,
    date_to TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    is_recurring INTEGER NOT NULL DEFAULT 0,
    created_by_owner INTEGER NOT NULL DEFAULT 0,
    is_briefing INTEGER NOT NULL DEFAULT 0,
    occurrences TEXT NOT NULL DEFAULT '',
    lead_id TEXT NOT NULL DEFAULT '',
    lead_title TEXT NOT NULL DEFAULT '',
    lead_client TEXT NOT NULL DEFAULT '',
    lead_phone TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS sales_dept_agents (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_events_status_date ON calendar_events(status, date_from);
`);

// Superseded/unused indexes: idx_calendar_events_status is a prefix of the (status, date_from) index above, and no
// query filters or orders on calendar_events.owner_name or bookings.responsible alone.
db.exec(`
  DROP INDEX IF EXISTS idx_calendar_events_status;
  DROP INDEX IF EXISTS idx_calendar_events_owner;
  DROP INDEX IF EXISTS idx_bookings_responsible;
`);

// Additive migration for DBs created before sales_department existed.
const hasSalesDeptColumn = db.prepare(`PRAGMA table_info(bookings)`).all()
  .some(col => col.name === 'sales_department');
if (!hasSalesDeptColumn) {
  db.exec(`ALTER TABLE bookings ADD COLUMN sales_department INTEGER NOT NULL DEFAULT 0`);
}

// Additive migration for DBs created before calendar_events.created_by_owner existed
// (1 = the calendar owner is the event's host/creator; filled in by the next sync).
const hasCreatedByOwnerColumn = db.prepare(`PRAGMA table_info(calendar_events)`).all()
  .some(col => col.name === 'created_by_owner');
if (!hasCreatedByOwnerColumn) {
  db.exec(`ALTER TABLE calendar_events ADD COLUMN created_by_owner INTEGER NOT NULL DEFAULT 0`);
}

// Additive migration for DBs created before calendar_events.is_briefing existed
// (1 = the event was made by the briefing creator; filled in by the next sync).
const hasIsBriefingColumn = db.prepare(`PRAGMA table_info(calendar_events)`).all()
  .some(col => col.name === 'is_briefing');
if (!hasIsBriefingColumn) {
  db.exec(`ALTER TABLE calendar_events ADD COLUMN is_briefing INTEGER NOT NULL DEFAULT 0`);
}

// Additive migration for DBs created before calendar_events.occurrences existed
// (JSON array of ISO start times of a recurring series; '' for non-recurring; filled in by the next sync).
const hasOccurrencesColumn = db.prepare(`PRAGMA table_info(calendar_events)`).all()
  .some(col => col.name === 'occurrences');
if (!hasOccurrencesColumn) {
  db.exec(`ALTER TABLE calendar_events ADD COLUMN occurrences TEXT NOT NULL DEFAULT ''`);
}

// Additive migration for DBs created before calendar_events carried CRM lead details
// (lead_id is the Bitrix lead the event is bound to; title/client/phone are filled in by sync).
const calendarColumns = db.prepare(`PRAGMA table_info(calendar_events)`).all().map(col => col.name);
for (const col of ['lead_id', 'lead_title', 'lead_client', 'lead_phone']) {
  if (!calendarColumns.includes(col)) {
    db.exec(`ALTER TABLE calendar_events ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}

// Seed the admin credential row from the hardcoded defaults on first run,
// so existing logins keep working without forcing an immediate change.
if (db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n === 0) {
  db.prepare(`
    INSERT INTO credentials (username, salt, hash, updated_at) VALUES (?, ?, ?, ?)
  `).run(SEED_ADMIN_USERNAME, SEED_ADMIN_SALT, SEED_ADMIN_HASH, new Date().toISOString());
}

const INSERT_BOOKING = db.prepare(`
  INSERT INTO bookings
    (activity_id, owner_id, listing, client_name, client_phone, sale_rent,
     address, responsible, pipeline, created_at, updated_at, status, sales_department)
  VALUES
    (@activity_id, @owner_id, @listing, @client_name, @client_phone, @sale_rent,
     @address, @responsible, @pipeline, @created_at, @updated_at, @status, @sales_department)
`);

const GET_BOOKING = db.prepare(`SELECT * FROM bookings WHERE activity_id = ?`);

const UPDATE_BOOKING = db.prepare(`
  UPDATE bookings SET
    owner_id = @owner_id, listing = @listing, client_name = @client_name,
    client_phone = @client_phone, sale_rent = @sale_rent, address = @address,
    responsible = @responsible, pipeline = @pipeline,
    updated_at = @updated_at, status = @status, sales_department = @sales_department
  WHERE activity_id = @activity_id
`);

const MARK_REMOVED = db.prepare(
  `UPDATE bookings SET status = 'removed', updated_at = ? WHERE activity_id = ? AND status = 'active'`
);

const SET_CREATED_AT = db.prepare(
  `UPDATE bookings SET created_at = ? WHERE activity_id = ?`
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

const DELETE_ALL_SESSIONS = db.prepare(`DELETE FROM sessions`);

const DELETE_EXPIRED_SESSIONS = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

const GET_CREDENTIALS = db.prepare(`SELECT * FROM credentials WHERE username = ?`);

const UPSERT_CREDENTIALS = db.prepare(`
  INSERT INTO credentials (username, salt, hash, updated_at) VALUES (@username, @salt, @hash, @updated_at)
  ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated_at = excluded.updated_at
`);

const INSERT_CALENDAR_EVENT = db.prepare(`
  INSERT INTO calendar_events
    (event_id, owner_id, owner_name, name, date_from, date_to, all_day, location, is_recurring, created_by_owner, is_briefing, occurrences,
     lead_id, lead_title, lead_client, lead_phone, created_at, updated_at, status)
  VALUES
    (@event_id, @owner_id, @owner_name, @name, @date_from, @date_to, @all_day, @location, @is_recurring, @created_by_owner, @is_briefing, @occurrences,
     @lead_id, @lead_title, @lead_client, @lead_phone, @created_at, @updated_at, @status)
`);

const GET_CALENDAR_EVENT = db.prepare(`SELECT * FROM calendar_events WHERE event_id = ?`);

const UPDATE_CALENDAR_EVENT = db.prepare(`
  UPDATE calendar_events SET
    owner_id = @owner_id, owner_name = @owner_name, name = @name,
    date_from = @date_from, date_to = @date_to, all_day = @all_day,
    location = @location, is_recurring = @is_recurring, created_by_owner = @created_by_owner, is_briefing = @is_briefing, occurrences = @occurrences,
    lead_id = @lead_id, lead_title = @lead_title, lead_client = @lead_client, lead_phone = @lead_phone,
    updated_at = @updated_at, status = @status
  WHERE event_id = @event_id
`);

const MARK_CALENDAR_EVENT_REMOVED = db.prepare(
  `UPDATE calendar_events SET status = 'removed', updated_at = ? WHERE event_id = ? AND status = 'active'`
);

const ALL_ACTIVE_CALENDAR_EVENTS = db.prepare(`SELECT event_id FROM calendar_events WHERE status = 'active'`);

// Lead details already stored on active events, used as a fallback when a fresh lead fetch misses a lead.
const STORED_LEAD_DETAILS = db.prepare(`
  SELECT lead_id, lead_title, lead_client, lead_phone FROM calendar_events
  WHERE status = 'active' AND lead_id != '' AND (lead_title != '' OR lead_client != '')
  ORDER BY date_from ASC
`);

const ALL_CALENDAR_EVENTS = db.prepare(`SELECT * FROM calendar_events WHERE status = 'active' ORDER BY date_from ASC`);

const DELETE_SALES_DEPT_AGENTS = db.prepare(`DELETE FROM sales_dept_agents`);

const INSERT_SALES_DEPT_AGENT = db.prepare(`
  INSERT INTO sales_dept_agents (user_id, name, updated_at) VALUES (@user_id, @name, @updated_at)
`);

const ALL_SALES_DEPT_AGENTS = db.prepare(`SELECT * FROM sales_dept_agents ORDER BY name ASC`);

function upsertBooking(b, now) {
  const existing = GET_BOOKING.get(b.activity_id);
  if (!existing) {
    INSERT_BOOKING.run({ ...b, created_at: b.created_at || now, updated_at: now, status: 'active' });
    LOG_EVENT.run(b.activity_id, 'created', 'Booking created', now);
    return { firstSeen: true, status: 'created' };
  }

  // created_at is the booking's real CRM creation time, not when this database first saw it.
  // Correct rows stored before that (or with a fallback value) without logging a CRM change.
  if (b.created_at && existing.created_at !== b.created_at) {
    SET_CREATED_AT.run(b.created_at, b.activity_id);
  }

  const fields = ['owner_id', 'listing', 'client_name', 'client_phone', 'sale_rent',
                  'address', 'responsible', 'pipeline', 'sales_department'];
  const changed = fields.filter(f => (existing[f] || '') !== (b[f] || ''));
  const wasRemoved = existing.status === 'removed';

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
  if (MARK_REMOVED.run(now, activity_id).changes === 0) return { changed: false };
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

// Only a SHA-256 of the session token is stored, so a copy of the database can't be used to hijack live sessions.
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function createSession(token, createdAt, expiresAt) {
  INSERT_SESSION.run(hashToken(token), createdAt, expiresAt);
}

function getSession(token) {
  return GET_SESSION.get(hashToken(token));
}

function deleteSession(token) {
  DELETE_SESSION.run(hashToken(token));
}

function deleteAllSessions() {
  DELETE_ALL_SESSIONS.run();
}

function deleteExpiredSessions() {
  DELETE_EXPIRED_SESSIONS.run(new Date().toISOString());
}

function getCredentials(username) {
  return GET_CREDENTIALS.get(username);
}

function updateCredentials(username, salt, hash) {
  UPSERT_CREDENTIALS.run({ username, salt, hash, updated_at: new Date().toISOString() });
}

function upsertCalendarEvent(ev, now) {
  const existing = GET_CALENDAR_EVENT.get(ev.event_id);
  if (!existing) {
    INSERT_CALENDAR_EVENT.run({ ...ev, created_at: now, updated_at: now, status: 'active' });
    return { firstSeen: true, status: 'created' };
  }

  const fields = ['owner_id', 'owner_name', 'name', 'date_from', 'date_to', 'all_day', 'location', 'is_recurring', 'created_by_owner', 'is_briefing', 'occurrences',
                  'lead_id', 'lead_title', 'lead_client', 'lead_phone'];
  const changed = fields.filter(f => (existing[f] || '') !== (ev[f] || ''));
  const wasRemoved = existing.status === 'removed';

  if (wasRemoved) {
    UPDATE_CALENDAR_EVENT.run({ ...ev, updated_at: now, status: 'active' });
    return { firstSeen: false, status: 'restored' };
  }

  if (changed.length) {
    UPDATE_CALENDAR_EVENT.run({ ...ev, updated_at: now, status: 'active' });
    return { firstSeen: false, status: 'updated' };
  }

  return { firstSeen: false, status: 'unchanged' };
}

function markCalendarEventRemoved(event_id, now) {
  return { changed: MARK_CALENDAR_EVENT_REMOVED.run(now, event_id).changes > 0 };
}

function getActiveCalendarEventIds() {
  return ALL_ACTIVE_CALENDAR_EVENTS.all().map(r => r.event_id);
}

function getStoredLeadDetails() {
  return STORED_LEAD_DETAILS.all();
}

function getCalendarEvents() {
  return ALL_CALENDAR_EVENTS.all();
}

function replaceSalesDeptAgents(agents, now) {
  const tx = db.transaction((rows) => {
    DELETE_SALES_DEPT_AGENTS.run();
    for (const a of rows) INSERT_SALES_DEPT_AGENT.run({ user_id: a.id, name: a.name, updated_at: now });
  });
  tx(agents);
}

function getSalesDeptAgents() {
  return ALL_SALES_DEPT_AGENTS.all();
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
  deleteAllSessions,
  deleteExpiredSessions,
  getCredentials,
  updateCredentials,
  upsertCalendarEvent,
  markCalendarEventRemoved,
  getActiveCalendarEventIds,
  getCalendarEvents,
  getStoredLeadDetails,
  replaceSalesDeptAgents,
  getSalesDeptAgents,
};

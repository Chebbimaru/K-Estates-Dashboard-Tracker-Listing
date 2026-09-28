# Sales Department Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Sales Department tab's booking-derived calendar with each active Sales Department employee's real Bitrix24 calendar schedule.

**Architecture:** Extend the existing `Bitrix24 → sync.js → SQLite (db.js) → server.js REST → index.html` pipeline with a second, parallel data domain (roster + calendar events) alongside the existing bookings domain. No shared tables between the two domains; they're joined only in the frontend, per-tab.

**Tech Stack:** Plain Node `http` server, better-sqlite3 (WAL mode), vanilla JS in `index.html`, Bitrix24 REST webhook. No test framework, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-sales-department-calendar-design.md`

## Global Constraints

- No new npm dependencies. No test framework exists in this repo — verify with `node --check`, live `npm run sync` runs, direct `sqlite3` inspection, and static ID-integrity checks on `index.html`, matching this repo's established convention.
- `SALES_DEPARTMENT_ID = 5` already exists as a constant in `sync.js` (from earlier `sales_department` field work) — reuse it, do not redefine.
- The current, correct Bitrix24 webhook token is already in place in `sync.js` (`WEBHOOK` constant) — do not change it.
- Recurring calendar events (`RRULE`) store only their anchor/first occurrence for v1 — do not implement recurrence expansion.
- Sync window: 3 months back, 6 months forward from "now" at sync time.
- **Do not commit after each task.** Leave all changes unstaged in the working tree for the user to review as a whole, consistent with this session's established practice (only the design spec doc itself was committed). Omit any "commit" step you'd otherwise expect from the task template.
- Do not touch `sync.js`'s existing booking-sync logic (`buildBookings`, the booking half of `sync()`) beyond adding new code alongside it.
- Server.js's existing session-auth guard (`p.startsWith('/api/') && p !== '/api/login' && !getSessionFromRequest(req)`) already covers any new `/api/*` route automatically — do not add a second auth check.
- This session does not know the current admin password (it was changed outside this session). Any verification step requiring an authenticated HTTP request must say so explicitly and fall back to direct function/DB-level verification instead of failing silently.

---

### Task 1: Database layer — `calendar_events` and `sales_dept_agents` tables

**Files:**
- Modify: `db.js`

**Interfaces:**
- Produces: `upsertCalendarEvent(ev, now)` → `{ firstSeen: bool, status: 'created'|'updated'|'restored'|'unchanged' }`, where `ev = { event_id, owner_id, owner_name, name, date_from, date_to, all_day, location, is_recurring }` (all strings except `all_day`/`is_recurring` which are `0`/`1` integers).
- Produces: `markCalendarEventRemoved(event_id, now)` → `{ changed: bool }`.
- Produces: `getActiveCalendarEventIds()` → `string[]` of `event_id`.
- Produces: `getCalendarEvents()` → array of full `calendar_events` rows where `status = 'active'`, ordered by `date_from ASC`.
- Produces: `replaceSalesDeptAgents(agents, now)` where `agents = [{ id, name }, ...]` — wholesale-replaces the roster snapshot (delete-all then insert, no diff/history tracking).
- Produces: `getSalesDeptAgents()` → array of `{ user_id, name, updated_at }` rows, ordered by `name ASC`.

- [ ] **Step 1: Add the two new tables to the existing `db.exec(...)` schema block**

Open `db.js`. Find the `CREATE INDEX IF NOT EXISTS idx_statuslog_activity ...` line (currently the last statement inside the big `db.exec(\`...\`)` template literal that starts at the `CREATE TABLE IF NOT EXISTS bookings` line). Add two new tables and their indexes right before the closing `` ` ``` of that block:

```sql
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS sales_dept_agents (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status);
  CREATE INDEX IF NOT EXISTS idx_calendar_events_owner ON calendar_events(owner_name);
```

Note: `event_id` is NOT the raw Bitrix `ID` — it will be built by the caller as `"<owner_id>:<bitrix event ID>"` (see Task 2) to avoid any risk of ID collisions across different agents' calendars. `db.js` itself doesn't need to know this — it just stores whatever unique string it's given.

No `sales_department` migration pattern is needed here (unlike the `bookings.sales_department` column added earlier) because these are brand-new tables, not new columns on an existing table — `CREATE TABLE IF NOT EXISTS` handles first-run and re-run identically.

- [ ] **Step 2: Add prepared statements**

Add these near the existing prepared statements (after `UPSERT_CREDENTIALS`, before `function upsertBooking`):

```js
const INSERT_CALENDAR_EVENT = db.prepare(`
  INSERT INTO calendar_events
    (event_id, owner_id, owner_name, name, date_from, date_to, all_day, location, is_recurring, created_at, updated_at, status)
  VALUES
    (@event_id, @owner_id, @owner_name, @name, @date_from, @date_to, @all_day, @location, @is_recurring, @created_at, @updated_at, @status)
`);

const GET_CALENDAR_EVENT = db.prepare(`SELECT * FROM calendar_events WHERE event_id = ?`);

const UPDATE_CALENDAR_EVENT = db.prepare(`
  UPDATE calendar_events SET
    owner_id = @owner_id, owner_name = @owner_name, name = @name,
    date_from = @date_from, date_to = @date_to, all_day = @all_day,
    location = @location, is_recurring = @is_recurring,
    updated_at = @updated_at, status = @status
  WHERE event_id = @event_id
`);

const SET_CALENDAR_EVENT_STATUS = db.prepare(
  `UPDATE calendar_events SET status = ?, updated_at = ? WHERE event_id = ?`
);

const ALL_ACTIVE_CALENDAR_EVENTS = db.prepare(`SELECT event_id FROM calendar_events WHERE status = 'active'`);

const ALL_CALENDAR_EVENTS = db.prepare(`SELECT * FROM calendar_events WHERE status = 'active' ORDER BY date_from ASC`);

const DELETE_SALES_DEPT_AGENTS = db.prepare(`DELETE FROM sales_dept_agents`);

const INSERT_SALES_DEPT_AGENT = db.prepare(`
  INSERT INTO sales_dept_agents (user_id, name, updated_at) VALUES (@user_id, @name, @updated_at)
`);

const ALL_SALES_DEPT_AGENTS = db.prepare(`SELECT * FROM sales_dept_agents ORDER BY name ASC`);
```

- [ ] **Step 3: Add the functions**

Add these after the existing `updateCredentials` function, before `module.exports`:

```js
function upsertCalendarEvent(ev, now) {
  const existing = GET_CALENDAR_EVENT.get(ev.event_id);
  if (!existing) {
    INSERT_CALENDAR_EVENT.run({ ...ev, created_at: now, updated_at: now, status: 'active' });
    return { firstSeen: true, status: 'created' };
  }

  const fields = ['owner_id', 'owner_name', 'name', 'date_from', 'date_to', 'all_day', 'location', 'is_recurring'];
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
  const existing = GET_CALENDAR_EVENT.get(event_id);
  if (!existing || existing.status === 'removed') return { changed: false };
  SET_CALENDAR_EVENT_STATUS.run('removed', now, event_id);
  return { changed: true };
}

function getActiveCalendarEventIds() {
  return ALL_ACTIVE_CALENDAR_EVENTS.all().map(r => r.event_id);
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
```

- [ ] **Step 4: Export the new functions**

In `module.exports`, add after `updateCredentials,`:

```js
  upsertCalendarEvent,
  markCalendarEventRemoved,
  getActiveCalendarEventIds,
  getCalendarEvents,
  replaceSalesDeptAgents,
  getSalesDeptAgents,
```

- [ ] **Step 5: Verify — schema and functions work in isolation**

Run this against a throwaway DB file so it never touches real data:

```bash
cd /Users/farooqabbasi/Downloads/Shayan/Dashboard-Tracker-Listing
rm -f /tmp/cal-events-test.db*
DB_PATH=/tmp/cal-events-test.db node -e "
const db = require('./db');
console.log('tables:', db.db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));

const now = new Date().toISOString();
db.replaceSalesDeptAgents([{ id: '1', name: 'Test Agent' }], now);
console.log('roster:', db.getSalesDeptAgents());

const ev = { event_id: '1:100', owner_id: '1', owner_name: 'Test Agent', name: 'Test Meeting', date_from: now, date_to: now, all_day: 0, location: 'Office', is_recurring: 0 };
console.log('insert:', db.upsertCalendarEvent(ev, now));
console.log('insert again unchanged:', db.upsertCalendarEvent(ev, now));
console.log('active ids:', db.getActiveCalendarEventIds());
console.log('events:', db.getCalendarEvents());
console.log('remove:', db.markCalendarEventRemoved('1:100', now));
console.log('active ids after remove:', db.getActiveCalendarEventIds());
"
rm -f /tmp/cal-events-test.db*
```

Expected: `tables` includes `calendar_events` and `sales_dept_agents`; roster shows the one test agent; first insert returns `{firstSeen: true, status: 'created'}`, second returns `{firstSeen: false, status: 'unchanged'}`; active ids includes `'1:100'` before removal and is empty after.

- [ ] **Step 6: `node --check db.js`**

Run: `node --check db.js`
Expected: no output (success).

---

### Task 2: Bitrix24 sync — roster + calendar events

**Files:**
- Modify: `sync.js`

**Interfaces:**
- Consumes (from Task 1): `upsertCalendarEvent`, `markCalendarEventRemoved`, `getActiveCalendarEventIds`, `replaceSalesDeptAgents` (all from `./db`).
- Produces: `fetchSalesDeptRoster()` → `Promise<Array<{ id: string, name: string }>>`.
- Produces: `buildCalendarEvents()` → `Promise<{ roster: Array<{id,name}>, events: Record<string, EventRow> }>`, where `EventRow` matches the shape `upsertCalendarEvent` expects.
- Produces: `sync()`'s return value gains `calCreated`, `calUpdated`, `calRestored`, `calRemoved` fields alongside the existing `created`, `updated`, `restored`, `removed`.

- [ ] **Step 1: Update the `require('./db')` destructure**

At the top of `sync.js`, change:

```js
const {
  upsertBooking,
  markRemoved,
  getActiveActivityIds,
  getStatusSummary,
} = require('./db');
```

to:

```js
const {
  upsertBooking,
  markRemoved,
  getActiveActivityIds,
  getStatusSummary,
  upsertCalendarEvent,
  markCalendarEventRemoved,
  getActiveCalendarEventIds,
  replaceSalesDeptAgents,
} = require('./db');
```

- [ ] **Step 2: Add the roster + calendar-events fetch functions**

Add these after `fetchUsers` (which ends with `return { names, salesDeptIds };` / `}`), before `async function buildBookings()`:

```js
async function fetchSalesDeptRoster() {
  const res = await callApi('user.get', { filter: { UF_DEPARTMENT: SALES_DEPARTMENT_ID, ACTIVE: true } });
  return (res.result || []).map(u => ({
    id: String(u.ID),
    name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || u.LOGIN || String(u.ID),
  }));
}

function calendarSyncWindow() {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setMonth(to.getMonth() + 6);
  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

async function fetchCalendarEventsForUser(ownerId, from, to) {
  const res = await callApi('calendar.event.get', { type: 'user', ownerId, from, to });
  return (res.result || []).filter(ev => ev.DELETED !== 'Y');
}

async function buildCalendarEvents() {
  const roster = await fetchSalesDeptRoster();
  const { from, to } = calendarSyncWindow();
  const events = {};
  for (const agent of roster) {
    let raw;
    try {
      raw = await fetchCalendarEventsForUser(agent.id, from, to);
    } catch (err) {
      console.warn(`  [calendar] skipping ${agent.name} (${agent.id}): ${err.message}`);
      continue;
    }
    for (const ev of raw) {
      const eventId = agent.id + ':' + String(ev.ID);
      events[eventId] = {
        event_id: eventId,
        owner_id: agent.id,
        owner_name: agent.name,
        name: String(ev.NAME || ''),
        date_from: new Date(Number(ev.DATE_FROM_TS_UTC) * 1000).toISOString(),
        date_to: ev.DATE_TO_TS_UTC ? new Date(Number(ev.DATE_TO_TS_UTC) * 1000).toISOString() : '',
        all_day: ev.DT_SKIP_TIME === 'Y' ? 1 : 0,
        location: String(ev.LOCATION || ''),
        is_recurring: (ev.RRULE && typeof ev.RRULE === 'object') ? 1 : 0,
      };
    }
  }
  return { roster, events };
}
```

- [ ] **Step 3: Wire into `sync()`**

Find the existing `async function sync()` body. After the existing booking-removal loop (ends with the `for (const activityId of stored) { ... }` block) and before the `const summary = ...` line, insert:

```js
  console.log(`[sync] Fetching Sales Department calendars...`);
  const { roster, events } = await buildCalendarEvents();
  replaceSalesDeptAgents(roster, now);

  let calCreated = 0, calUpdated = 0, calRestored = 0, calRemoved = 0;
  const seenEvents = new Set();
  for (const [eventId, ev] of Object.entries(events)) {
    seenEvents.add(eventId);
    const result = upsertCalendarEvent(ev, now);
    if (result.firstSeen) calCreated++;
    else if (result.status === 'updated') calUpdated++;
    else if (result.status === 'restored') calRestored++;
  }

  const storedEvents = getActiveCalendarEventIds();
  for (const eventId of storedEvents) {
    if (!seenEvents.has(eventId)) {
      const didChange = markCalendarEventRemoved(eventId, now);
      if (didChange.changed) calRemoved++;
    }
  }
  console.log(`[sync] Calendar events -> Created: ${calCreated}, Updated: ${calUpdated}, Restored: ${calRestored}, Removed: ${calRemoved}, Roster: ${roster.length} agents`);
```

Then change the existing return statement from:

```js
  return { created, updated, restored, removed };
```

to:

```js
  return { created, updated, restored, removed, calCreated, calUpdated, calRestored, calRemoved };
```

- [ ] **Step 4: `node --check sync.js`**

Run: `node --check sync.js`
Expected: no output (success).

- [ ] **Step 5: Live verification — full sync run against real Bitrix24 data**

```bash
cd /Users/farooqabbasi/Downloads/Shayan/Dashboard-Tracker-Listing
npm run sync 2>&1
```

Expected: existing booking sync output unchanged, followed by a `[sync] Fetching Sales Department calendars...` line and a `[sync] Calendar events -> Created: N, Updated: 0, Restored: 0, Removed: 0, Roster: 26 agents` line (numbers will vary; `Roster: 26` should match — this was verified live in the design phase of this feature).

- [ ] **Step 6: Inspect the DB directly to confirm the data landed correctly**

```bash
sqlite3 data/bookings.db "SELECT COUNT(*) FROM sales_dept_agents;"
sqlite3 data/bookings.db "SELECT COUNT(*) FROM calendar_events WHERE status = 'active';"
sqlite3 data/bookings.db "SELECT owner_name, name, date_from FROM calendar_events WHERE status = 'active' ORDER BY date_from LIMIT 5;"
```

Expected: `sales_dept_agents` count is 26 (or the current live roster size); `calendar_events` has some active rows; sample rows show real agent names, event names, and ISO `date_from` timestamps (not the ambiguous `DD/MM/YYYY` Bitrix format).

---

### Task 3: Server endpoint

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes (from Task 1): `getCalendarEvents`, `getSalesDeptAgents` (from `./db`).
- Produces: `GET /api/sales-calendar` → `200 { agents: [{user_id, name, updated_at}], events: [...] }` when authenticated; `401` when not (via the existing guard).

- [ ] **Step 1: Add the new functions to the `require('./db')` destructure**

Change:

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
```

to:

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
  getCalendarEvents,
  getSalesDeptAgents,
} = require('./db');
```

- [ ] **Step 2: Add the route**

Find the existing `if (req.method === 'GET' && p === '/api/agents') { ... }` block. Add immediately after it:

```js
    if (req.method === 'GET' && p === '/api/sales-calendar') {
      return send(req, res, 200, { agents: getSalesDeptAgents(), events: getCalendarEvents() });
    }
```

- [ ] **Step 3: `node --check server.js`**

Run: `node --check server.js`
Expected: no output (success).

- [ ] **Step 4: Verify the route works, without needing the admin password**

This session doesn't know the current admin password, so verify at the function level (same DB the running server reads from) instead of over HTTP:

```bash
cd /Users/farooqabbasi/Downloads/Shayan/Dashboard-Tracker-Listing
node -e "
const { getSalesDeptAgents, getCalendarEvents } = require('./db');
console.log('agents:', getSalesDeptAgents().length);
console.log('events:', getCalendarEvents().length);
"
```

Expected: both numbers match what Task 2's Step 7 showed (same DB, same data — this confirms the exact functions the new route calls return real data).

If the person running this plan *does* know the current admin password, they can additionally confirm over HTTP:

```bash
curl -s -c /tmp/cookies.txt -X POST http://localhost:3055/api/login -H "Content-Type: application/json" -d '{"username":"admin","password":"<current password>"}'
curl -s -b /tmp/cookies.txt http://localhost:3055/api/sales-calendar | head -c 300
```

(Requires the server already running via `npm start`, and requires restarting it first since `server.js` changed — restart, then run the above.)

---

### Task 4: Frontend — real schedule data, roster-based Agent filter, event-aware day modal

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes (from Task 3): `GET /api/sales-calendar` → `{ agents, events }`.
- Consumes (existing): `matchesPeriodAndSearch(b)`, `makeCalendarController(opts)`, `esc(s)`, `cellText(v)`, `saleRentBadge`, `statusBadge`, `crmLink`, `state`, `apiGet(url)`.
- Produces: `state.sdAgent` (new state field, default `'all'`).
- Produces: `SALES_CALENDAR` (new global, `{ agents: [{id,name}], events: [...] }` or `null` before first load).
- Produces: `loadSalesCalendarData()` → `Promise<{agents, events}>`.
- Produces: `salesDeptCalendarEvents()` → filtered array of normalized event objects (replaces the old `salesDeptCalendarBookings`, which this task removes).
- Produces: `populateSalesDeptAgentOptions()`.

- [ ] **Step 1: Re-add the Agent dropdown to the Sales Department panel's HTML**

Find (currently around line 460-476):

```html
    <div id="panel-sales-dept" class="panel">
      <div class="card">
        <h2>Sales Department Calendar</h2>
        <div class="hint">Bookings by day for active agents in the Sales Department. Use the Agent filter above to narrow to one agent.</div>
        <div class="cal-nav">
```

Replace with:

```html
    <div id="panel-sales-dept" class="panel">
      <div class="card">
        <h2>Sales Department Calendar</h2>
        <div class="hint">Real Bitrix24 calendar schedule for active agents in the Sales Department.</div>
        <div class="controls cal-controls">
          <div>
            <label>Agent</label>
            <select id="sd-agent-filter"><option value="all">All active agents</option></select>
          </div>
        </div>
        <div class="cal-nav">
```

(The `.cal-controls` CSS class already exists from earlier work — no new CSS needed.)

- [ ] **Step 2: Add `state.sdAgent` and the `SALES_CALENDAR` global**

Find:

```js
const state = {
  period: 'all', agent: 'all', type: 'all', search: '', status: 'all',
  calAgent: 'all', calType: 'all',
};
let DATA = null; // { bookings: [...], summary: [...], events: [...], meta: {...} }
```

Replace with:

```js
const state = {
  period: 'all', agent: 'all', type: 'all', search: '', status: 'all',
  calAgent: 'all', calType: 'all', sdAgent: 'all',
};
let DATA = null; // { bookings: [...], summary: [...], events: [...], meta: {...} }
let SALES_CALENDAR = null; // { agents: [{id,name}], events: [...normalized event bookings] }
```

- [ ] **Step 3: Add `loadSalesCalendarData()`**

Add immediately after the existing `loadData()` function (which ends with its closing `}` before `// ---------- Rendering ----------`):

```js
// Loads the Sales Department's real Bitrix24 calendar schedule (roster + events)
async function loadSalesCalendarData() {
  const payload = await apiGet('/api/sales-calendar');
  const events = (payload.events || []).map(ev => ({
    kind: 'event',
    booking_date: (ev.date_from || '').slice(0, 16),
    date_from: ev.date_from || '',
    date_to: ev.date_to || '',
    all_day: !!ev.all_day,
    location: ev.location || '',
    listing: ev.name || '',
    client_name: '',
    client_phone: '',
    address: ev.location || '',
    pipeline: '',
    responsible: ev.owner_name || 'Unknown',
    sale_rent: '',
    status: 'active',
  }));
  return {
    agents: payload.agents || [],
    events: events,
  };
}
```

- [ ] **Step 4: Replace `salesDeptCalendarBookings()` with `salesDeptCalendarEvents()`**

Find:

```js
// Sales Department tab: always active bookings from Sales Dept agents,
// independent of the top Agent/Type/Status filters (which belong to the
// Bookings/Agent tab), but still respects Period and Search.
function salesDeptCalendarBookings() {
  return DATA.bookings.filter(b => {
    if (!matchesPeriodAndSearch(b)) return false;
    if (b.status !== 'active') return false;
    if (!b.sales_department) return false;
    if (state.agent !== 'all' && b.responsible !== state.agent) return false;
    return true;
  });
}
```

Replace with:

```js
// Sales Department tab: real Bitrix24 calendar events for the department's
// active roster, independent of the Bookings/Agent tab's filters, but
// still respects Period and Search, and its own Agent dropdown.
function salesDeptCalendarEvents() {
  if (!SALES_CALENDAR) return [];
  return SALES_CALENDAR.events.filter(ev => {
    if (!matchesPeriodAndSearch(ev)) return false;
    if (state.sdAgent !== 'all' && ev.responsible !== state.sdAgent) return false;
    return true;
  });
}
```

- [ ] **Step 5: Point the `salesDeptCalendar` controller at the new function**

Find:

```js
const salesDeptCalendar = makeCalendarController({
  gridId: 'sd-cal-grid', monthSelectId: 'sd-cal-month-select', yearSelectId: 'sd-cal-year-select',
  prevId: 'sd-cal-prev', nextId: 'sd-cal-next', todayId: 'sd-cal-today',
  getBookings: salesDeptCalendarBookings,
});
```

Change `getBookings: salesDeptCalendarBookings,` to `getBookings: salesDeptCalendarEvents,`.

- [ ] **Step 6: Fix `populateSelects()` to use each controller's own data, not the hardcoded booking list**

Inside `makeCalendarController`, find:

```js
  function populateSelects() {
    const monthSel = document.getElementById(opts.monthSelectId);
    monthSel.innerHTML = MONTH_NAMES.map((m, i) => '<option value="' + i + '">' + m + '</option>').join('');

    const years = new Set([NOW.getFullYear()]);
    DATA.bookings.forEach(b => {
      const y = parseInt((b.booking_date || '').slice(0, 4), 10);
      if (!isNaN(y)) years.add(y);
    });
```

Change `DATA.bookings.forEach(b => {` to `opts.getBookings().forEach(b => {`. (This is necessary because the Sales Department calendar's year range now comes from real calendar events, not `DATA.bookings` — without this fix, its year dropdown would never include years that only have calendar events, e.g. events further in the future than any existing booking.)

- [ ] **Step 7: Add `populateSalesDeptAgentOptions()`**

Add immediately after the existing `populateCalAgentOptions()` function:

```js
function populateSalesDeptAgentOptions() {
  const agents = (SALES_CALENDAR ? SALES_CALENDAR.agents : []).map(a => a.name).sort();
  const sel = document.getElementById('sd-agent-filter');
  const prev = state.sdAgent;
  sel.innerHTML = '<option value="all">All active agents</option>' + agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
  if (agents.includes(prev)) sel.value = prev;
  else state.sdAgent = 'all';
}
```

- [ ] **Step 8: Wire the new dropdown's change handler**

In `wireControls()`, find:

```js
  document.getElementById('cal-agent-filter').addEventListener('change', e => { state.calAgent = e.target.value; bookingCalendar.render(); });
  document.getElementById('cal-type-filter').addEventListener('change', e => { state.calType = e.target.value; bookingCalendar.render(); });

  bookingCalendar.wire();
  salesDeptCalendar.wire();
```

Replace with:

```js
  document.getElementById('cal-agent-filter').addEventListener('change', e => { state.calAgent = e.target.value; bookingCalendar.render(); });
  document.getElementById('cal-type-filter').addEventListener('change', e => { state.calType = e.target.value; bookingCalendar.render(); });
  document.getElementById('sd-agent-filter').addEventListener('change', e => { state.sdAgent = e.target.value; salesDeptCalendar.render(); });

  bookingCalendar.wire();
  salesDeptCalendar.wire();
```

- [ ] **Step 9: Load the new data and populate the dropdown in `load()`**

Find:

```js
    DATA = await loadData();
    populateAgentOptions();
    populateCalAgentOptions();
    bookingCalendar.populateSelects();
    salesDeptCalendar.populateSelects();
```

Replace with:

```js
    DATA = await loadData();
    SALES_CALENDAR = await loadSalesCalendarData();
    populateAgentOptions();
    populateCalAgentOptions();
    populateSalesDeptAgentOptions();
    bookingCalendar.populateSelects();
    salesDeptCalendar.populateSelects();
```

(`SALES_CALENDAR` must be set before `salesDeptCalendar.populateSelects()` runs, since that now calls `opts.getBookings()` — i.e. `salesDeptCalendarEvents()` — which reads `SALES_CALENDAR`.)

- [ ] **Step 10: Make `openDayModal` render events differently from bookings**

Find the full `openDayModal` function:

```js
function openDayModal(key, dayMap) {
  const items = dayMap[key] || [];
  const d = new Date(key + 'T00:00:00');
  document.getElementById('day-title').textContent =
    d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) +
    ' · ' + items.length + (items.length === 1 ? ' booking' : ' bookings');

  document.getElementById('day-body').innerHTML = items.map(b => {
    return '<div class="log-entry">' +
      '<div class="log-main">' +
        '<div class="log-detail">' + cellText(b.client_name) + ' &middot; ' + saleRentBadge(b.sale_rent) + ' ' + statusBadge(b.status) + '</div>' +
        '<div class="log-time">' + cellText(b.address) + ' &middot; ' + cellText(b.responsible) + '</div>' +
        '<div class="log-time">' + crmLink(b) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('day-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
```

Replace with:

```js
function openDayModal(key, dayMap) {
  const items = dayMap[key] || [];
  const isEvents = items.length > 0 && items[0].kind === 'event';
  const d = new Date(key + 'T00:00:00');
  document.getElementById('day-title').textContent =
    d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) +
    ' · ' + items.length + (items.length === 1 ? (isEvents ? ' event' : ' booking') : (isEvents ? ' events' : ' bookings'));

  document.getElementById('day-body').innerHTML = items.map(b => {
    if (b.kind === 'event') {
      const from = b.date_from ? new Date(b.date_from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      const to = b.date_to ? new Date(b.date_to).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      const time = b.all_day ? 'All day' : [from, to].filter(Boolean).join(' – ');
      return '<div class="log-entry">' +
        '<div class="log-main">' +
          '<div class="log-detail">' + cellText(b.listing) + '</div>' +
          '<div class="log-time">' + esc(time) + (b.location ? ' &middot; ' + cellText(b.location) : '') + '</div>' +
          '<div class="log-time">' + cellText(b.responsible) + '</div>' +
        '</div>' +
      '</div>';
    }
    return '<div class="log-entry">' +
      '<div class="log-main">' +
        '<div class="log-detail">' + cellText(b.client_name) + ' &middot; ' + saleRentBadge(b.sale_rent) + ' ' + statusBadge(b.status) + '</div>' +
        '<div class="log-time">' + cellText(b.address) + ' &middot; ' + cellText(b.responsible) + '</div>' +
        '<div class="log-time">' + crmLink(b) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('day-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
```

- [ ] **Step 11: Static verification**

```bash
cd /Users/farooqabbasi/Downloads/Shayan/Dashboard-Tracker-Listing
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf-8');
const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
matches.forEach((m, i) => fs.writeFileSync('/tmp/index_script_' + i + '.js', m[1]));
console.log(matches.length + ' script block(s) extracted');
"
for f in /tmp/index_script_*.js; do node --check "$f" && echo "$f OK"; done

node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf-8');
const ids = new Set([...html.matchAll(/\bid=[\"']([^\"']+)[\"']/g)].map(m => m[1]));
const getIds = [...html.matchAll(/getElementById\(['\"]([^'\"]+)['\"]\)/g)].map(m => m[1]);
console.log('missing ids:', [...new Set(getIds.filter(id => !ids.has(id)))]);
const dupCounts = {};
[...html.matchAll(/\bid=[\"']([^\"']+)[\"']/g)].map(m => m[1]).forEach(id => dupCounts[id]=(dupCounts[id]||0)+1);
console.log('duplicate ids:', Object.entries(dupCounts).filter(([,c])=>c>1));
"

grep -n "salesDeptCalendarBookings" index.html
```

Expected: script syntax OK; `missing ids: []`; `duplicate ids: []`; the `grep` for the old function name returns nothing (confirms it was fully replaced, not left dangling).

- [ ] **Step 12: Confirm `<script>` ordering is still safe**

```bash
grep -n "<script>\|id=\"sd-agent-filter\"" index.html
```

Expected: the `id="sd-agent-filter"` line number is smaller (earlier in the file) than the `<script>` line number — the new dropdown lives in the HTML body above the script, same as every other control, so no repeat of the earlier ordering bug is possible.

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full sync + server smoke test**

```bash
cd /Users/farooqabbasi/Downloads/Shayan/Dashboard-Tracker-Listing
npm run sync 2>&1
lsof -i :3055 -sTCP:LISTEN 2>/dev/null || (npm start > /tmp/server.log 2>&1 & disown; sleep 1.5; cat /tmp/server.log)
curl -s -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://localhost:3055/
```

Expected: sync completes with the `Calendar events -> ...` summary line; server responds `200` on `/` (serves the login page if not authenticated, which is correct — this only confirms the server itself is up after the `server.js` change).

- [ ] **Step 2: Tell the user manual verification is needed**

This session does not have browser access and does not know the current admin password (changed outside this session earlier). After this plan is executed, tell the user directly: "Implementation done and verified at the sync/DB/server level — please log in and check the Sales Department tab yourself, since I can't click through the UI in this session."

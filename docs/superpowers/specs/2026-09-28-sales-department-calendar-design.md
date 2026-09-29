# Sales Department Calendar — Design

## Purpose

The "Sales Department" tab currently shows a calendar built from CRM viewing
bookings (`bookings.sales_department = 1`), scoped to whichever agents
happen to have a booking assigned to them. That undercounts the department
badly: querying Bitrix24 directly shows 26 active employees in department 5
("Sales Department"), while only 1–2 of them currently have any viewing
booking in our local data.

This replaces that tab's data source with each active Sales Department
employee's real Bitrix24 Calendar (`calendar.event.get`) — their actual
schedule, not a proxy derived from CRM activity records.

## Scope

- Roster: active employees in department 5, fetched live from Bitrix24
  (`user.get`), not derived from booking data.
- Events: each roster member's personal calendar events
  (`calendar.event.get`, `type: 'user'`), pulled on the same `npm run sync`
  run that already syncs bookings.
- Sync window: 3 months back to 6 months forward from "now" at sync time.
- Recurring events (`RRULE`) show only their anchor/first occurrence — full
  recurrence expansion (materializing every future occurrence date) is out
  of scope for v1.
- Out of scope: writing back to Bitrix24 (read-only), per-event edit history
  (`status_log`-style audit trail) for calendar events, showing non-Sales
  Department calendars, company/group calendars (only `type: 'user'`
  personal calendars).

## Data model

New table in `db.js`:

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

CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status);
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner ON calendar_events(owner_name);
```

- `event_id`: Bitrix's `ID` field for the event, unique per event (per
  agent's calendar — Bitrix event IDs are not globally unique across owners
  in general, so uniqueness here relies on `ID` being unique within the set
  we pull; if a collision is ever observed across two different owners, the
  key should become a composite of `owner_id` + `ID` — noted as a risk to
  watch, not expected given Bitrix's ID scheme).
- `all_day`: derived from `DT_SKIP_TIME === 'Y'`.
- `is_recurring`: derived from presence of a non-empty `RRULE` object —
  purely informational for v1 (could surface a "recurring" badge in the UI
  later), does not affect what gets stored (only the anchor occurrence is
  stored either way).
- `status`: `active` / `removed`, following the same diff-based
  create/update/restore/remove pattern already used for `bookings`
  (`upsertBooking` / `markRemoved` in `db.js`). No `status_log`-style
  history table for calendar events in v1 — YAGNI, since the ask is
  visibility into the current schedule, not an audit trail of changes to
  it.

`db.js` gains: `upsertCalendarEvent(ev, now)`, `markCalendarEventsRemoved(activeIds, now)`
(mirroring `markRemoved`/`getActiveActivityIds` for bookings, adapted to
event IDs), `getCalendarEvents()` (`SELECT * FROM calendar_events WHERE status = 'active'`).

## Bitrix24 API usage

Both methods already work against the current webhook token (verified live
in this session — no new scope needed):

1. **Roster** — `user.get`
   ```json
   { "filter": { "UF_DEPARTMENT": 5, "ACTIVE": true } }
   ```
   Returns `ID`, `NAME`, `LAST_NAME` per employee. `SALES_DEPARTMENT_ID = 5`
   is already a constant in `sync.js` from the earlier `sales_department`
   field work — reused here, not redefined.

2. **Events per employee** — `calendar.event.get`
   ```json
   { "type": "user", "ownerId": "<user id>", "from": "<now-3mo>", "to": "<now+6mo>" }
   ```
   Relevant response fields: `ID`, `OWNER_ID`, `NAME`, `DATE_FROM`,
   `DATE_TO`, `DT_SKIP_TIME`, `LOCATION`, `RRULE`, `DELETED`. Events with
   `DELETED === 'Y'` are skipped (treated as not returned, same effect as
   never having existed for this sync).

## Sync flow (`sync.js`)

Extends the existing `sync()` function (single `npm run sync` command does
both bookings and calendar events — no second script to remember):

1. Fetch roster via `user.get` (department filter above).
2. For each roster member, call `calendar.event.get` with the 3-month-back /
   6-month-forward window. **If one member's call fails** (private
   calendar, permission error, etc.), log a warning with their name/ID and
   continue with the rest — one agent's failure must not abort the sync for
   everyone else (same resilience principle as the rest of `sync.js`,
   which already isolates per-item failures where practical).
3. Normalize each returned event into the `calendar_events` row shape,
   `upsertCalendarEvent` each one (diff-based, same semantics as bookings).
4. Any previously-active event not seen in this run gets `markCalendarEventsRemoved`
   (mirrors how a booking that disappears from Bitrix gets marked
   `removed` rather than deleted).
5. Sync summary log line extended to report calendar event counts
   (created/updated/removed), same style as the existing
   `[sync] Done. Created: X, Updated: Y...` line for bookings.

## Server changes (`server.js`)

New route, alongside the existing `/api/*` endpoints, behind the same
session guard (no special-casing needed — it already covers all
`/api/*` paths except `/api/login`):

```
GET /api/sales-calendar
  -> { agents: [{ id, name }, ...], events: [...] }
```

`agents` is the roster (for populating the tab's Agent dropdown);
`events` is `getCalendarEvents()`.

## Frontend changes (`index.html`)

- New `loadSalesCalendarData()` (parallel to `loadData()`), fetching
  `/api/sales-calendar`, called alongside the existing load in `load()`.
- Sales Department tab's Agent dropdown (re-added — this reverses last
  turn's removal, now correctly justified) populated from the roster
  response, not from booking data.
- `salesDeptCalendar` controller's `getBookings` callback switches from
  `salesDeptCalendarBookings()` (booking-derived) to a new
  `salesDeptCalendarEvents()` that filters the fetched calendar events by
  the tab's own Agent selection and reuses `matchesPeriodAndSearch`-style
  date filtering against `date_from`.
- Calendar event objects are normalized to a shape the shared
  `makeCalendarController` day-grid code can consume unchanged
  (`booking_date` derived from `date_from`, `status: 'active'` always,
  since only active events are fetched). No `sale_rent`, so the existing
  Sale/Rent dot rendering naturally degrades to "no dots, just the day
  count" for this calendar — no controller code changes needed, confirmed
  by reading the existing dot-rendering logic (it's guarded by
  `items.length`, not by requiring `sale_rent` to be present).
- `openDayModal` needs a second rendering branch: calendar events show
  event name / time range (from `date_from`/`date_to`) / location / owner
  name, instead of the booking fields (client name, address, sale/rent
  badge, CRM link). Distinguished by a `kind: 'event'` tag added during
  normalization vs. `kind: 'booking'` (or simply: presence/absence of
  `activity_id`, whichever reads cleaner at implementation time — decided
  during planning, not fixed here).

## Known limitations (v1, explicit)

- Recurring events appear once (their anchor occurrence), not on every
  future occurrence.
- Events outside the 3-months-back/6-months-forward sync window won't
  appear until a later sync re-runs with them in range.
- An agent whose calendar the webhook can't read (permissions/private)
  simply won't have events shown, silently from the UI's perspective
  (visible in the sync log, not in the dashboard).

## Testing / verification

No test framework in this repo (per `AGENTS.md`, gitignored but still the
house convention). Verification plan:

- `node --check` on every touched file.
- Extract and `node --check` the inline `<script>` block in `index.html`.
- Missing/duplicate DOM id checks (same static analysis used for the two
  most recent frontend changes in this session).
- Live `npm run sync` run against the real Bitrix24 webhook, followed by
  direct `sqlite3` inspection of `calendar_events` to confirm row counts
  and spot-check a few known agents/events.
- Manual UI check by the user (no browser access in this session, and the
  admin password is not known to this session).

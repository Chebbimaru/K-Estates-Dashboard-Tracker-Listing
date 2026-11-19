# K Estates Dashboard — Tracker & Property Listing Inventory

Dashboard for tracking property viewing bookings from the K Estates Bitrix24 CRM, with status history. Bookings are pulled from Bitrix24, stored in SQLite, and served by a small Node backend.

## Features

- **Session-based login** — username/password auth with HttpOnly cookies (8-hour sessions)
- **Booking / Agent stats** — KPI cards and per-agent viewing charts (Sales vs Rental)
- **Briefings** — third (green) series in Bookings by Agent: calendar events in Maria Detaro's own Bitrix24 calendar (user 2445; she hosts/created them) that have "briefing" in the title, plus her recurring events (e.g. the Weekly Sales Meeting), which are briefings without needing the word in the title; a recurring series is one briefing per Period (counted once if any occurrence falls in it, using its stored `occurrences`). A briefing is listed for every active Sales Department agent (bar segment, table column, agent window, "Briefings only" Show filter) but the Briefings tile counts each distinct briefing once (same title and start, or same recurring series), e.g. 8 briefings, not 8 x 24 agents. An agent's own recurring event is a briefing for that agent only, and a copy of one of Maria's briefings on an agent's own calendar merges into it instead of also counting as that agent's Event created. Briefings are not part of Total (Total = bookings + events created), nor of the number above a column or the sort order. Only her briefings are synced (not her other events) and they do not appear in the Calendar Events tab. Her "Telemarketing" calendar is empty and not used
- **Clickable legend** — click Bookings / Events created / Briefings in the Bookings by Agent legend to show or hide that series across the whole tab (bars and axis, tiles, Total, table, tooltip, agent window); combinations are allowed, the last visible series stays on, and the Show filter follows ("Custom (from legend)" for mixed combinations)
- **Booking Calendar Listing** (Calendar Events tab, above Booking Calendar Lead) — month grid of bookings with sale/rent dots and per-day counts; navigate by month/year or jump to today; click a day to see its bookings and CRM links
- **Listing Details** — full booking table with CRM links
- **History & Status** — current booking status (active/removed) plus an append-only event log (created / updated / restored / removed) viewable per booking in a modal
- **Light / Dark / System theme** — icon toggle in the header, persisted in `localStorage`

## Architecture

```
Bitrix24 CRM  →  sync.js  →  data/bookings.db (SQLite)  →  server.js REST API  →  index.html
```

- `sync.js` — polls Bitrix24 viewing activities and diffs them into the database. Uses an **incoming** webhook, which cannot bind events, so status tracking is diff-based `created` / `updated` / `restored` / `removed`.
- `db.js` — better-sqlite3 wrapper (WAL mode). Tables: `bookings`, `status_log`, `sessions`.
- `auth.js` — password verification (scrypt) and session token generation.
- `server.js` — plain Node `http` server (no Express). Serves `index.html` at `/`, `login.js` at `/login.js`, and JSON under `/api/*`. Gzip-compresses responses over 1 KB and caches the HTML/JS files (invalidated on file mtime change).
- `index.html` — the only HTML file (inline CSS/JS). All data comes from the backend API.
- `login.js` — draws the sign-in overlay on top of `index.html` when the API answers 401 (there is no separate login page).

## Getting Started

```bash
npm install
npm start          # dashboard at http://localhost:3055
npm run sync       # pull latest bookings from Bitrix24 into SQLite
```

The server runs on port 3055 by default (`PORT` env to override). The database is auto-created at `data/bookings.db` (`DB_PATH` env to override). Restart `server.js` after editing it; HTML edits are picked up on refresh.

> Note: `npm run sync` is on-demand. Hook it up to a cron job if you want history to stay current automatically.

## Configuration

The Bitrix24 webhook URL comes from `BITRIX24_WEBHOOK_URL` in the root `.env` (shared with the root app; standalone runs load `../.env` automatically). Set `LISTING_COOKIE_PATH` to change the session cookie path (the root app sets it to `/listing-tracker`). Field mappings for the Property Inventory SPA (`entityTypeId=1032`) are documented inline there.

Calendars synced in from iCloud (an agent's personal calendars, e.g. Perso/Busy) are not counted (`isICloudCalendar` in `sync.js`); local Bitrix24 calendars and Office 365 ones are. This affects Bookings by Agent and the Calendar Events tab.

Agents can be hidden from the whole dashboard (chart, dropdowns, tiles, calendars) by editing the `HIDDEN_AGENTS` constant near the top of the script in `index.html` (`ids` and `names`). This is client-side only; their data stays in the database. Shayan Ahmadzadeh is hidden by default.

## Security / environment

These apply when the main app (`npm start` in the project root) serves both the dashboard and this tracker.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface to listen on. Behind a reverse proxy on the same machine, set `HOST=127.0.0.1` so only the proxy can reach the app. |
| `TRUST_PROXY` | off | Set `TRUST_PROXY=1` **only** behind your own reverse proxy. The app then trusts `X-Forwarded-For` (client IP for rate limiting) and `X-Forwarded-Proto`. Never set it when the app is exposed directly. |
| `COOKIE_SECURE` | off | `COOKIE_SECURE=1` always marks the session cookie `Secure`. It is added automatically for HTTPS requests. |

- **HTTPS:** the app speaks plain HTTP. Terminate HTTPS in front of it. Over plain HTTP the tracker password and session cookie are readable on the network.
- **Login:** 5 wrong passwords per IP (50 overall) in 15 minutes locks login out with a 429. Sessions last 8 hours, are stored hashed, and all end when the password is changed.
- **`/api/health`** answers only to requests made from the server itself (`curl http://localhost:3001/api/health`). Through a proxy it returns 404.
- **`.env`** contains the Bitrix webhook URL, which gives full CRM access. Keep it `chmod 600`, out of backups you share, and out of version control. The app warns at startup if other users can read it.
- The public dashboard (`/`, `/api/dashboard`) has no login by design.

## API

All endpoints under `/api/*` require a valid session cookie (obtained via `POST /api/login`). Unauthenticated API requests get `401`, which makes the dashboard show the sign-in overlay.

| Endpoint | Description |
| --- | --- |
| `GET /` | Serves the dashboard page (data is only loaded once signed in) |
| `GET /login.js` | The sign-in overlay script (public) |
| `GET /login` | Redirects to `/` |
| `POST /api/login` | Authenticate (body: `{ username, password }`) — sets session cookie |
| `POST /api/logout` | Clear session |
| `GET /api/status` | Bookings + status summary + event counts + agent summary |
| `GET /api/bookings` | All bookings |
| `GET /api/agents` | Agent summary |
| `GET /api/history?activity_id=` | Event log for one booking |
| `POST /api/sync` | Trigger a sync on demand |

## Tech

Node.js, better-sqlite3, plain HTML/CSS/JS (Montserrat font), Bitrix24 REST API.

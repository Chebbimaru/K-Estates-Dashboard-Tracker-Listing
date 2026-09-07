# K Estates Dashboard — Tracker & Property Listing Inventory

Dashboard for tracking property viewing bookings from the K Estates Bitrix24 CRM, with status history. Bookings are pulled from Bitrix24, stored in SQLite, and served by a small Node backend.

## Features

- **Booking / Agent stats** — KPI cards and per-agent viewing charts (Sales vs Rental)
- **Listing Details** — full booking table with CRM links
- **History & Status** — current booking status (active/removed) plus an append-only event log (created / updated / restored / removed) viewable per booking in a modal
- **Light / Dark / System theme** — icon toggle in the header, persisted in `localStorage`

## Architecture

```
Bitrix24 CRM  →  sync.js  →  data/bookings.db (SQLite)  →  server.js REST API  →  index.html
```

- `sync.js` — polls Bitrix24 viewing activities and diffs them into the database. Uses an **incoming** webhook, which cannot bind events, so status tracking is diff-based `created` / `updated` / `restored` / `removed`.
- `db.js` — better-sqlite3 wrapper (WAL mode). Tables: `bookings`, `status_log`.
- `server.js` — plain Node `http` server (no Express). Serves `index.html` at `/` and JSON under `/api/*`.
- `index.html` — self-contained single file (inline CSS/JS). All data comes from the backend API.

## Getting Started

```bash
npm install
npm start          # dashboard at http://localhost:3000
npm run sync       # pull latest bookings from Bitrix24 into SQLite
```

The server runs on port 3000 by default (`PORT` env to override). The database is auto-created at `data/bookings.db` (`DB_PATH` env to override). Restart `server.js` after editing it; HTML edits are picked up on refresh.

> Note: `npm run sync` is on-demand. Hook it up to a cron job if you want history to stay current automatically.

## Configuration

The Bitrix24 webhook URL is hardcoded in `sync.js` (override with the `WEBHOOK` env var). Field mappings for the Property Inventory SPA (`entityTypeId=1032`) are documented inline there.

## API

| Endpoint | Description |
| --- | --- |
| `GET /` | Serves the dashboard |
| `GET /api/status` | Bookings + status summary + event counts + agent summary |
| `GET /api/bookings` | All bookings |
| `GET /api/agents` | Agent summary |
| `GET /api/history?activity_id=` | Event log for one booking |
| `POST /api/sync` | Trigger a sync on demand |

## Tech

Node.js, better-sqlite3, plain HTML/CSS/JS (Montserrat font), Bitrix24 REST API.
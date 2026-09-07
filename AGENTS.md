# AGENTS.md

## Commands
- `npm start` — run server (port 3000, served at `http://localhost:3000`). No build step.
- `npm run sync` — pull viewing activities from Bitrix24 and diff into SQLite. Runs on demand; not automated.
- No tests, linter, or typecheck. Verify JS edits by extracting inline `<script>` and running `node --check` (the page's script block is not a standalone file).

## Architecture
Data flow: `Bitrix24 → sync.js → data/bookings.db (SQLite) → server.js REST → index.html`.

- `server.js` — plain Node `http` server (no Express). Serves `index.html` at `/` and JSON under `/api/*`. `DASHBOARD` path is read **at startup**, so restart the process after editing server.js (HTML edits need no restart — it's read from disk per request).
- `index.html` — single self-contained file (inline CSS + JS, no external assets except Montserrat font). All rendering/data-loading lives here; it fetches `/api/status` and `/api/history`.
- `db.js` — better-sqlite3, WAL mode. Tables `bookings` and `status_log` (append-only event history). DB auto-created at `data/bookings.db`; override path with `DB_PATH`.
- `sync.js` — **incoming** Bitrix24 webhook that cannot bind events, so status tracking is diff-based polling by design: match against existing rows, `created`/`updated`/`restored`/`removed`. Webhook URL is hardcoded with a `WEBHOOK` env override.

## Bitrix24 field mapping (don't change without checking CRM)
- "Booking" = activity `TYPE_ID=6` whose `SUBJECT` contains "viewing" (case-insensitive) on SPA `entityTypeId=1032`.
- Sale/rent from `ufCrm9_1775474470` (13605=Sale, 13607=Rent), fallback by `categoryId` (17=Sale, 57=Rent). Pipeline label = Rental vs Sales Listings.
- Item fields: `ufCrm9_1755521667` address, `ufCrm9_1755521860` client name, `ufCrm9_1755522258` client phone, `assignedById` responsible (resolved to names via `user.get`).

## Frontend quirks
- Theme: mode applied via `data-theme` on `<html>` (light/dark/system), persisted in `localStorage['k-theme']`. Color tokens are CSS variables in `:root` + `:root[data-theme=dark]` + `@media (prefers-color-scheme: dark)`. `--coal` is intentionally a light color in dark theme — do not use it as a badge background; use `--removed-bg` for things that must stay dark in both themes.
- `data/bookings.db-wal`/`-shm` appearing next to the DB is normal for WAL mode.
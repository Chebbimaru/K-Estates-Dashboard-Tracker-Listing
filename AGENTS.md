# AGENTS.md

## Commands
- `npm start` — run server (port 3055, served at `http://localhost:3055`). No build step.
- `npm run sync` — pull viewing activities from Bitrix24 and diff into SQLite. Runs on demand; not automated.
- No tests, linter, or typecheck. Verify JS edits by extracting inline `<script>` and running `node --check` (the page's script block is not a standalone file).

## Architecture
Data flow: `Bitrix24 → sync.js → data/bookings.db (SQLite) → server.js REST → index.html`.

- `server.js` — plain Node `http` server (no Express). Serves `index.html` at `/` and JSON under `/api/*`. Changes to server.js logic require a **process restart**. The dashboard HTML is cached with mtime invalidation (`getDashboardHtml()`), so HTML edits are picked up on refresh without restart. Responses over 1 KB are gzip-compressed.
- `index.html` — single self-contained file (inline CSS + JS, no external assets except Montserrat font). All rendering/data-loading lives here; it fetches `/api/status` and `/api/history`. `NOW` is frozen at script load — use it (not `new Date()`) for "today" so calendar/tests stay consistent.
- `db.js` — better-sqlite3, WAL mode. Tables `bookings` and `status_log` (append-only event history). DB auto-created at `data/bookings.db`; override path with `DB_PATH`.
- `sync.js` — **incoming** Bitrix24 webhook that cannot bind events, so status tracking is diff-based polling by design: match against existing rows, `created`/`updated`/`restored`/`removed`. Webhook URL is hardcoded with a `WEBHOOK` env override.

## Bitrix24 field mapping (don't change without checking CRM)
- "Booking" = activity `TYPE_ID=6` whose `SUBJECT` contains "viewing" (case-insensitive) on SPA `entityTypeId=1032`.
- Sale/rent from `ufCrm9_1775474470` (13605=Sale, 13607=Rent), fallback by `categoryId` (17=Sale, 57=Rent). Pipeline label = Rental vs Sales Listings.
- Item fields: `ufCrm9_1755521667` address, `ufCrm9_1755521860` client name, `ufCrm9_1755522258` client phone, `assignedById` responsible (resolved to names via `user.get`).

## Frontend quirks
- Theme: mode applied via `data-theme` on `<html>` (light/dark/system), persisted in `localStorage['k-theme']`. Color tokens are CSS variables in `:root` + `:root[data-theme=dark]` + `@media (prefers-color-scheme: dark)`. `--coal` is intentionally a light color in dark theme — do not use it as a badge background; use `--removed-bg` for things that must stay dark in both themes.
- Calendar: lives inside the **Bookings / Agent** panel (not its own tab). Renders from `state.calYear`/`state.calMonth`; day data is cached in `CALENDAR_DAY_MAP` (`'YYYY-MM-DD'` → bookings). Respects the same period/agent/type/status/search filters — changing a filter re-renders the month currently in view.
- `data/bookings.db-wal`/`-shm` appearing next to the DB is normal for WAL mode.
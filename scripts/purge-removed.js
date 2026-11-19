#!/usr/bin/env node
// Deletes calendar_events rows that are status='removed' and start before the sync window (older than 3 months),
// so they can never come back: the sync only reads events from [now - 3 months, now + 6 months].
// Recurring series are kept (their first start is old even when they still run).
//
// Usage: node scripts/purge-removed.js [--dry-run] [--vacuum] [--db <path>]
//   --dry-run  only print what would be deleted (opens the database read-only)
//   --removed-days N  also delete removed rows (any start date, recurring included) that were marked removed more than
//              N days ago. Without it only rows before the sync window go (most removed rows are inside the window).
//   --vacuum   run VACUUM afterwards to shrink the file (needs free disk space; run it while the app is idle)
//   --db       database file (default: $DB_PATH or ../data/bookings.db)
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const vacuum = args.includes('--vacuum');
const dbArg = args.indexOf('--db');
const dbPath = dbArg !== -1 ? path.resolve(args[dbArg + 1] || '') : (process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bookings.db'));

// Same start as calendarSyncWindow() in sync.js.
const from = new Date();
from.setMonth(from.getMonth() - 3);
const daysArg = args.indexOf('--removed-days');
const removedDays = daysArg !== -1 ? Number(args[daysArg + 1]) : null;
if (removedDays !== null && !(removedDays >= 0)) { console.error('--removed-days needs a number'); process.exit(1); }
const staleBefore = removedDays === null ? '' : new Date(Date.now() - removedDays * 86400000).toISOString();
const cutoff = from.toISOString().slice(0, 10);

const db = new Database(dbPath, { readonly: dryRun, fileMustExist: true });
db.pragma('busy_timeout = 10000');

// Rows to purge: removed AND (non-recurring and before the sync window, OR marked removed before staleBefore when given).
const WHERE = `status = 'removed' AND ((is_recurring = 0 AND date_from < @cutoff) OR (@stale != '' AND updated_at < @stale))`;
const params = { cutoff, stale: staleBefore };
const total = db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
const removed = db.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE status = 'removed'`).get().n;
const purgeable = db.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE ${WHERE}`).get(params).n;

console.log(`Database: ${dbPath}`);
console.log(`Sync window starts: ${cutoff}`);
console.log(`calendar_events: ${total} rows, ${removed} removed, ${purgeable} to purge`);

if (dryRun) {
  console.log('Dry run: nothing deleted.');
} else {
  const purge = db.transaction(() =>
    db.prepare(`DELETE FROM calendar_events WHERE ${WHERE}`).run(params).changes);
  const deleted = purge();
  console.log(`Deleted ${deleted} rows; ${total - deleted} remain.`);
  if (vacuum) {
    db.exec('VACUUM');
    console.log('VACUUM done.');
  }
}
db.close();

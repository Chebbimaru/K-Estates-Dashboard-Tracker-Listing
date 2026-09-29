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

const WEBHOOK = process.env.WEBHOOK || 'https://kestates.bitrix24.com/rest/25113/j10najl3oflt3b4p/';
const ENTITY_TYPE_ID = 1032;   // Property Inventory SPA
const RENTAL_CATEGORY_ID = 57;

const F = {
  ADDRESS: 'ufCrm9_1755521667',
  CLIENT_NAME: 'ufCrm9_1755521860',
  CLIENT_PHONE: 'ufCrm9_1755522258',
  SALE_RENT: 'ufCrm9_1775474470',
  ASSIGNED: 'assignedById',
};
const SALE_RENT_MAP = { 13605: 'Sale', 13607: 'Rent' };
const SALES_DEPARTMENT_ID = 5; // verified live against user.get -> UF_DEPARTMENT

async function callApi(method, params) {
  const res = await fetch(WEBHOOK + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  if (!res.ok) throw new Error(`${method} failed (HTTP ${res.status})`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error_description || json.error}`);
  return json;
}

async function fetchAllActivities() {
  const all = [];
  let start = 0;
  let guard = 0;
  while (true) {
    if (++guard > 200) throw new Error('Too many pages while fetching activities');
    const res = await callApi('crm.activity.list', {
      filter: { OWNER_TYPE_ID: ENTITY_TYPE_ID, TYPE_ID: 6 },
      select: ['ID', 'SUBJECT', 'OWNER_ID', 'CREATED'],
      start,
    });
    const items = res.result || [];
    all.push(...items);
    if (res.next !== undefined && res.next !== null && res.next !== '' && Number(res.next) > start) {
      start = Number(res.next);
    } else if (items.length >= 50) {
      start += 50;
    } else {
      break;
    }
  }
  return all;
}

async function batchGetItems(ids) {
  const items = {};
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const cmd = {};
    chunk.forEach((id, n) => { cmd['c' + n] = `crm.item.get?entityTypeId=${ENTITY_TYPE_ID}&id=${encodeURIComponent(id)}`; });
    const res = await callApi('batch', { halt: 0, cmd });
    const outcomes = res.result || {};
    chunk.forEach((id, n) => {
      const raw = (outcomes.result || {})['c' + n] || {};
      const item = raw.item || raw;
      if (item && item.id) items[id] = item;
    });
  }
  return items;
}

async function fetchUsers(ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const names = {};
  const salesDeptIds = new Set();
  if (!unique.length) return { names, salesDeptIds };
  const res = await callApi('user.get', { ID: unique });
  (res.result || []).forEach(u => {
    const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || u.LOGIN || u.ID;
    names[String(u.ID)] = name;
    if ((u.UF_DEPARTMENT || []).map(Number).includes(SALES_DEPARTMENT_ID)) {
      salesDeptIds.add(String(u.ID));
    }
  });
  return { names, salesDeptIds };
}

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
  const incompleteOwners = new Set();
  for (const agent of roster) {
    let raw;
    try {
      raw = await fetchCalendarEventsForUser(agent.id, from, to);
    } catch (err) {
      console.warn(`  [calendar] skipping ${agent.name} (${agent.id}): ${err.message}`);
      incompleteOwners.add(agent.id);
      continue;
    }
    for (const ev of raw) {
      const eventId = agent.id + ':' + String(ev.ID);
      try {
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
      } catch (err) {
        console.warn(`  [calendar] skipping malformed event ${eventId}: ${err.message}`);
        incompleteOwners.add(agent.id);
      }
    }
  }
  return { roster, events, incompleteOwners };
}

// Mark stored-but-unseen events removed, except for owners whose data was incomplete this run.
function reconcileRemovedCalendarEvents(seenEvents, incompleteOwners, now) {
  let calRemoved = 0;
  for (const eventId of getActiveCalendarEventIds()) {
    if (seenEvents.has(eventId)) continue;
    if (incompleteOwners.has(eventId.split(':')[0])) continue;
    if (markCalendarEventRemoved(eventId, now).changed) calRemoved++;
  }
  return calRemoved;
}

async function buildBookings() {
  const activities = await fetchAllActivities();

  const viewings = activities
    .filter(a => String(a.SUBJECT || '').toLowerCase().includes('viewing'))
    .map(a => ({
      activityId: String(a.ID),
      ownerId: String(a.OWNER_ID || ''),
      created: a.CREATED || '',
    }));

  const items = await batchGetItems(viewings.map(v => v.ownerId));
  const { names: userNames, salesDeptIds } = await fetchUsers(Object.values(items).map(i => i[F.ASSIGNED]));

  const bookings = {};
  for (const v of viewings) {
    const item = items[v.ownerId] || {};
    const categoryId = String(item.categoryId || '');
    const saleRent = SALE_RENT_MAP[String(item[F.SALE_RENT] || '')] ||
      (categoryId === String(RENTAL_CATEGORY_ID) ? 'Rent' : 'Sale');
    const assignedId = String(item[F.ASSIGNED] || '');
    bookings[v.activityId] = {
      activity_id: v.activityId,
      owner_id: v.ownerId,
      listing: String(item.title || ''),
      client_name: String(item[F.CLIENT_NAME] || ''),
      client_phone: String(item[F.CLIENT_PHONE] || ''),
      sale_rent: saleRent,
      address: String(item[F.ADDRESS] || ''),
      pipeline: categoryId === String(RENTAL_CATEGORY_ID) ? 'Rental Listings' : 'Sales Listings',
      responsible: userNames[assignedId] || 'Unknown',
      sales_department: salesDeptIds.has(assignedId) ? 1 : 0,
    };
  }
  return bookings;
}

async function sync() {
  console.log(`[sync] Fetching bookings from Bitrix24...`);
  const current = await buildBookings();
  const now = new Date().toISOString();

  let created = 0, updated = 0, restored = 0, removed = 0;

  const seen = new Set();
  for (const [activityId, booking] of Object.entries(current)) {
    seen.add(activityId);
    const result = upsertBooking(booking, now);
    if (result.firstSeen) {
      created++;
      console.log(`  [created] ${activityId} (${booking.listing || 'no title'})`);
    } else if (result.status === 'updated') {
      updated++;
      console.log(`  [updated] ${activityId} (${booking.listing || 'no title'})`);
    } else if (result.status === 'restored') {
      restored++;
      console.log(`  [restored] ${activityId}`);
    }
  }

  const stored = getActiveActivityIds();
  for (const activityId of stored) {
    if (!seen.has(activityId)) {
      const didChange = markRemoved(activityId, now);
      if (didChange.changed) {
        removed++;
        console.log(`  [removed] ${activityId}`);
      }
    }
  }

  console.log(`[sync] Fetching Sales Department calendars...`);
  const { roster, events, incompleteOwners } = await buildCalendarEvents();
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

  calRemoved = reconcileRemovedCalendarEvents(seenEvents, incompleteOwners, now);
  if (incompleteOwners.size) {
    console.log(`[sync] Calendar removals skipped for ${incompleteOwners.size} agent(s) with incomplete data`);
  }
  console.log(`[sync] Calendar events -> Created: ${calCreated}, Updated: ${calUpdated}, Restored: ${calRestored}, Removed: ${calRemoved}, Roster: ${roster.length} agents`);

  const summary = Object.fromEntries(getStatusSummary().map(r => [r.status, r.count]));
  console.log(`[sync] Done. Created: ${created}, Updated: ${updated}, Restored: ${restored}, Removed: ${removed}`);
  console.log(`[sync] DB totals -> active: ${summary.active || 0}, removed: ${summary.removed || 0}`);

  return { created, updated, restored, removed, calCreated, calUpdated, calRestored, calRemoved };
}

if (require.main === module) {
  sync().catch(err => {
    console.error('[sync] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { sync, reconcileRemovedCalendarEvents };

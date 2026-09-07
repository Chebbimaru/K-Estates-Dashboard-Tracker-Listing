const {
  upsertBooking,
  markRemoved,
  getActiveActivityIds,
  getStatusSummary,
} = require('./db');

const WEBHOOK = process.env.WEBHOOK || 'https://kestates.bitrix24.com/rest/25113/eufjex37d22mug4s/';
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

async function fetchUserNames(ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const names = {};
  if (!unique.length) return names;
  const res = await callApi('user.get', { ID: unique });
  (res.result || []).forEach(u => {
    const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || u.LOGIN || u.ID;
    names[String(u.ID)] = name;
  });
  return names;
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
  const userNames = await fetchUserNames(Object.values(items).map(i => i[F.ASSIGNED]));

  const bookings = {};
  for (const v of viewings) {
    const item = items[v.ownerId] || {};
    const categoryId = String(item.categoryId || '');
    const saleRent = SALE_RENT_MAP[String(item[F.SALE_RENT] || '')] ||
      (categoryId === String(RENTAL_CATEGORY_ID) ? 'Rent' : 'Sale');
    bookings[v.activityId] = {
      activity_id: v.activityId,
      owner_id: v.ownerId,
      listing: String(item.title || ''),
      client_name: String(item[F.CLIENT_NAME] || ''),
      client_phone: String(item[F.CLIENT_PHONE] || ''),
      sale_rent: saleRent,
      address: String(item[F.ADDRESS] || ''),
      pipeline: categoryId === String(RENTAL_CATEGORY_ID) ? 'Rental Listings' : 'Sales Listings',
      responsible: userNames[String(item[F.ASSIGNED] || '')] || 'Unknown',
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

  const summary = Object.fromEntries(getStatusSummary().map(r => [r.status, r.count]));
  console.log(`[sync] Done. Created: ${created}, Updated: ${updated}, Restored: ${restored}, Removed: ${removed}`);
  console.log(`[sync] DB totals -> active: ${summary.active || 0}, removed: ${summary.removed || 0}`);
  return { created, updated, restored, removed };
}

if (require.main === module) {
  sync().catch(err => {
    console.error('[sync] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { sync };

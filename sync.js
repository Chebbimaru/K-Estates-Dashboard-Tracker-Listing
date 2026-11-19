const {
  db,
  upsertBooking,
  markRemoved,
  getActiveActivityIds,
  getStatusSummary,
  upsertCalendarEvent,
  markCalendarEventRemoved,
  getActiveCalendarEventIds,
  replaceSalesDeptAgents,
  getStoredLeadDetails,
} = require('./db');

// Single shared webhook from the root .env (BITRIX24_WEBHOOK_URL); read lazily so
// requiring this module never throws.
function getWebhook() {
  const url = process.env.BITRIX24_WEBHOOK_URL;
  if (!url) throw new Error('BITRIX24_WEBHOOK_URL is not set (define it in the root .env)');
  return url.endsWith('/') ? url : url + '/';
}
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
const BRIEFING_CREATOR_ID = '2445'; // Maria Detaro
const BRIEFING_CREATOR_NAME = 'Maria Detaro';

const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [500, 1000, 2000]; // up to 3 retries after the first attempt
const ICLOUD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const BATCH_LIMIT = 50;

let apiCalls = 0; // HTTP requests made by the current sync run (retries included)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// POST to the webhook. A hung call is aborted after REQUEST_TIMEOUT_MS; HTTP 503, QUERY_LIMIT_EXCEEDED and
// network errors are retried with backoff. Other failures throw immediately.
async function callApi(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      apiCalls++;
      const res = await fetch(getWebhook() + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(`${method} failed (HTTP ${res.status})`);
        err.permanent = res.status !== 503;
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(`${method}: ${json.error_description || json.error}`);
        err.permanent = json.error !== 'QUERY_LIMIT_EXCEEDED';
        throw err;
      }
      return json;
    } catch (err) {
      if (err.permanent || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function toQuery(params) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

// Run commands ([{ key, method, params }]) through `batch` (50 per request). Returns { results, errors }, both keyed by
// command key: a command that errored (or whose whole batch request failed) is in `errors` with a message, never in `results`.
async function callBatch(commands) {
  const results = {};
  const errors = {};
  for (let i = 0; i < commands.length; i += BATCH_LIMIT) {
    const chunk = commands.slice(i, i + BATCH_LIMIT);
    const cmd = {};
    chunk.forEach(c => { cmd[c.key] = c.method + '?' + toQuery(c.params); });
    let res;
    try {
      res = await callApi('batch', { halt: 0, cmd });
    } catch (err) {
      chunk.forEach(c => { errors[c.key] = err.message; });
      continue;
    }
    const out = res.result || {};
    const data = out.result || {};
    const errs = out.result_error || {};
    chunk.forEach(c => {
      const e = errs[c.key];
      if (e) errors[c.key] = typeof e === 'string' ? e : (e.error_description || e.error || 'command failed');
      else if (Object.prototype.hasOwnProperty.call(data, c.key)) results[c.key] = data[c.key];
      else errors[c.key] = 'no result returned';
    });
  }
  return { results, errors };
}

async function fetchAllActivities() {
  const all = [];
  let start = 0;
  let guard = 0;
  while (true) {
    if (++guard > 200) throw new Error('Too many pages while fetching activities');
    const res = await callApi('crm.activity.list', {
      filter: { OWNER_TYPE_ID: ENTITY_TYPE_ID, TYPE_ID: 6, '%SUBJECT': 'viewing' }, // verified case-insensitive; buildBookings re-checks in JS
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

const ITEM_SELECT = ['id', 'title', 'categoryId', F.ASSIGNED, F.ADDRESS, F.CLIENT_NAME, F.CLIENT_PHONE, F.SALE_RENT];

// Fetch the viewing owners' SPA items with one crm.item.list per 50 ids. Returns { items, failed }: `failed` holds the ids
// whose chunk errored or that came back missing, so the caller never stores a blank booking for them.
async function fetchItems(ids) {
  const items = {};
  const failed = new Set();
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
    const chunk = unique.slice(i, i + BATCH_LIMIT);
    try {
      const res = await callApi('crm.item.list', { entityTypeId: ENTITY_TYPE_ID, filter: { '@id': chunk }, select: ITEM_SELECT });
      for (const item of (res.result && res.result.items) || []) {
        if (item && item.id) items[String(item.id)] = item;
      }
    } catch (err) {
      console.warn(`  [bookings] item lookup failed for ${chunk.length} item(s): ${err.message}`);
    }
    chunk.forEach(id => { if (!items[id]) failed.add(id); });
  }
  return { items, failed };
}

// user.get pages 50 users at a time; follow `next` until exhausted.
async function fetchAllUsers(params) {
  const users = [];
  let start = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = await callApi('user.get', { ...params, start });
    users.push(...(res.result || []));
    if (res.next !== undefined && res.next !== null && res.next !== '' && Number(res.next) > start) start = Number(res.next);
    else return users;
  }
  throw new Error('Too many pages while fetching users');
}

async function fetchUsers(ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const names = {};
  const salesDeptIds = new Set();
  if (!unique.length) return { names, salesDeptIds };
  (await fetchAllUsers({ ID: unique })).forEach(u => {
    const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || u.LOGIN || u.ID;
    names[String(u.ID)] = name;
    if ((u.UF_DEPARTMENT || []).map(Number).includes(SALES_DEPARTMENT_ID)) {
      salesDeptIds.add(String(u.ID));
    }
  });
  return { names, salesDeptIds };
}

async function fetchSalesDeptRoster() {
  const users = await fetchAllUsers({ filter: { UF_DEPARTMENT: SALES_DEPARTMENT_ID, ACTIVE: true } });
  return users.map(u => ({
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

// Deleted and declined (MEETING_STATUS 'N') events are not part of the agent's schedule.
function isScheduleEvent(ev) {
  return ev.DELETED !== 'Y' && ev.MEETING_STATUS !== 'N';
}

async function fetchCalendarEventsForUser(ownerId, from, to) {
  const res = await callApi('calendar.event.get', { type: 'user', ownerId, from, to });
  return (res.result || []).filter(isScheduleEvent);
}

// Calendars synced in from iCloud (an agent's personal calendars, e.g. Perso/Busy) are not counted for agents.
// Local Bitrix24 calendars and Office 365 ones are. Bitrix24 reports the provider as the section's EXTERNAL_TYPE.
function isICloudCalendar(section) {
  return String((section && section.EXTERNAL_TYPE) || '').trim().toLowerCase() === 'icloud';
}

// IDs of the owner's calendar sections that are synced from iCloud. Throws if the lookup fails.
async function fetchICloudSectionIds(ownerId) {
  const res = await callApi('calendar.section.get', { type: 'user', ownerId });
  const ids = new Set();
  for (const section of res.result || []) {
    if (isICloudCalendar(section)) ids.add(String(section.ID));
  }
  return ids;
}

// Normalize a Bitrix calendar event to a DB row. Throws on malformed timestamps.
// For recurring events DATE_TO_TS_UTC is the end of the whole series, so the end of this
// occurrence is DATE_FROM_TS_UTC + DT_LENGTH (seconds).
// Bitrix reports the calendar owner as CREATED_BY even on invitation copies, so the host is the
// reliable creator signal: the owner hosts it (MEETING_HOST), or, without a host field, status 'H'.
function isCreatedByOwner(agent, ev) {
  if (ev.MEETING_HOST !== undefined && ev.MEETING_HOST !== null && ev.MEETING_HOST !== '') {
    return String(ev.MEETING_HOST) === String(agent.id);
  }
  return ev.MEETING_STATUS === 'H';
}

// Briefing events are the ones made by Maria Detaro (BRIEFING_CREATOR_ID), as host or creator, that either have
// "briefing" in the title (case-insensitive) or are recurring (RRULE is an object, e.g. her Weekly Sales Meeting).
// They are read from HER OWN calendar only; her other events are not stored anywhere.
function isBriefing(ev) {
  const madeByMaria = String(ev.MEETING_HOST) === BRIEFING_CREATOR_ID || String(ev.CREATED_BY) === BRIEFING_CREATOR_ID;
  const isRecurring = !!(ev.RRULE && typeof ev.RRULE === 'object');
  return madeByMaria && (/briefing/i.test(String(ev.NAME || '')) || isRecurring);
}

// Events bound to several leads keep only the first lead.
function leadIdFromEvent(ev) {
  const raw = ev.UF_CRM_CAL_EVENT;
  const bindings = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const b of bindings) {
    const m = /^L_(\d+)$/.exec(String(b));
    if (m) return m[1];
  }
  return '';
}

// 'DD/MM/YYYY HH:mm:ss' (Bitrix wall-clock string) -> epoch seconds as if UTC; NaN when unparsable.
function wallClockSeconds(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str || ''));
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) / 1000 : NaN;
}

// Start of THIS occurrence of a recurring event, in the same time convention as DATE_FROM_TS_UTC.
// For a recurring series DATE_FROM_TS_UTC is always the series' first start; each returned occurrence carries its own
// wall-clock DATE_FROM, and ~DATE_FROM is the first start's wall clock, so the shift between them is this occurrence's offset.
function occurrenceStartTs(ev, fromTs) {
  const shift = wallClockSeconds(ev.DATE_FROM) - wallClockSeconds(ev['~DATE_FROM']);
  return Number.isFinite(shift) ? fromTs + shift : fromTs;
}

function toCalendarEventRow(agent, ev) {
  const eventId = agent.id + ':' + String(ev.ID);
  const fromTs = Number(ev.DATE_FROM_TS_UTC);
  const isRecurring = !!(ev.RRULE && typeof ev.RRULE === 'object');
  const length = ev.DT_LENGTH === undefined || ev.DT_LENGTH === null || ev.DT_LENGTH === '' ? NaN : Number(ev.DT_LENGTH);
  let date_to = '';
  if (Number.isFinite(length)) {
    date_to = new Date((fromTs + length) * 1000).toISOString();
  } else if (!isRecurring && ev.DATE_TO_TS_UTC) {
    date_to = new Date(Number(ev.DATE_TO_TS_UTC) * 1000).toISOString();
  }
  return {
    event_id: eventId,
    owner_id: agent.id,
    owner_name: agent.name,
    name: String(ev.NAME || ''),
    date_from: new Date(fromTs * 1000).toISOString(),
    date_to,
    all_day: ev.DT_SKIP_TIME === 'Y' ? 1 : 0,
    location: String(ev.LOCATION || ''),
    is_recurring: isRecurring ? 1 : 0,
    created_by_owner: isCreatedByOwner(agent, ev) ? 1 : 0,
    // Flagged only on Maria's own calendar copy: the dashboard counts each briefing once per active agent,
    // so invitation copies on agents' calendars must not be flagged (they would double count).
    is_briefing: agent.id === BRIEFING_CREATOR_ID && isBriefing(ev) ? 1 : 0,
    // Bitrix returns every occurrence of a recurring series under the same ID (all with the series' first
    // DATE_FROM_TS_UTC); the sync keeps one row per series and remembers each occurrence's start here (see storeCalendarEvent).
    occurrences: isRecurring ? JSON.stringify([new Date(occurrenceStartTs(ev, fromTs) * 1000).toISOString()]) : '',
    lead_id: leadIdFromEvent(ev),
    lead_title: '',
    lead_client: '',
    lead_phone: '',
  };
}

// Store a row by event ID. When a recurring series shows up again (another occurrence under the same ID) its
// occurrence start times are accumulated (sorted, de-duplicated); date_from/date_to stay "last one processed wins"
// as before, so the Calendar Events tab does not move.
function storeCalendarEvent(events, row) {
  const prev = events[row.event_id];
  if (prev && row.is_recurring && prev.is_recurring && prev.occurrences) {
    const all = new Set([...JSON.parse(prev.occurrences), ...JSON.parse(row.occurrences)]);
    row.occurrences = JSON.stringify([...all].sort());
  }
  events[row.event_id] = row;
  return row;
}

async function fetchLeads(ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const leads = {};
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await callApi('crm.lead.list', {
      filter: { ID: chunk },
      select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'PHONE'],
    });
    for (const l of res.result || []) {
      leads[String(l.ID)] = {
        title: l.TITLE || '',
        client: [l.NAME, l.LAST_NAME].filter(Boolean).join(' ').trim(),
        phone: (l.PHONE && l.PHONE[0] && l.PHONE[0].VALUE) || '',
      };
    }
  }
  return leads;
}

// Fill lead details from the fresh fetch, else from what is already stored, else blank,
// so a failed/partial fetch or a deleted lead never overwrites good stored details.
// storedRows: rows carrying lead_id/lead_title/lead_client/lead_phone, in preference order (first usable row per lead wins).
function applyLeadDetails(events, leadsById, storedRows) {
  const storedByLead = new Map();
  for (const r of storedRows) {
    if (r.lead_id && (r.lead_title || r.lead_client) && !storedByLead.has(r.lead_id)) storedByLead.set(r.lead_id, r);
  }
  for (const ev of Object.values(events)) {
    if (!ev.lead_id) continue;
    const fresh = leadsById[ev.lead_id];
    const stored = fresh ? null : storedByLead.get(ev.lead_id);
    const src = fresh
      ? { title: fresh.title, client: fresh.client, phone: fresh.phone }
      : stored
        ? { title: stored.lead_title, client: stored.lead_client, phone: stored.lead_phone }
        : { title: '', client: '', phone: '' };
    ev.lead_title = src.title || '';
    ev.lead_client = src.client || '';
    ev.lead_phone = src.phone || '';
  }
  return events;
}

// Add Maria's briefings (titled "briefing" or recurring) from her raw calendar into `events`.
// Returns the number of distinct briefing rows and whether any event was malformed.
function addMariaBriefings(events, mariaRaw) {
  const mariaAgent = { id: BRIEFING_CREATOR_ID, name: BRIEFING_CREATOR_NAME };
  const seen = new Set();
  let malformed = false;
  for (const ev of mariaRaw.filter(isBriefing)) {
    const eventId = BRIEFING_CREATOR_ID + ':' + String(ev.ID);
    try {
      storeCalendarEvent(events, toCalendarEventRow(mariaAgent, ev));
      seen.add(eventId);
    } catch (err) {
      console.warn(`  [calendar] skipping malformed briefing ${eventId}: ${err.message}`);
      malformed = true;
    }
  }
  return { count: seen.size, malformed };
}

// owner id -> { ids: Set of iCloud section ids, at: ms }; sections rarely change, so they are re-read every 12 h.
const iCloudSectionCache = new Map();

function cachedICloudSectionIds(ownerId) {
  const hit = iCloudSectionCache.get(ownerId);
  return hit && Date.now() - hit.at < ICLOUD_CACHE_TTL_MS ? hit.ids : null;
}

async function buildCalendarEvents() {
  const roster = await fetchSalesDeptRoster();
  const { from, to } = calendarSyncWindow();
  const events = {};
  const incompleteOwners = new Set();
  let skippedICloud = 0;

  // One batch for every agent's events (plus Maria's) and the sections of owners not in the cache.
  const eventOwners = [...new Set(roster.map(a => a.id).concat(BRIEFING_CREATOR_ID))];
  const commands = eventOwners.map(id => ({ key: 'e' + id, method: 'calendar.event.get', params: { type: 'user', ownerId: id, from, to } }));
  for (const agent of roster) {
    if (!cachedICloudSectionIds(agent.id)) {
      commands.push({ key: 's' + agent.id, method: 'calendar.section.get', params: { type: 'user', ownerId: agent.id } });
    }
  }
  const { results, errors } = await callBatch(commands);
  for (const agent of roster) {
    if (results['s' + agent.id] === undefined) continue;
    const ids = new Set();
    for (const section of Array.isArray(results['s' + agent.id]) ? results['s' + agent.id] : []) {
      if (isICloudCalendar(section)) ids.add(String(section.ID));
    }
    iCloudSectionCache.set(agent.id, { ids, at: Date.now() });
  }
  const rawEvents = ownerId => (results['e' + ownerId] || []).filter(isScheduleEvent);

  for (const agent of roster) {
    if (errors['e' + agent.id] !== undefined) {
      console.warn(`  [calendar] skipping ${agent.name} (${agent.id}): ${errors['e' + agent.id]}`);
      incompleteOwners.add(agent.id);
      continue;
    }
    let raw = rawEvents(agent.id);
    if (raw.length) {
      const icloud = cachedICloudSectionIds(agent.id);
      if (!icloud) {
        console.warn(`  [calendar] skipping ${agent.name} (${agent.id}): calendar sections unavailable: ${errors['s' + agent.id]}`);
        incompleteOwners.add(agent.id);
        continue;
      }
      if (icloud.size) {
        const kept = raw.filter(ev => !icloud.has(String(ev.SECTION_ID)));
        skippedICloud += raw.length - kept.length;
        raw = kept;
      }
    }
    for (const ev of raw) {
      const eventId = agent.id + ':' + String(ev.ID);
      try {
        storeCalendarEvent(events, toCalendarEventRow(agent, ev));
      } catch (err) {
        console.warn(`  [calendar] skipping malformed event ${eventId}: ${err.message}`);
        incompleteOwners.add(agent.id);
      }
    }
  }
  console.log(`[sync] Skipped ${skippedICloud} events in iCloud calendars`);

  // Briefings live in Maria Detaro's own calendar. Keep only those; her other events are not stored.
  // An error or a totally empty calendar (the Office 365 section can load empty) makes her data incomplete,
  // so stored briefings are never removed on a hiccup.
  let briefingCount = 0;
  const mariaError = errors['e' + BRIEFING_CREATOR_ID];
  if (mariaError !== undefined) {
    console.warn(`  [calendar] Maria Detaro's calendar unavailable, keeping stored briefings: ${mariaError}`);
    incompleteOwners.add(BRIEFING_CREATOR_ID);
  } else {
    const mariaRaw = rawEvents(BRIEFING_CREATOR_ID);
    if (mariaRaw.length === 0) incompleteOwners.add(BRIEFING_CREATOR_ID);
    const res = addMariaBriefings(events, mariaRaw);
    briefingCount = res.count;
    if (res.malformed) incompleteOwners.add(BRIEFING_CREATOR_ID);
  }
  console.log(`[sync] Briefings (Maria Detaro's calendar): ${briefingCount}`);

  const leadIds = [...new Set(Object.values(events).map(e => e.lead_id).filter(Boolean))];
  let leadsById = {};
  if (leadIds.length) {
    try {
      leadsById = await fetchLeads(leadIds);
    } catch (err) {
      console.warn(`  [calendar] lead details unavailable, keeping stored ones: ${err.message}`);
    }
  }
  applyLeadDetails(events, leadsById, getStoredLeadDetails());
  const leadBound = Object.values(events).filter(e => e.lead_id).length;
  console.log(`[sync] Lead-bound events: ${leadBound} (${leadIds.length} distinct leads)`);
  return { roster, events, incompleteOwners };
}

// Persist roster + events and reconcile removals. An empty roster is treated as a Bitrix
// hiccup: the calendar update is skipped entirely so nothing stored gets wiped.
function applyCalendarUpdate(roster, events, incompleteOwners, now) {
  let calCreated = 0, calUpdated = 0, calRestored = 0, calRemoved = 0;
  if (roster.length === 0) {
    console.warn(`[sync] Sales Department roster came back empty — skipping calendar update`);
    return { calCreated, calUpdated, calRestored, calRemoved };
  }
  const apply = db.transaction(() => {
    replaceSalesDeptAgents(roster, now);
    const seenEvents = new Set();
    for (const [eventId, ev] of Object.entries(events)) {
      seenEvents.add(eventId);
      const result = upsertCalendarEvent(ev, now);
      if (result.firstSeen) calCreated++;
      else if (result.status === 'updated') calUpdated++;
      else if (result.status === 'restored') calRestored++;
    }
    calRemoved = reconcileRemovedCalendarEvents(seenEvents, incompleteOwners, now);
  });
  apply();
  if (incompleteOwners.size) {
    console.log(`[sync] Calendar removals skipped for ${incompleteOwners.size} agent(s) with incomplete data`);
  }
  return { calCreated, calUpdated, calRestored, calRemoved };
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

// Returns { bookings, skipped }: `skipped` holds the activity ids whose SPA item could not be read this run. They are
// neither written (no blank overwrite) nor removed; sync() treats them as still seen.
async function buildBookings() {
  const activities = await fetchAllActivities();

  const viewings = activities
    .filter(a => String(a.SUBJECT || '').toLowerCase().includes('viewing'))
    .map(a => ({
      activityId: String(a.ID),
      ownerId: String(a.OWNER_ID || ''),
      created: a.CREATED || '',
    }));

  const { items, failed } = await fetchItems(viewings.map(v => v.ownerId));
  const { names: userNames, salesDeptIds } = await fetchUsers(Object.values(items).map(i => i[F.ASSIGNED]));

  const bookings = {};
  const skipped = new Set();
  for (const v of viewings) {
    const item = items[v.ownerId];
    if (!item) {
      skipped.add(v.activityId);
      console.warn(`  [bookings] keeping stored data for ${v.activityId}: item ${v.ownerId || '(none)'} ${failed.has(v.ownerId) ? 'could not be read' : 'has no owner'}`);
      continue;
    }
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
      created_at: v.created,
    };
  }
  return { bookings, skipped };
}

async function sync() {
  const startedAt = Date.now();
  apiCalls = 0;
  console.log(`[sync] Fetching bookings from Bitrix24...`);
  const { bookings: current, skipped } = await buildBookings();
  const now = new Date().toISOString();

  let created = 0, updated = 0, restored = 0, removed = 0;

  const seen = new Set(skipped);
  const applyBookings = db.transaction(() => {
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

    for (const activityId of getActiveActivityIds()) {
      if (!seen.has(activityId)) {
        if (markRemoved(activityId, now).changed) {
          removed++;
          console.log(`  [removed] ${activityId}`);
        }
      }
    }
  });
  applyBookings();

  console.log(`[sync] Fetching Sales Department calendars...`);
  const { roster, events, incompleteOwners } = await buildCalendarEvents();
  const { calCreated, calUpdated, calRestored, calRemoved } = applyCalendarUpdate(roster, events, incompleteOwners, now);
  console.log(`[sync] Calendar events -> Created: ${calCreated}, Updated: ${calUpdated}, Restored: ${calRestored}, Removed: ${calRemoved}, Roster: ${roster.length} agents`);

  const summary = Object.fromEntries(getStatusSummary().map(r => [r.status, r.count]));
  console.log(`[sync] Done. Created: ${created}, Updated: ${updated}, Restored: ${restored}, Removed: ${removed}`);
  console.log(`[sync] DB totals -> active: ${summary.active || 0}, removed: ${summary.removed || 0}`);
  console.log(`[sync] ${Date.now() - startedAt}ms, ${apiCalls} calls`);

  return { created, updated, restored, removed, calCreated, calUpdated, calRestored, calRemoved };
}

if (require.main === module) {
  try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch {}
  sync().catch(err => {
    console.error('[sync] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { sync, reconcileRemovedCalendarEvents, toCalendarEventRow, leadIdFromEvent, applyLeadDetails, isScheduleEvent, isCreatedByOwner, isBriefing, applyCalendarUpdate, storeCalendarEvent, addMariaBriefings, fetchCalendarEventsForUser, calendarSyncWindow, isICloudCalendar, fetchICloudSectionIds, fetchSalesDeptRoster };

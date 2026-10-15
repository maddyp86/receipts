// ===================================================================
// v2 PIPELINE: MEMBERS (weekly). legislators-current and
// legislators-historical -> core.members.
//
// Refreshes names, parties, states, districts, Senate class, Senate vote id
// and terms from unitedstates/congress-legislators. Values are written in the
// form the Politicians tab already holds them (the Phase 1 check found the two
// agree), so a refresh changes a value only when the member's record changed.
//
// NEVER TOUCHED: in_scope, live, the congresses collected, roles, OpenSecrets
// id, website. A member new to the file is added with in_scope and live false
// and no congresses: adding a member to the record is a decision, not a sync.
//
// A member who has left is in legislators-historical instead. If they are
// already in core.members and their last term ended inside the record, their
// left_at and term_end come from that file and a blank LIS id is filled, so
// the votes they cast still join to them. Former members are never added.
// ===================================================================
const legis = await getJson('https://unitedstates.github.io/congress-legislators/legislators-current.json');
if (!Array.isArray(legis) || legis.length < 500) throw new Error('[v2 members] legislators-current returned ' + (Array.isArray(legis) ? legis.length : typeof legis) + ' rows; expected about 540.');

const rows = [];
for (const l of legis) {
  const id = S(l.id && l.id.bioguide).toUpperCase();
  if (!id) { problem('(none)', 'bioguide', '', 'legislator with no bioguide id; skipped'); continue; }
  const t = (l.terms || [])[l.terms.length - 1] || {};
  const senate = t.type === 'sen';
  rows.push({
    member_id: id,
    full_name: S(l.name && l.name.official_full) || [S(l.name && l.name.first), S(l.name && l.name.last)].filter(Boolean).join(' '),
    chamber: senate ? 'Senate' : 'House',
    state: S(t.state) || null,
    district: senate ? null : (t.district === undefined || t.district === null ? null : String(t.district)),
    party: S(t.party) || null,
    senate_class: senate && t.class ? Number(t.class) : null,
    // The file has no LIS id for a few senators; a blank never erases one.
    lis_id: senate ? (S(l.id.lis) || null) : null,
    term_start: S(t.start) || null,
    term_end: S(t.end) || null,
    // In legislators-current means serving; clears a left_at if they return.
    left_at: null,
    // Insert-only columns for a member new to the record.
    in_scope: false,
    live: false,
    congresses: [],
    roles: [],
  });
}

const SPEC = {
  member_id: 'text', full_name: 'text', chamber: 'text', state: 'text', district: 'text', party: 'text',
  senate_class: 'smallint', lis_id: 'text', term_start: 'date', term_end: 'date', left_at: 'date',
  in_scope: 'boolean', live: 'boolean', congresses: 'smallint[]', roles: 'jsonb',
};
const REFRESHED = ['full_name', 'chamber', 'state', 'district', 'party', 'senate_class', 'term_start', 'term_end', 'left_at'];
// lis_id is refreshed separately so a blank in the file never clears it.
const withLis = rows.filter((r) => r.lis_id);

// Members who have left. The record starts at the 118th Congress, so only a
// term that ended since then can matter; votes before it are not loaded.
const RECORD_START = '2023-01-03';
const hist = await getJson('https://unitedstates.github.io/congress-legislators/legislators-historical.json');
if (!Array.isArray(hist) || hist.length < 12000) throw new Error('[v2 members] legislators-historical returned ' + (Array.isArray(hist) ? hist.length : typeof hist) + ' rows; expected about 12,200.');
const serving = new Set(rows.map((r) => r.member_id));
const departed = [];
for (const l of hist) {
  const id = S(l.id && l.id.bioguide).toUpperCase();
  // The two files list different people; a member in both counts as serving.
  if (!id || serving.has(id)) continue;
  const t = (l.terms || [])[l.terms.length - 1] || {};
  const end = S(t.end);
  if (!end || end < RECORD_START) continue;
  departed.push({ member_id: id, term_end: end, left_at: end, lis_id: S(l.id.lis) || null });
}
const LEFT = { member_id: 'text', term_end: 'date', left_at: 'date' };
// A former member's LIS id only fills a blank; it never replaces one.
const departedLis = departed.filter((r) => r.lis_id);

const statements = []
  .concat(upsert('members', SPEC, ['member_id'], rows, { guard: true, onlyCols: REFRESHED }))
  // Every member here exists by now: the statement above inserted the new ones.
  .concat(update('members', { member_id: 'text', lis_id: 'text' }, ['member_id'], withLis))
  // Updates only: a former member not already in core.members is skipped.
  .concat(update('members', LEFT, ['member_id'], departed.map((r) => ({ member_id: r.member_id, term_end: r.term_end, left_at: r.left_at }))))
  .concat(update('members', { member_id: 'text', lis_id: 'text' }, ['member_id'], departedLis.map((r) => ({ member_id: r.member_id, lis_id: r.lis_id })), { where: 't.lis_id IS NULL' }));
const previews = [
  preview('members', SPEC, ['member_id'], rows, { onlyCols: REFRESHED }),
  preview('members', { member_id: 'text', lis_id: 'text' }, ['member_id'], withLis, { onlyCols: ['lis_id'] }),
  // new_keys here are former members NOT in core.members: the update skips them.
  preview('members', LEFT, ['member_id'], departed, { onlyCols: ['term_end', 'left_at'] }),
  preview('members', { member_id: 'text', lis_id: 'text' }, ['member_id'], departedLis, { onlyCols: ['lis_id'] }),
];

return emit(statements, previews, {
  workflow: 'members',
  legislators_rows: legis.length,
  rows_out: rows.length,
  senate: rows.filter((r) => r.chamber === 'Senate').length,
  house: rows.filter((r) => r.chamber === 'House').length,
  historical_rows: hist.length,
  left_since_record_start: departed.length,
  errors: [],
});

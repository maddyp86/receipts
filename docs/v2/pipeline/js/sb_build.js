// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 6. Read each bill file and build
//   core.bills         a new bill whole; a changed bill's status and progress
//   core.sponsorships  each in_scope member's sponsor or cosponsor row, with the
//                      true cosponsor date and any withdrawal, from the file
//   core.action_uids   today's Action UID for a new pair
//   core.source_files  each bill file read, with its hash
//
// The rules are the old pipeline's, carried over:
//   - who acted: the congress.gov member lists, unioned with what the bill
//     file shows (WF4 "Extract Sponsored Bills")
//   - a new bill's fields: WF4 for a bill found on a member list, WF2 for a
//     bill found through a vote; status from WF2b
//   - progress, sponsor tier, cosponsor timing, withdrawals, committee
//     membership, enacted-via: WF2c "Extract Progress & Effort", unchanged
//   - text link: WF4 takes the last version congress.gov lists, WF2 takes the
//     first of its priority list
// As in the old pipeline, a bill's titles, subjects and summary are written
// when the bill is first seen and not refreshed after.
//
// A bill file that cannot be fetched is skipped and not recorded, so it is
// tried again next run; its new pairs wait with it (WF4 does the same).
// ===================================================================
const work = $('Find Work').first().json;
const maxBills = Number(cfg.max_bill_files) || 300;
const batch = (work.bills || []).slice(0, maxBills);
const now = new Date().toISOString();

// ---- members in scope ------------------------------------------------------
const inScope = new Map((work.in_scope || []).map((m) => [m.member_id, m]));
const collects = (pid, congress) => { const m = inScope.get(pid); return !!m && (m.congresses || []).map(Number).indexOf(Number(congress)) !== -1; };

// ---- pairs from the member lists, and rows already held ---------------------
const newPairsByBill = new Map();
for (const p of work.new_pairs || []) {
  if (!newPairsByBill.has(p.bill_id)) newPairsByBill.set(p.bill_id, []);
  newPairsByBill.get(p.bill_id).push(p);
}
const heldByBill = new Map();
for (const r of work.existing_rows || []) {
  if (!heldByBill.has(r.bill_id)) heldByBill.set(r.bill_id, new Map());
  heldByBill.get(r.bill_id).set(r.member_id, r.role);
}

// ---- text links, paired by index with the requests --------------------------
const textReqs = $('Text Requests').all().map((i) => i.json);
const textResps = $input.all().map((i) => i.json);
if (textReqs.length !== textResps.length) throw new Error('[v2 bills] pairing mismatch: ' + textResps.length + ' text responses for ' + textReqs.length + ' requests.');
const textByBill = new Map();
const textFailed = [];
for (let i = 0; i < textReqs.length; i++) {
  if (textReqs[i].skip) continue;
  const r = textResps[i] || {};
  if (!Array.isArray(r.textVersions)) { textFailed.push(textReqs[i].bill_id); continue; }
  textByBill.set(textReqs[i].bill_id, r.textVersions);
}
// WF4 "Parse API Response": one row per version, written in order, so the
// LAST version listed is what the sheet keeps; its Formatted Text, or blank.
const textUrlWf4 = (tv) => {
  if (!tv.length) return null;
  const last = tv[tv.length - 1];
  const f = (last.formats || []).find((x) => x.type === 'Formatted Text');
  return f && f.url ? f.url : null;
};
// WF2 "Parse API Response": the first version type on its priority list that
// has XML or HTML; else the first such version; its HTML link.
const PRIORITY = ['Engrossed Amendment House', 'Engrossed Amendment Senate', 'Enrolled Bill', 'Engrossed in Senate',
  'Engrossed in House', 'Referred in Senate', 'Referred in House', 'Introduced in Senate', 'Introduced in House'];
const textUrlWf2 = (tv) => {
  const avail = {};
  for (const v of tv) {
    let xml = null, htm = null;
    for (const f of v.formats || []) { if (f.type === 'Formatted XML') xml = f.url; if (f.type === 'Formatted Text') htm = f.url; }
    if (xml || htm) avail[v.type || ''] = { htm };
  }
  for (const p of PRIORITY) if (avail[p]) return avail[p].htm || null;
  const first = Object.keys(avail)[0];
  return first ? avail[first].htm || null : null;
};

// ---- committee membership (current congress only), as WF2c ------------------
let membership = null;
try {
  const m = await getJson('https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/committee-membership-current.json');
  if (m && typeof m === 'object' && Object.keys(m).length > 5) membership = m;
} catch (e) { membership = null; }
const memberCache = new Map();
const memberSet = (pid) => {
  if (!memberCache.has(pid)) {
    const s = new Set();
    if (membership) for (const cid of Object.keys(membership)) {
      const list = Array.isArray(membership[cid]) ? membership[cid] : [];
      if (list.some((x) => S(x && x.bioguide).toUpperCase() === pid.toUpperCase())) s.add(cid);
    }
    memberCache.set(pid, s);
  }
  return memberCache.get(pid);
};
const d = new Date();
const y = d.getFullYear();
const effYear = (y % 2 === 1 && d < new Date(Date.UTC(y, 0, 3))) ? y - 1 : y;
const currentCongress = String(Math.floor((effYear - 1789) / 2) + 1);

// ---- WF2c progress rules, verbatim ----------------------------------------
const U = (v) => S(v).toUpperCase();
const dOnly = (v) => { const s = S(v); if (!s) return ''; const p = new Date(s); return isNaN(p) ? s.slice(0, 10) : p.toISOString().slice(0, 10); };
const daysBetween = (a, b) => { const da = new Date(dOnly(a)); const db = new Date(dOnly(b)); if (isNaN(da) || isNaN(db)) return ''; return Math.round((db - da) / 86400000); };
const RANK = { INTRODUCED: 1, REFERRED: 2, IN_COMMITTEE: 3, ON_CALENDAR: 4, FLOOR: 5, PASSED_CHAMBER: 6, PASSED_BOTH: 7, TO_PRESIDENT: 8, ENACTED: 9, VETOED: 9 };
const stageOf = (j) => {
  const acts = Array.isArray(j.actions) ? j.actions.slice() : [];
  acts.sort((a, b) => S(a.acted_at).localeCompare(S(b.acted_at)));
  let best = { stage: 'INTRODUCED', at: dOnly(j.introduced_at) };
  const bump = (stage, at) => { if (RANK[stage] > RANK[best.stage]) best = { stage, at: dOnly(at) }; };
  let failed = false;
  const committeeMoved = (Array.isArray(j.committees) ? j.committees : []).some((c) =>
    (Array.isArray(c.activity) ? c.activity : []).some((a) => !/^referred/i.test(S(a))));
  for (const a of acts) {
    const t = S(a.text); const st = U(a.status); const ty = S(a.type);
    if (ty === 'referral' || st === 'REFERRED') bump('REFERRED', a.acted_at);
    if (st === 'REPORTED' || /hearings? held|markup|ordered to be reported|reported (by|to|with)/i.test(t)) bump('IN_COMMITTEE', a.acted_at);
    if (/placed on (the )?(senate|house|union|private) (legislative )?calendar/i.test(t)) bump('ON_CALENDAR', a.acted_at);
    if (ty === 'vote' || /motion to proceed|cloture|considered (under|as|by)/i.test(t)) bump('FLOOR', a.acted_at);
    if (/^(PASSED|PASS_OVER|PASS_BACK)/.test(st)) bump('PASSED_CHAMBER', a.acted_at);
    if (ty === 'topresident') bump('TO_PRESIDENT', a.acted_at);
    if (ty === 'enacted' || /^ENACTED/.test(st)) bump('ENACTED', a.acted_at);
    if (/^VETOED/.test(st) || ty === 'vetoed') bump('VETOED', a.acted_at);
    if (/^(FAIL|PROV_KILL)/.test(st)) failed = true;
  }
  if (committeeMoved) bump('IN_COMMITTEE', best.at);
  const h = j.history || {};
  if (h.house_passage_result === 'pass' && h.senate_passage_result === 'pass') bump('PASSED_BOTH', h.senate_passage_result_at || h.house_passage_result_at);
  if (h.enacted === true) bump('ENACTED', h.enacted_at);
  if (h.vetoed === true) bump('VETOED', h.vetoed_at);
  return { stage: best.stage, at: best.at, failed };
};

// ---- read the files ----------------------------------------------------------
const fileOf = (b) => b.path || ('congress-bill-data/data/' + b.bill_id.replace(/^([a-z]+)([0-9]+)-([0-9]+)$/, '$3/$1/$1$2') + '/data.json');
const fetched = await pool(batch, 8, (b) => getJson(fileUrl(fileOf(b))));

const newBills = [];
const changedBills = [];
const sponsorships = [];
const actionUids = [];
const files = [];
const unreadable = [];
const pairsWaiting = [];
const counts = { new_bills: 0, changed_bills: 0, new_pairs_written: 0, sponsorship_rows: 0, withdrawn: 0, unresolved: 0, from_file_only: 0 };

for (let i = 0; i < batch.length; i++) {
  const b = batch[i];
  const r = fetched[i];
  const j = r.ok ? r.value : null;
  if (!j || !Array.isArray(j.actions)) {
    unreadable.push({ bill_id: b.bill_id, error: r.ok ? 'no actions array' : r.error });
    for (const p of newPairsByBill.get(b.bill_id) || []) pairsWaiting.push(p.bill_id + '|' + p.member_id);
    continue;
  }
  const congress = S(j.congress) || b.bill_id.split('-').pop();
  const st = stageOf(j);
  const status = U(j.status);
  let outcome = 'ACTIVE';
  if (/^ENACTED/.test(status)) outcome = 'ENACTED';
  else if (/^VETOED/.test(status)) outcome = 'VETOED';
  else if (/^FAIL/.test(status)) outcome = 'FAILED';
  else if (/^PROV_KILL/.test(status)) outcome = 'PROV_KILL';
  else if (/^PASSED:(SIMPLERES|CONCURRENTRES)/.test(status)) outcome = 'AGREED_TO';
  else if (congress && Number(congress) < Number(currentCongress)) outcome = 'DIED_AT_' + st.stage;
  const acts = j.actions.slice().sort((a, c) => S(a.acted_at).localeCompare(S(c.acted_at)));
  const last = acts.length ? acts[acts.length - 1] : null;
  const committees = Array.isArray(j.committees) ? j.committees : [];
  const committeeIds = committees.map((c) => S(c.committee_id)).filter(Boolean);
  const committeeActivity = committees.map((c) => S(c.committee_id) + ': ' + (Array.isArray(c.activity) ? c.activity.join(', ') : '')).join(' | ');
  const cos = Array.isArray(j.cosponsors) ? j.cosponsors : [];
  const cosActive = cos.filter((c) => !S(c.withdrawn_at));
  const related = Array.isArray(j.related_bills) ? j.related_bills : [];
  const enactedVia = related.filter((x) => /contains the text/i.test(S(x.reason))).map((x) => S(x.bill_id));
  const sourceUpdated = iso(j.updated_at);
  const prevUpdated = b.source_updated_at ? iso(b.source_updated_at) : null;

  const progress = {
    bill_id: b.bill_id,
    status: S(j.status) || null,
    status_changed_at: utcDay(j.status_at),
    status_checked_at: now,
    progress_stage: st.stage,
    progress_outcome: outcome,
    progress_stage_at: st.at || null,
    progress_checked_at: now,
    last_action_at: last ? dOnly(last.acted_at) || null : null,
    last_action_text: last ? S(last.text).slice(0, 300) || null : null,
    committee_activity: committeeActivity || null,
    referred_committees: committeeIds.length ? committeeIds : null,
    cosponsor_count: cosActive.length,
    enacted_via: st.stage === 'ENACTED' ? 'SELF' : (enactedVia.length ? enactedVia.join('; ') : null),
    source_updated_at: sourceUpdated,
    // WF2c: FIRST_SEEN when there was nothing to compare with, else did updated_at move.
    source_changed: b.in_core && prevUpdated ? sourceUpdated !== prevUpdated : null,
  };

  const tv = textByBill.get(b.bill_id);
  const fromMemberList = (b.why || []).indexOf('member_list') !== -1;
  const textUrl = tv ? (fromMemberList && !b.in_core ? textUrlWf4(tv) : textUrlWf2(tv)) : null;

  if (!b.in_core) {
    // WF4: introduction action date for a bill found on a member list;
    // WF2: introduced_at, else status_at, for a bill found through a vote.
    const raw = j.actions;
    const intro = raw.find((a) => a && S(a.action_code) === '1000') || raw.find((a) => a && S(a.action_code).startsWith('1000'))
      || raw.find((a) => a && S(a.text).toLowerCase().indexOf('introduced in senate') !== -1);
    const statusDate = fromMemberList
      ? utcDay((intro && intro.acted_at) || j.introduced_at || j.status_at)
      : utcDay(j.introduced_at || j.status_at);
    const summary = j.summary && typeof j.summary === 'object' ? S(j.summary.text) : S(j.summary || j.summary_text);
    newBills.push(Object.assign({
      congress: Number(j.congress) || Number(congress),
      bill_type: S(j.bill_type).toLowerCase() || null,
      bill_number: Number(j.number) || null,
      status_date: statusDate,
      official_title: S(j.official_title) || null,
      short_title: S(j.short_title) || null,
      popular_title: S(j.popular_title) || null,
      subject: S(j.subjects_top_term || (Array.isArray(j.subjects) && j.subjects[0])) || null,
      subjects: Array.isArray(j.subjects) ? (j.subjects.join('; ') || null) : (S(j.subjects) || null),
      summary: summary || null,
      active: !!(j.history && j.history.active === true),
      primary_sponsor: S(j.sponsor && j.sponsor.name) || null,
      bill_status_url: S(j.url || j.source_url) || null,
      bill_text_url: textUrl,
    }, progress));
    counts.new_bills++;
  } else {
    const row = Object.assign({}, progress);
    if (!b.has_text_url && textUrl) row.bill_text_url = textUrl;
    changedBills.push(row);
    counts.changed_bills++;
  }

  // ---- who acted on it, among the members in scope ----
  const sponsorId = U(j.sponsor && j.sponsor.bioguide_id);
  const roles = new Map();
  for (const p of newPairsByBill.get(b.bill_id) || []) roles.set(p.member_id, { role: p.role, pair: p });
  for (const [pid, role] of heldByBill.get(b.bill_id) || new Map()) if (!roles.has(pid)) roles.set(pid, { role, held: true });
  if (sponsorId && collects(sponsorId, congress) && !roles.has(sponsorId)) { roles.set(sponsorId, { role: 'sponsor', fileOnly: true }); }
  for (const c of cos) {
    const cid = U(c && c.bioguide_id);
    if (cid && collects(cid, congress) && !roles.has(cid)) roles.set(cid, { role: 'cosponsor', fileOnly: true, sponsoredAt: c.sponsored_at });
  }

  const cosSorted = cos.slice().sort((a, c) => (S(a.sponsored_at) + S(a.name)).localeCompare(S(c.sponsored_at) + S(c.name)));
  for (const [pid, info] of roles) {
    let tier = 'UNRESOLVED';
    let cosponsoredAt = null, original = null, ordinal = null, days = null, withdrawnAt = null;
    if (sponsorId === pid) {
      tier = RANK[st.stage] >= RANK.IN_COMMITTEE ? 'SPONSOR_ADVANCED' : 'SPONSOR_STALLED';
      cosponsoredAt = dOnly(j.introduced_at) || null;
      days = 0;
    } else {
      const idx = cosSorted.findIndex((c) => U(c.bioguide_id) === pid);
      if (idx >= 0) {
        const c = cosSorted[idx];
        tier = c.original_cosponsor === true ? 'ORIGINAL_COSPONSOR' : 'LATE_COSPONSOR';
        cosponsoredAt = dOnly(c.sponsored_at) || null;
        original = c.original_cosponsor === true;
        ordinal = idx + 1;
        const dd = daysBetween(j.introduced_at, c.sponsored_at);
        days = dd === '' ? null : dd;
        if (S(c.withdrawn_at)) { withdrawnAt = dOnly(c.withdrawn_at); counts.withdrawn++; }
      } else counts.unresolved++;
    }
    let member = 'NA_PRIOR_CONGRESS';
    let memberOf = null;
    if (String(congress) === currentCongress) {
      if (!membership) member = 'UNAVAILABLE';
      else {
        const ms = memberSet(pid);
        const hits = committeeIds.filter((cid) => ms.has(cid));
        // Lower case, as the Sheets read gave the TRUE/FALSE cells and core holds them.
        member = committeeIds.length === 0 ? 'NO_COMMITTEE' : (hits.length ? 'true' : 'false');
        memberOf = hits.length ? hits : null;
      }
    }
    sponsorships.push({
      bill_id: b.bill_id,
      member_id: pid,
      role: sponsorId === pid || info.role === 'sponsor' ? 'sponsor' : 'cosponsor',
      cosponsored_at: cosponsoredAt,
      original_cosponsor: original,
      withdrawn_at: withdrawnAt,
      sponsor_tier: tier,
      cosponsor_ordinal: ordinal,
      cosponsor_total: cos.length,
      days_after_introduction: days,
      committee_member: member,
      committee_member_of: memberOf,
      progress_checked_at: now,
    });
    counts.sponsorship_rows++;
    if (!info.held) {
      counts.new_pairs_written++;
      if (info.fileOnly) counts.from_file_only++;
      const p = info.pair || {};
      if (!p.existing_action_uid) {
        // WF4: ACT-S-{bill}-{member}; Action Date = the bill's introducedDate
        // from the member list, or the introduction action date.
        actionUids.push({
          action_uid: 'ACT-S-' + b.bill_id + '-' + pid,
          member_id: pid,
          bill_id: b.bill_id,
          legacy_action_date: utcDay(p.introduced_date) || utcDay(info.sponsoredAt) || utcDay(j.introduced_at),
        });
      }
    }
  }
  files.push({ path: fileOf(b), kind: 'bill', ref_id: b.bill_id, md5: b.md5 || 'unlisted', size: b.size || null, outcome: 'loaded' });
}

const BILL_NEW = {
  bill_id: 'text', congress: 'smallint', bill_type: 'text', bill_number: 'integer', status_date: 'date',
  official_title: 'text', short_title: 'text', popular_title: 'text', subject: 'text', subjects: 'text',
  summary: 'text', status: 'text', active: 'boolean', primary_sponsor: 'text', bill_status_url: 'text',
  bill_text_url: 'text', status_changed_at: 'date', status_checked_at: 'timestamptz', progress_stage: 'text',
  progress_outcome: 'text', progress_stage_at: 'date', progress_checked_at: 'timestamptz',
  last_action_at: 'date', last_action_text: 'text', committee_activity: 'text', referred_committees: 'text[]',
  cosponsor_count: 'integer', enacted_via: 'text', source_updated_at: 'timestamptz', source_changed: 'boolean',
};
const REFRESH = ['status', 'status_changed_at', 'progress_stage', 'progress_outcome', 'progress_stage_at', 'last_action_at',
  'last_action_text', 'committee_activity', 'referred_committees', 'cosponsor_count', 'enacted_via', 'source_updated_at', 'source_changed'];
const BILL_CHANGED = { bill_id: 'text' };
for (const c of REFRESH.concat(['status_checked_at', 'progress_checked_at'])) BILL_CHANGED[c] = BILL_NEW[c];
const withText = changedBills.filter((r) => r.bill_text_url);
const SP = {
  bill_id: 'text', member_id: 'text', role: 'text', cosponsored_at: 'date', original_cosponsor: 'boolean', withdrawn_at: 'date',
  sponsor_tier: 'text', cosponsor_ordinal: 'integer', cosponsor_total: 'integer', days_after_introduction: 'integer',
  committee_member: 'text', committee_member_of: 'text[]', progress_checked_at: 'timestamptz',
};
const SP_COMPARE = Object.keys(SP).filter((c) => ['bill_id', 'member_id', 'progress_checked_at'].indexOf(c) === -1);
const AU = { action_uid: 'text', member_id: 'text', bill_id: 'text', legacy_action_date: 'date' };
const SF = { path: 'text', kind: 'text', ref_id: 'text', md5: 'text', size: 'bigint', outcome: 'text' };

// The checked-at stamps move only with a real change, so a re-read of an
// unchanged file writes nothing.
const statements = []
  .concat(upsert('bills', BILL_NEW, ['bill_id'], newBills))
  .concat(upsert('bills', BILL_CHANGED, ['bill_id'], changedBills, { guard: true, onlyCols: REFRESH.concat(['status_checked_at', 'progress_checked_at']) })
    .map((s) => Object.assign(s, { sql: s.sql.replace(/ WHERE [(].*$/, ' WHERE (' + REFRESH.map((c) => 't."' + c + '"').join(', ') + ') IS DISTINCT FROM (' + REFRESH.map((c) => 'EXCLUDED."' + c + '"').join(', ') + ');') })))
  .concat(upsert('bills', { bill_id: 'text', bill_text_url: 'text' }, ['bill_id'], withText, { guard: true, onlyCols: ['bill_text_url'] })
    .map((s) => Object.assign(s, { sql: s.sql.replace(' WHERE (', ' WHERE t.bill_text_url IS NULL AND (') })))
  .concat(upsert('sponsorships', SP, ['bill_id', 'member_id'], sponsorships, { guard: true, onlyCols: Object.keys(SP).filter((c) => c !== 'bill_id' && c !== 'member_id') })
    .map((s) => Object.assign(s, { sql: s.sql.replace(/ WHERE [(].*$/, ' WHERE (' + SP_COMPARE.map((c) => 't."' + c + '"').join(', ') + ') IS DISTINCT FROM (' + SP_COMPARE.map((c) => 'EXCLUDED."' + c + '"').join(', ') + ');') })))
  .concat(upsert('action_uids', AU, ['action_uid'], actionUids, { touch: false, onlyCols: [] }))
  .concat(upsert('source_files', SF, ['path'], files, { touch: false, extra: { run_id: '$2::bigint', read_at: 'now()' } }));
const previews = [
  preview('bills', BILL_NEW, ['bill_id'], newBills),
  preview('bills', BILL_CHANGED, ['bill_id'], changedBills, { onlyCols: REFRESH }),
  preview('sponsorships', SP, ['bill_id', 'member_id'], sponsorships, { onlyCols: SP_COMPARE }),
  preview('action_uids', AU, ['action_uid'], actionUids),
];

return emit(statements, previews, {
  workflow: 'sponsorships and bills',
  pairs_listed: work.pairs_listed,
  files_listed: work.files_listed,
  new_pairs: (work.new_pairs || []).length,
  bills_to_read: (work.bills || []).length,
  read_this_run: batch.length,
  left_for_next_run: Math.max(0, (work.bills || []).length - batch.length),
  why: (work.bills || []).reduce((a, b) => { for (const w of b.why || []) a[w] = (a[w] || 0) + 1; return a; }, {}),
  counts,
  new_bill_ids: newBills.map((r) => r.bill_id),
  new_pair_keys: sponsorships.filter((s) => !(heldByBill.get(s.bill_id) || new Map()).has(s.member_id)).map((s) => s.bill_id + '|' + s.member_id),
  text_links_asked: textReqs.filter((t) => !t.skip).length,
  text_links_failed: textFailed,
  committee_membership: membership ? 'loaded' : 'UNAVAILABLE',
  unreadable,
  pairs_waiting_for_their_bill_file: pairsWaiting,
  errors: unreadable.length ? [unreadable.length + ' bill file(s) could not be read; they are retried next run'] : [],
});

// ===================================================================
// v2 PIPELINE: DAILY COMPARISON (gate G4). core against the Sheets, for the
// members named in Config (Schumer and Thune):
//   bills         which bills each member's record touches, and their title,
//                 status, progress, cosponsor count and text link
//   sponsorships  sponsor and cosponsor flags, true cosponsor date,
//                 withdrawal, original cosponsor, sponsor tier
//   roll calls    the Senate bill votes held
//   votes         each member's cloture and passage vote, vote id and count,
//                 derived in core from the roll calls
//
// Every difference is listed. One that is already explained (the five vote
// corrections found in Phase 1) is marked as such; the rest count as
// unexplained. G4 passes a day when the runs were clean and unexplained is 0.
//
// Nothing is written except this run's own core.ingest_runs row.
// ===================================================================
const members = S(cfg.compare_members || 'S000148,T000250').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const core = $('Read core').first().json;
const sheetActions = $('Read Bill Actions').all().map((i) => i.json).filter((r) => members.indexOf(S(pick(r, 'Politician ID')).toUpperCase()) !== -1);
const sheetBills = new Map($('Read Bills Master').all().map((i) => i.json).map((r) => [S(pick(r, 'Bill ID')), r]));
const sheetVotes = $('Read Roll Call Votes').all().map((i) => i.json);
if (!sheetActions.length || !sheetBills.size || !sheetVotes.length) throw new Error('[v2 compare] a Sheets read came back empty; refusing to compare against nothing.');

// The five vote corrections of Phase 1 (docs/v2/reference/vote-slot-rules.md):
// the sheet is wrong and core is right.
const EXPLAINED = {
  'S000148|hr5371-119': 'Phase 1 correction: the roll call has Schumer Nay on passage; the sheet says Yea',
  'T000250|sres13-118': 'Phase 1 correction: the sheet has no row; the roll call has Thune Yea',
  'T000250|sres21-118': 'Phase 1 correction: the sheet has no row; the roll call has Thune Yea',
  'S000148|s870-118': 'Phase 1 correction: the passage vote is s200-118.2024, count 2',
  'T000250|s870-118': 'Phase 1 correction: the passage vote is s200-118.2024, count 2',
};

const day = (v) => {
  const s = nz(v);
  if (s === null) return null;
  let m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^([0-9]{1,2})[/]([0-9]{1,2})[/]([0-9]{4})$/);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return s;
};
const bool = (v) => { const s = S(v).toUpperCase(); return s === 'TRUE' ? true : (s === 'FALSE' ? false : null); };
const txt = (v) => nz(v);
const num = (v) => { const s = nz(v); if (s === null) return 0; const n = Number(s); return Number.isFinite(n) ? n : s; };
const vote = (v) => { const s = nz(v); return s === null ? null : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); };

const diffs = { bills: [], sponsorships: [], roll_calls: [], votes: [] };
// By design, not a fault: v2 fills a bill's missing text link once congress.gov
// publishes one; the old pipeline sets it when it first sees the bill and never
// again. Only a link where the sheet has none qualifies.
const byDesign = (field, sheet, coreVal) => field === 'bill_text_url' && sheet === null && /^https:[/][/]www[.]congress[.]gov[/]/.test(coreVal || '')
  ? 'By design: v2 fills a missing text link; the old pipeline never backfills it' : null;
const add = (cat, key, field, sheet, coreVal) => {
  const why = EXPLAINED[key] || byDesign(field, sheet, coreVal);
  diffs[cat].push({ key, field, sheet, core: coreVal, explained: why });
};

// ---- member-bill rows ----
const coreActions = new Map((core.actions || []).map((a) => [a.member_id + '|' + a.bill_id, a]));
const sheetByKey = new Map();
for (const r of sheetActions) {
  const key = S(pick(r, 'Politician ID')).toUpperCase() + '|' + S(pick(r, 'Bill ID'));
  if (!sheetByKey.has(key)) sheetByKey.set(key, r);
}
for (const [key, r] of sheetByKey) {
  const a = coreActions.get(key);
  if (!a) { add('bills', key, 'member-bill row', 'present', 'missing'); continue; }
  const pairs = [
    ['sponsorships', 'is_sponsor', bool(pick(r, 'Is Sponsor')) === true, a.is_sponsor === true],
    ['sponsorships', 'is_cosponsor', bool(pick(r, 'Is Co-Sponsor')) === true, a.is_cosponsor === true],
    ['sponsorships', 'cosponsored_at', day(pick(r, 'Cosponsored At')), day(a.cosponsored_at)],
    ['sponsorships', 'withdrawn_at', day(pick(r, 'Withdrawn At')), day(a.withdrawn_at)],
    ['sponsorships', 'original_cosponsor', bool(pick(r, 'Original Cosponsor')), a.original_cosponsor === undefined ? null : a.original_cosponsor],
    ['sponsorships', 'sponsor_tier', txt(pick(r, 'Sponsor Tier')), txt(a.sponsor_tier)],
    ['votes', 'cloture_vote', vote(pick(r, 'Cloture Vote')), vote(a.cloture_vote)],
    ['votes', 'cloture_vote_id', txt(pick(r, 'Cloture Vote ID')), txt(a.cloture_vote_id)],
    ['votes', 'cloture_vote_count', num(pick(r, 'Cloture Vote Count')), num(a.cloture_vote_count)],
    ['votes', 'passage_vote', vote(pick(r, 'Passage Vote')), vote(a.passage_vote)],
    ['votes', 'passage_vote_id', txt(pick(r, 'Passage Vote ID')), txt(a.passage_vote_id)],
    ['votes', 'passage_vote_count', num(pick(r, 'Passage Vote Count')), num(a.passage_vote_count)],
  ];
  const isSponsorshipRow = bool(pick(r, 'Is Sponsor')) || bool(pick(r, 'Is Co-Sponsor'));
  for (const [cat, field, sv, cv] of pairs) {
    // Vote-only rows carry NA_VOTE_ONLY and blank dates on the sheet; core has no sponsorship for them.
    if (cat === 'sponsorships' && !isSponsorshipRow && field !== 'is_sponsor' && field !== 'is_cosponsor') continue;
    if (JSON.stringify(sv) !== JSON.stringify(cv)) add(cat, key, field, sv, cv);
  }
}
for (const [key] of coreActions) if (!sheetByKey.has(key)) add('bills', key, 'member-bill row', 'missing', 'present');

// ---- bills ----
const coreBills = new Map((core.bills || []).map((b) => [b.bill_id, b]));
const touched = new Set(Array.from(sheetByKey.keys()).map((k) => k.split('|')[1]));
for (const billId of touched) {
  const sb = sheetBills.get(billId);
  const cb = coreBills.get(billId);
  if (!sb || !cb) { if (!sb !== !cb) add('bills', billId, 'bill row', sb ? 'present' : 'missing', cb ? 'present' : 'missing'); continue; }
  for (const [field, sv, cv] of [
    ['official_title', txt(pick(sb, 'Official Title')), txt(cb.official_title)],
    ['status', txt(pick(sb, 'Status')), txt(cb.status)],
    ['progress_stage', txt(pick(sb, 'Progress Stage')), txt(cb.progress_stage)],
    ['progress_outcome', txt(pick(sb, 'Progress Outcome')), txt(cb.progress_outcome)],
    ['cosponsor_count', num(pick(sb, 'Cosponsor Count')), num(cb.cosponsor_count)],
    ['bill_text_url', txt(pick(sb, 'Bill Text URL')), txt(cb.bill_text_url)],
  ]) if (JSON.stringify(sv) !== JSON.stringify(cv)) add('bills', billId, field, sv, cv);
}

// ---- roll calls ----
const sheetIds = new Set(sheetVotes.map((r) => S(pick(r, 'Vote ID'))).filter(Boolean));
const coreIds = new Set(core.roll_calls || []);
for (const id of sheetIds) if (!coreIds.has(id)) add('roll_calls', id, 'roll call', 'present', 'missing');
for (const id of coreIds) if (!sheetIds.has(id)) add('roll_calls', id, 'roll call', 'missing', 'present');

const count = (list) => ({ total: list.length, explained: list.filter((d) => d.explained).length, unexplained: list.filter((d) => !d.explained).length });
const byCat = {};
let unexplained = 0;
for (const cat of Object.keys(diffs)) { byCat[cat] = count(diffs[cat]); unexplained += byCat[cat].unexplained; }
return emit([], [], {
  workflow: 'daily comparison',
  members,
  compared: { member_bill_rows_sheet: sheetByKey.size, member_bill_rows_core: coreActions.size, bills: touched.size, roll_calls_sheet: sheetIds.size, roll_calls_core: coreIds.size },
  by_category: byCat,
  unexplained,
  differences: Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, v.slice(0, 60)])),
  errors: [],
});

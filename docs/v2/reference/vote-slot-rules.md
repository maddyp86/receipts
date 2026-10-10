# Vote slot rules (reference)

This is reference material, not production code.

It is the vote logic from a backfill branch that was built and dry-run tested inside the n8n workflow "Senator Vote Data (WF1)" on 10 October 2026, then discarded when the project moved to Supabase. It is the tested statement of how one member's cloture and passage votes on a bill are worked out from the roll-call files. The v2 view `member_bill_actions` has to give the same answers.

## The rules

- A Senate bill vote counts when chamber is `s`, category is `passage` or `cloture`, and the bill type is one of the allowed types.
- Senate members are matched in the vote file by LIS id, not bioguide id. House vote files use bioguide ids.
- Per bill and member there is one cloture slot and one passage slot. The latest vote by date wins. The count is the number of distinct votes.
- Dates are stored as the UTC date of the vote, so an evening vote lands on the next calendar day. v2 keeps that convention at cutover and stores the real timestamp alongside.

## Dry-run results against production data

Nothing was written by these runs.

| Run | Votes replayed | Member-bill pairs | Identical to the sheet |
|---|---|---|---|
| Thune, 119th | 145 | 81 | 81 |
| Schumer, 119th | 145 | 81 | 80 |
| Both senators, 118th | 83 | 112 | 108 |

The five differences are all errors in the sheet, and gate G1 should find exactly these:

- **Schumer, `hr5371-119`, vote `s618-119.2025`.** The sheet says Yea for the passage vote. The roll-call file says Nay.
- **Thune, `sres13-118` and `sres21-118`.** The sheet has no row. Both votes are Yea.
- **Both senators, `s870-118`.** The passage vote should be `s200-118.2024` (18 June 2024) with a count of 2. The sheet has no passage vote for Schumer and an older one (`s94-118.2023`, count 1) for Thune.

## The code

It reads n8n nodes by name (`$('BF Config')` and so on), so treat it as a specification.

### Build the fetch list

One file URL per row of the Roll Call Votes tab.

```js
// BACKFILL - step 1 of 2. One fetchable item per Senate bill vote already on
// the Roll Call Votes tab for the target congress.
//
// The tab is the list WF1's main path accepted (passage and cloture votes that
// carry a bill), so replaying exactly these votes rebuilds a member's record
// under the same rules, without re-reading the hundreds of nomination and
// amendment votes the main path set aside.
const cfg = $('BF Config').first().json;
const targetCongress = String(cfg.target_congress || '').trim();
if (!targetCongress) throw new Error('[WF1 backfill] BF Config has no target_congress.');

const BASE = 'https://storage.googleapis.com/congress-legislative-data/congress-vote-data';
const out = [];
const seen = new Set();
for (const it of $input.all()) {
  const r = it.json || {};
  const voteId = String(r['Vote ID'] || '').trim();          // e.g. s182-118.2024
  if (!voteId || seen.has(voteId)) continue;
  const m = voteId.match(/^([a-z]+\d+)-(\d+)\.(\d{4})$/);
  if (!m) throw new Error(`[WF1 backfill] unexpected Vote ID "${voteId}" on Roll Call Votes.`);
  const [, folder, congress, year] = m;
  if (congress !== targetCongress) continue;
  seen.add(voteId);
  out.push({ json: {
    vote_id: voteId,
    download_url: `${BASE}/data/${congress}/votes/${year}/${folder}/data.json`
  } });
}
if (!out.length) throw new Error(`[WF1 backfill] Roll Call Votes holds no votes for congress ${targetCongress}.`);
console.log(`[WF1 backfill] congress ${targetCongress}: ${out.length} stored votes queued for replay`);
return out;

```

### Compute the slots

```js
// BACKFILL - step 2 of 2. Rebuilds the vote side of Politician Bill Actions for
// the members named in BF Config, and for nobody else.
//
// WHY. The main path dedupes per VOTE, so a member who goes In Scope after a
// vote was processed never gets a row for it; replaying old votes through the
// main path would re-count them for every member already in scope.
//
// Same rules as Extract & Normalize Roll Call Votes: one row per (bill,
// member); an existing row keeps its Action UID, so a WF4 sponsorship row
// gains its votes in place; cloture and passage separate, latest wins; sponsor
// flags carried forward; Impact Statement Created is pair-OR-bill.
// One difference: slots are RECOMPUTED from the full stored vote list, so a
// re-run cannot inflate a count and an unchanged row is not written.
//
// Embedded is reset on a changed row: WF6 copies the votes into the vector's
// metadata, so the row must be embedded again to carry them.
const cfg = $('BF Config').first().json;
const ids = String(cfg.politician_ids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!ids.length) throw new Error('[WF1 backfill] BF Config has no politician_ids.');
const targetCongress = String(cfg.target_congress || '').trim();

const safe = v => (v === undefined || v === null) ? '' : String(v).trim();
const isTrue = v => String(v).trim().toUpperCase() === 'TRUE';
const na = v => { const s = safe(v); return s === '' ? 'NA' : s; };
const storedText = v => { const s = safe(v); return s === 'NA' ? '' : s; };
function normalizeVote(vote) {
  if (!vote) return 'NA';
  const v = String(vote).trim().toLowerCase();
  if (v === 'yea' || v === 'yes' || v === 'aye') return 'Yea';
  if (v === 'nay' || v === 'no') return 'Nay';
  if (v === 'not voting' || v === 'not_voting' || v === 'absent') return 'Not Voting';
  if (v === 'present') return 'Present';
  return vote;
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  try { const d = new Date(dateStr); if (!isNaN(d)) return d.toISOString().slice(0, 10); } catch (e) {}
  return '';
}
function storedDate(v) {
  const s = safe(v);
  if (!s || s === 'NA') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return '';
}
const storedCount = (countVal, voteVal) => {
  const n = parseInt(safe(countVal), 10);
  if (!isNaN(n)) return n;
  return storedText(voteVal) ? 1 : 0;
};

// roster: identity and LIS ID for the named members
const roster = $('BF Get Politicians').all().map(i => {
  const o = {};
  for (const k of Object.keys(i.json)) o[k.trim()] = i.json[k];
  return o;
});
const ROSTER_BY_ID = new Map(roster.map(r => [safe(r['Politician ID']).toUpperCase(), r]));
const LIS_TO_BIOGUIDE = new Map();
for (const id of ids) {
  const r = ROSTER_BY_ID.get(id);
  if (!r) throw new Error(`[WF1 backfill] ${id} is not on the Politicians tab.`);
  const lis = safe(r['LIS ID']);
  if (!lis) throw new Error(`[WF1 backfill] ${id} has no LIS ID on the Politicians tab - Senate vote files identify members by LIS ID.`);
  LIS_TO_BIOGUIDE.set(lis, id);
}

// ---- existing ledger ----
const existingRows = $('BF Get Actions').all().map(i => i.json);
if (existingRows.length) {
  const headers = Object.keys(existingRows[0]);
  for (const c of ['Action UID', 'Bill ID', 'Politician ID']) {
    if (!headers.includes(c)) throw new Error(`[WF1 backfill] Politician Bill Actions is missing column "${c}".`);
  }
}
const existingByPair = new Map();
const billHasImpact = new Set();
for (const r of existingRows) {
  const billId = safe(r['Bill ID']);
  const polId = safe(r['Politician ID']).toUpperCase();
  if (!billId) continue;
  if (isTrue(r['Impact Statement Created'])) billHasImpact.add(billId);
  if (!polId) continue;
  const key = `${billId}|${polId}`;
  if (!existingByPair.has(key)) existingByPair.set(key, r);   // first row wins
}

// ---- the stored votes, oldest first ----
const expected = $('BF Build Fetch List').all().length;
const allowedTypes = new Set(['hr', 'hres', 'hjres', 'hconres', 's', 'sres', 'sjres', 'sconres']);
const allowedCategories = new Set(['passage', 'cloture']);
const votes = [];
let unusable = 0, rejected = 0;
for (const it of $input.all()) {
  let j = it.json;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = null; } }
  if (j && typeof j.data === 'string') { try { j = JSON.parse(j.data); } catch (e) { j = null; } }
  else if (j && j.data && typeof j.data === 'object' && !j.votes) j = j.data;
  if (!j || typeof j !== 'object' || !j.vote_id || !j.votes) { unusable++; continue; }
  const category = safe(j.category).toLowerCase();
  const bill = j.bill;
  const btype = bill && typeof bill === 'object' ? safe(bill.type).toLowerCase() : '';
  if (safe(j.chamber).toLowerCase() !== 's' || !allowedCategories.has(category) || !allowedTypes.has(btype)
      || bill.number == null || safe(bill.number) === '') { rejected++; continue; }
  const billCongress = bill.congress || j.congress || '';
  votes.push({
    vote_id: safe(j.vote_id),
    bill_id: `${btype}${safe(bill.number)}-${billCongress}`,
    category,
    date: formatDate(j.date),
    ts: new Date(j.date).getTime() || 0,
    number: Number(j.number) || 0,
    buckets: j.votes
  });
}
// A partial replay would be written as if it were the whole record. Refuse.
if (unusable > 0 || votes.length + rejected !== expected) {
  throw new Error(`[WF1 backfill] expected ${expected} vote files, got ${votes.length} usable, ${rejected} rejected by the bill-vote filter, ${unusable} unreadable. Nothing written.`);
}
votes.sort((a, b) => (a.ts - b.ts) || (a.number - b.number));

// ---- recompute each (bill, member) from the full list ----
const pairs = new Map();
for (const v of votes) {
  for (const bucketName of Object.keys(v.buckets || {})) {
    for (const m of v.buckets[bucketName] || []) {
      if (!m || !m.id || !LIS_TO_BIOGUIDE.has(m.id)) continue;
      const polId = LIS_TO_BIOGUIDE.get(m.id);
      const key = `${v.bill_id}|${polId}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          bill_id: v.bill_id, politician_id: polId, first_date: v.date,
          cloture: { vote: '', vote_id: '', date: '', count: 0, seen: new Set() },
          passage: { vote: '', vote_id: '', date: '', count: 0, seen: new Set() }
        });
      }
      const acc = pairs.get(key);
      const slot = v.category === 'cloture' ? acc.cloture : acc.passage;
      if (slot.seen.has(v.vote_id)) continue;
      slot.seen.add(v.vote_id);
      if (!slot.date || v.date >= slot.date) {
        slot.vote = normalizeVote(bucketName);
        slot.vote_id = v.vote_id;
        slot.date = v.date;
      }
      slot.count += 1;
    }
  }
}

const rows = [];
let unchanged = 0, created = 0, updated = 0;
const perMember = {};
for (const acc of pairs.values()) {
  const prior = existingByPair.get(`${acc.bill_id}|${acc.politician_id}`);
  const ros = ROSTER_BY_ID.get(acc.politician_id) || {};
  const pm = perMember[acc.politician_id] = perMember[acc.politician_id] || { pairs: 0, created: 0, updated: 0, unchanged: 0 };
  pm.pairs++;

  if (prior) {
    const same =
      storedText(prior['Cloture Vote']) === acc.cloture.vote &&
      storedText(prior['Cloture Vote ID']) === acc.cloture.vote_id &&
      storedDate(prior['Cloture Vote Date']) === acc.cloture.date &&
      storedCount(prior['Cloture Vote Count'], prior['Cloture Vote']) === acc.cloture.count &&
      storedText(prior['Passage Vote']) === acc.passage.vote &&
      storedText(prior['Passage Vote ID']) === acc.passage.vote_id &&
      storedDate(prior['Passage Vote Date']) === acc.passage.date &&
      storedCount(prior['Passage Vote Count'], prior['Passage Vote']) === acc.passage.count;
    if (same) { unchanged++; pm.unchanged++; continue; }
  }

  const isSponsor = prior ? isTrue(prior['Is Sponsor']) : false;
  const isCosponsor = prior ? isTrue(prior['Is Co-Sponsor']) : false;
  const primary = acc.passage.vote ? acc.passage : acc.cloture;
  const hasVote = !!primary.vote && primary.vote !== 'NA';
  let actionType = '';
  if (hasVote && isSponsor) actionType = 'voted, sponsored';
  else if (hasVote && isCosponsor) actionType = 'voted, co-sponsored';
  else if (hasVote) actionType = 'voted';
  else if (isSponsor) actionType = 'sponsored';
  else if (isCosponsor) actionType = 'co-sponsored';

  const priorImpact = prior ? isTrue(prior['Impact Statement Created']) : false;

  if (prior) { updated++; pm.updated++; } else { created++; pm.created++; }
  rows.push({ json: {
    action_uid: prior ? safe(prior['Action UID']) : `ACT-${acc.bill_id}-${acc.politician_id}`,
    bill_id: acc.bill_id,
    politician_id: acc.politician_id,
    senator_name: safe(ros['Full Name']) || (prior ? safe(prior['Full Name']) : ''),
    party: safe(ros['Party']) || (prior ? safe(prior['Party']) : ''),
    state: safe(ros['State']) || (prior ? safe(prior['State']) : ''),

    vote: na(primary.vote),
    vote_id: na(primary.vote_id),
    action_date: na(prior && storedDate(prior['Action Date']) ? storedDate(prior['Action Date']) : acc.first_date),

    cloture_vote: na(acc.cloture.vote),
    cloture_vote_id: na(acc.cloture.vote_id),
    cloture_vote_date: na(acc.cloture.date),
    cloture_vote_count: acc.cloture.count,
    passage_vote: na(acc.passage.vote),
    passage_vote_id: na(acc.passage.vote_id),
    passage_vote_date: na(acc.passage.date),
    passage_vote_count: acc.passage.count,

    is_sponsor: isSponsor,
    is_cosponsor: isCosponsor,
    action_type: na(actionType),

    impact_statement_created: (priorImpact || billHasImpact.has(acc.bill_id)) ? 'TRUE' : 'FALSE',
    embedded: 'FALSE',
    p2b_reviewed: 'FALSE',
    b2p_reviewed: 'FALSE',

    _is_new: !prior,
    _prior: prior ? {
      cloture: [storedText(prior['Cloture Vote']), storedText(prior['Cloture Vote ID']), storedDate(prior['Cloture Vote Date']), safe(prior['Cloture Vote Count'])].join(' | '),
      passage: [storedText(prior['Passage Vote']), storedText(prior['Passage Vote ID']), storedDate(prior['Passage Vote Date']), safe(prior['Passage Vote Count'])].join(' | '),
      action_type: safe(prior['Action Type'])
    } : null
  } });
}

const summary = {
  _summary: true,
  dry_run: cfg.dry_run !== false && String(cfg.dry_run).toLowerCase() !== 'false',
  target_congress: targetCongress,
  members: ids,
  votes_replayed: votes.length,
  pairs: pairs.size,
  rows_to_write: rows.length,
  created, updated, unchanged,
  per_member: perMember
};
console.log('[WF1 backfill] ' + JSON.stringify(summary));
return [{ json: summary }, ...rows];

```

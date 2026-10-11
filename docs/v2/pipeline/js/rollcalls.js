// ===================================================================
// v2 PIPELINE: ROLL CALLS, step 2 of 2. Read each new vote file whole.
//   a Senate passage or cloture vote on a bill -> core.roll_calls, and every
//                                                 member's position -> core.member_votes
//   every file read, kept or not               -> core.source_files
//
// The filter is today's (WF1 "Senate Bill Filter"): chamber s, category
// passage or cloture, a bill object with an allowed type and a number. A
// rejected vote (a nomination, cloture on a motion with no bill) is recorded
// in source_files with the reason, so it is never read again.
//
// A file that cannot be fetched or read is NOT recorded, so the next run tries
// it again, and the run reports it and fails after writing the rest.
// ===================================================================
const unread = ($('Find Unread Files').first().json.unread || []);
const maxFiles = Number(cfg.max_files) || 400;
const batch = unread.slice(0, maxFiles);

const ALLOWED_TYPES = new Set(['hr', 'hres', 'hjres', 'hconres', 's', 'sres', 'sjres', 'sconres']);
const ALLOWED_CATEGORIES = new Set(['passage', 'cloture']);
const isObj = (v) => v && typeof v === 'object';
// Same order of checks, and the same reasons, as WF1's skipReason.
const rejectReason = (j) => {
  const chamber = S(j.chamber).toLowerCase();
  const category = S(j.category).toLowerCase();
  if (chamber !== 's') return 'non_senate:' + (chamber || 'unknown');
  if (!ALLOWED_CATEGORIES.has(category)) return category || 'unknown_category';
  if (!isObj(j.bill)) return category + '_no_bill';
  const btype = S(j.bill.type).toLowerCase();
  if (!ALLOWED_TYPES.has(btype)) return 'unsupported_bill_type:' + (btype || 'none');
  if (!(j.bill.number != null && S(j.bill.number) !== '')) return category + '_no_bill_number';
  return null;
};
const POSITION = { yea: 'Yea', aye: 'Yea', yes: 'Yea', nay: 'Nay', no: 'Nay', 'not voting': 'Not Voting', present: 'Present' };

const fetched = await pool(batch, 8, (f) => getJson(fileUrl(f.path)));

const rollCalls = [];
const memberVotes = [];
const files = [];
const unreadable = [];
const rejected = {};
const accepted = {};
for (let i = 0; i < batch.length; i++) {
  const f = batch[i];
  const r = fetched[i];
  // data/119/votes/2025/s618/data.json -> s618-119.2025
  const m = f.path.match(/data[/]([0-9]+)[/]votes[/]([0-9]{4})[/]([a-z]+[0-9]+)[/]data[.]json$/);
  const pathVoteId = m ? m[3] + '-' + m[1] + '.' + m[2] : null;
  const j = r.ok ? r.value : null;
  if (!j || !j.vote_id || !isObj(j.votes)) { unreadable.push({ path: f.path, error: r.ok ? 'no vote_id or votes' : r.error }); continue; }
  const id = S(j.vote_id);
  if (pathVoteId && id !== pathVoteId) problem(id, 'vote_id', pathVoteId, 'file vote_id differs from its path');

  const reason = rejectReason(j);
  if (reason) {
    rejected[reason] = (rejected[reason] || 0) + 1;
    files.push({ path: f.path, kind: 'vote', ref_id: id, md5: f.md5, size: f.size, outcome: 'filtered:' + reason });
    continue;
  }
  const b = j.bill;
  const btype = S(b.type).toLowerCase();
  const bcong = Number(b.congress || j.congress);
  const billId = btype + S(b.number) + '-' + bcong;
  const category = S(j.category).toLowerCase();
  accepted[category] = (accepted[category] || 0) + 1;

  rollCalls.push({
    vote_id: id,
    chamber: 's',
    congress: Number(j.congress),
    session: S(j.session) || null,
    number: Number(j.number),
    voted_at: j.date,
    category: S(j.category) || null,
    question: S(j.question) || null,
    vote_type: S(j.type) || null,
    result: S(j.result) || null,
    result_text: S(j.result_text) || null,
    requires: S(j.requires) || null,
    bill_id: billId,
    bill_type: btype,
    bill_number: Number(b.number),
    bill_congress: bcong,
    source_url: S(j.source_url) || null,
    record_modified: j.record_modified || null,
  });
  for (const bucket of Object.keys(j.votes)) {
    const pos = POSITION[bucket.trim().toLowerCase()];
    if (!pos) { problem(id, 'votes', bucket, 'unknown position bucket; its votes are not loaded'); continue; }
    for (const mv of j.votes[bucket] || []) {
      // The Vice President's tie-break is recorded as the bare string "VP".
      const voter = typeof mv === 'string' ? mv : S(mv && mv.id);
      if (!voter) { problem(id, 'votes', JSON.stringify(mv), 'member with no id'); continue; }
      memberVotes.push({
        vote_id: id,
        voter_id: voter,
        position: pos,
        display_name: typeof mv === 'string' ? mv : (S(mv.display_name) || null),
        party: typeof mv === 'string' ? null : (S(mv.party) || null),
        state: typeof mv === 'string' ? null : (S(mv.state) || null),
      });
    }
  }
  files.push({ path: f.path, kind: 'vote', ref_id: id, md5: f.md5, size: f.size, outcome: 'loaded' });
}

const RC = {
  vote_id: 'text', chamber: 'text', congress: 'smallint', session: 'text', number: 'integer',
  voted_at: 'timestamptz', category: 'text', question: 'text', vote_type: 'text', result: 'text',
  result_text: 'text', requires: 'text', bill_id: 'text', bill_type: 'text', bill_number: 'integer',
  bill_congress: 'smallint', source_url: 'text', record_modified: 'timestamptz',
};
const MV = { vote_id: 'text', voter_id: 'text', position: 'text', display_name: 'text', party: 'text', state: 'text' };
const SF = { path: 'text', kind: 'text', ref_id: 'text', md5: 'text', size: 'bigint', outcome: 'text' };
// The ledger row carries this run's id ($2) and the time it was read.
const ledger = (rows) => upsert('source_files', SF, ['path'], rows, { touch: false, extra: { run_id: '$2::bigint', read_at: 'now()' } });

const statements = []
  .concat(upsert('roll_calls', RC, ['vote_id'], rollCalls, { guard: true }))
  .concat(upsert('member_votes', MV, ['vote_id', 'voter_id'], memberVotes, { chunk: 2000, touch: false, guard: true }))
  .concat(ledger(files));
const previews = [
  preview('roll_calls', RC, ['vote_id'], rollCalls),
  preview('member_votes', MV, ['vote_id', 'voter_id'], memberVotes),
];

return emit(statements, previews, {
  workflow: 'roll calls',
  congresses: $('List Vote Files').first().json.congresses,
  listed: $('List Vote Files').first().json.listing.length,
  unread: unread.length,
  read_this_run: batch.length,
  left_for_next_run: Math.max(0, unread.length - batch.length),
  roll_calls: rollCalls.length,
  roll_call_ids: rollCalls.map((r) => r.vote_id),
  accepted_by_category: accepted,
  member_votes: memberVotes.length,
  rejected_by_reason: rejected,
  unreadable,
  errors: unreadable.length ? [unreadable.length + ' vote file(s) could not be read; they are retried next run'] : [],
});

// ===================================================================
// v2 PIPELINE: ROLL CALLS, step 1 of 2. List the Senate vote files.
//
// Lists the storage bucket for every Senate vote file of the congresses being
// collected. The next node asks core.source_files which of them have never been
// read. Only those are fetched.
//
// A vote file is read once. Its content hash cannot show a change, because the
// scraper stamps every file with the time it ran ("updated_at"), so every file
// of the current congress has new content each day. A roll call does not
// change after it is recorded, so a file already read is done.
// ===================================================================
const scope = $('Get Scope').first().json;
const congresses = S(cfg.congresses)
  ? S(cfg.congresses).split(',').map((s) => Number(s.trim())).filter(Boolean)
  : (scope.congresses || []).map(Number);
if (!congresses.length) throw new Error('[v2 roll calls] no congresses to collect: no in_scope member has any, and Config.congresses is empty.');

const listing = [];
const perCongress = {};
for (const c of congresses) {
  const files = await listBucket('congress-vote-data/data/' + c + '/votes/', '**/s*/data.json');
  perCongress[c] = files.length;
  // A congress with no Senate vote files is a misconfiguration, not a quiet day.
  if (!files.length) throw new Error('[v2 roll calls] the bucket holds no Senate vote files for congress ' + c + '.');
  for (const f of files) listing.push(f);
}
console.log('[v2 roll calls] listed ' + listing.length + ' Senate vote files ' + JSON.stringify(perCongress));
return [{ json: { congresses, per_congress: perCongress, listing } }];

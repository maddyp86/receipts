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
//
// A BRAND-NEW CONGRESS. The scraper writes its first file for a congress only
// after the Senate's first vote, so a congress can be listed in
// core.members.congresses before the bucket holds anything for it. While today
// is within grace_days (Config, default 45) either side of that congress's
// first day, 3 January of its odd year, an empty listing is counted as
// not_yet_published and the run carries on. Outside that window, or for any
// other congress, an empty listing is a misconfiguration and the run fails.
// ===================================================================
const scope = $('Get Scope').first().json;
const congresses = S(cfg.congresses)
  ? S(cfg.congresses).split(',').map((s) => Number(s.trim())).filter(Boolean)
  : (scope.congresses || []).map(Number);
if (!congresses.length) throw new Error('[v2 roll calls] no congresses to collect: no in_scope member has any, and Config.congresses is empty.');

// First day of a congress: the Nth congress convenes on 3 January of 1789 + 2(N-1)
// (119 -> 2025-01-03, 120 -> 2027-01-03), the dates CONGRESS_START holds.
const graceDays = Number(cfg.grace_days) > 0 ? Number(cfg.grace_days) : 45;
const firstDay = (c) => Date.UTC(1789 + 2 * (c - 1), 0, 3);
const brandNew = (c) => Math.abs(Date.now() - firstDay(c)) <= graceDays * 86400000;

const listing = [];
const perCongress = {};
const notYetPublished = [];
for (const c of congresses) {
  const files = await listBucket('congress-vote-data/data/' + c + '/votes/', '**/s*/data.json');
  perCongress[c] = files.length;
  if (!files.length) {
    if (brandNew(c)) {
      notYetPublished.push(c);
      console.log('[v2 roll calls] congress ' + c + ' has no Senate vote files yet; within ' + graceDays + ' days of its first day, so not an error.');
      continue;
    }
    // A congress with no Senate vote files is a misconfiguration, not a quiet day.
    throw new Error('[v2 roll calls] the bucket holds no Senate vote files for congress ' + c + '.');
  }
  for (const f of files) listing.push(f);
}
console.log('[v2 roll calls] listed ' + listing.length + ' Senate vote files ' + JSON.stringify(perCongress));
return [{ json: { congresses, per_congress: perCongress, not_yet_published: notYetPublished, listing } }];

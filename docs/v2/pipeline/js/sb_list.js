// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 3. List the bill files.
//
// Every bill file in the bucket for the congresses collected, with its content
// hash. The next node keeps the ones that matter: files of bills already in
// core.bills whose hash differs from the one last read (the bill changed), and
// files of bills new to the record. Bill files carry the source's own
// updated_at, not the scrape time, so their hash only moves when the bill does.
//
// A BRAND-NEW CONGRESS. The scraper writes its first bill file for a congress
// only after its first bill is introduced, so a congress can be listed in
// core.members.congresses before the bucket holds anything for it. While today
// is within grace_days (Config, default 45) either side of that congress's
// first day, 3 January of its odd year, an empty listing is counted as
// not_yet_published and the run carries on. Outside that window, or for any
// other congress, an empty listing is a misconfiguration and the run fails.
// ===================================================================
const congresses = Array.from(new Set($('Get Members').all().flatMap((i) => (i.json.congresses || []).map(Number)))).sort();
const TYPES = ['s', 'sres', 'sjres', 'sconres', 'hr', 'hjres', 'hconres'];
// First day of a congress: the Nth congress convenes on 3 January of 1789 + 2(N-1)
// (119 -> 2025-01-03, 120 -> 2027-01-03), the dates CONGRESS_START holds.
const graceDays = Number(cfg.grace_days) > 0 ? Number(cfg.grace_days) : 45;
const firstDay = (c) => Date.UTC(1789 + 2 * (c - 1), 0, 3);
const brandNew = (c) => Math.abs(Date.now() - firstDay(c)) <= graceDays * 86400000;

const listing = [];
const counts = {};
const notYetPublished = [];
for (const c of congresses) {
  for (const t of TYPES) {
    const files = await listBucket('congress-bill-data/data/' + c + '/' + t + '/', '**/data.json');
    counts[c + ' ' + t] = files.length;
    for (const f of files) listing.push(f);
  }
  if (!TYPES.some((t) => counts[c + ' ' + t])) {
    if (brandNew(c)) {
      notYetPublished.push(c);
      console.log('[v2 bills] congress ' + c + ' has no bill files yet; within ' + graceDays + ' days of its first day, so not an error.');
      continue;
    }
    throw new Error('[v2 bills] the bucket holds no bill files for congress ' + c + '.');
  }
}
console.log('[v2 bills] listed ' + listing.length + ' bill files ' + JSON.stringify(counts));
return [{ json: { congresses, counts, not_yet_published: notYetPublished, listing } }];

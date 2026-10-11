// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 3. List the bill files.
//
// Every bill file in the bucket for the congresses collected, with its content
// hash. The next node keeps the ones that matter: files of bills already in
// core.bills whose hash differs from the one last read (the bill changed), and
// files of bills new to the record. Bill files carry the source's own
// updated_at, not the scrape time, so their hash only moves when the bill does.
// ===================================================================
const congresses = Array.from(new Set($('Get Members').all().flatMap((i) => (i.json.congresses || []).map(Number)))).sort();
const TYPES = ['s', 'sres', 'sjres', 'sconres', 'hr', 'hjres', 'hconres'];
const listing = [];
const counts = {};
for (const c of congresses) {
  for (const t of TYPES) {
    const files = await listBucket('congress-bill-data/data/' + c + '/' + t + '/', '**/data.json');
    counts[c + ' ' + t] = files.length;
    for (const f of files) listing.push(f);
  }
  if (!TYPES.some((t) => counts[c + ' ' + t])) throw new Error('[v2 bills] the bucket holds no bill files for congress ' + c + '.');
}
console.log('[v2 bills] listed ' + listing.length + ' bill files ' + JSON.stringify(counts));
return [{ json: { congresses, counts, listing } }];

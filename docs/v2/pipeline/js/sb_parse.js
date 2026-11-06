// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 2. Who sponsored and cosponsored
// what, from the congress.gov member lists (as WF4 "Parse Member Bills").
//
// Keeps bills of the congresses collected for that member and of the types
// the bucket holds. Amendments are ignored, as WF4 ignores them.
//
// A bill of a congress NEWER than every congress collected for its member is
// counted as future_congress, apart from the older bills counted as
// other_congress, and the counts go into the run's summary: that is how a run
// says a new congress has begun before anyone's array lists it. Such a bill
// is not collected until the congress is added to the member's array.
//
// TRUNCATION GUARD. Paging stops at a fixed number of pages. A list is
// complete only if its last page fetched is past the member's oldest congress,
// or there are no more pages. Otherwise sponsorships would be silently dropped,
// so the run fails here and names the list.
// ===================================================================
const S = (v) => (v === null || v === undefined ? '' : String(v).trim());
const ALLOWED = new Set(['s', 'sres', 'sjres', 'sconres', 'hr', 'hjres', 'hconres']);
const members = new Map($('Get Members').all().map((i) => [i.json.member_id, (i.json.congresses || []).map(Number)]));

const pairs = new Map();
const lastPage = new Map();
let scanned = 0, amendments = 0, otherCongress = 0, futureCongress = 0, otherType = 0;
const futureByMember = {};
for (const it of $input.all()) {
  const body = it.json || {};
  const pid = S(body.request && body.request.bioguideId).toUpperCase();
  const sponsoredList = Array.isArray(body.sponsoredLegislation);
  const list = body.sponsoredLegislation || body.cosponsoredLegislation;
  if (!pid || !Array.isArray(list)) {
    throw new Error('[v2 sponsorships] a congress.gov member page came back without a list: ' + JSON.stringify(body).slice(0, 300));
  }
  const kind = sponsoredList ? 'sponsored' : 'cosponsored';
  lastPage.set(pid + '|' + kind, body);
  const congresses = members.get(pid) || [];
  for (const e of list) {
    scanned++;
    if (!e || !e.type || e.number == null || e.amendmentNumber) { amendments++; continue; }
    const ec = Number(e.congress);
    if (congresses.indexOf(ec) === -1) {
      if (congresses.length && ec > Math.max.apply(null, congresses)) {
        futureCongress++;
        futureByMember[pid] = (futureByMember[pid] || 0) + 1;
      } else otherCongress++;
      continue;
    }
    const type = S(e.type).toLowerCase();
    if (!ALLOWED.has(type)) { otherType++; continue; }
    const billId = type + e.number + '-' + e.congress;
    const key = billId + '|' + pid;
    if (pairs.has(key)) continue;
    pairs.set(key, {
      bill_id: billId,
      member_id: pid,
      role: sponsoredList ? 'sponsor' : 'cosponsor',
      introduced_date: S(e.introducedDate) || null,
      congress: Number(e.congress),
      bill_type: type,
      bill_number: Number(e.number),
    });
  }
}

const cutOff = [];
for (const [key, body] of lastPage) {
  const pid = key.split('|')[0];
  const oldest = Math.min.apply(null, members.get(pid) || [0]);
  const list = body.sponsoredLegislation || body.cosponsoredLegislation || [];
  const stillInRange = list.some((e) => e && e.type && e.number != null && !e.amendmentNumber && Number(e.congress) >= oldest);
  if (body.pagination && body.pagination.next && stillInRange) cutOff.push(key);
}
if (cutOff.length) {
  throw new Error('[v2 sponsorships] member legislation was cut off while still inside the congresses collected: ' +
    cutOff.join(', ') + '. Raise maxRequests on Fetch Member Legislation.');
}

const out = Array.from(pairs.values());
const counts = { amendments, other_congress: otherCongress, future_congress: futureCongress, future_congress_by_member: futureByMember, other_type: otherType };
console.log('[v2 sponsorships] scanned ' + scanned + ' | amendments ' + amendments + ' | other congress ' + otherCongress +
  ' | future congress ' + futureCongress + ' | other type ' + otherType + ' | pairs ' + out.length + ' | lists ' + lastPage.size);
return [{ json: { pairs: out, lists: lastPage.size, scanned, counts } }];

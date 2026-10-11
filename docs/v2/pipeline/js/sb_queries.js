// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 1. One congress.gov query per
// in_scope member and list (sponsored, cosponsored).
//
// The lists come newest congress first; Fetch Member Legislation stops paging
// once a whole page is older than the oldest congress collected.
// ===================================================================
const members = $input.all().map((i) => i.json).filter((m) => m.member_id);
const only = String($('Config').first().json.members || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const chosen = only.length ? members.filter((m) => only.indexOf(m.member_id) !== -1) : members;
if (!chosen.length) throw new Error('[v2 sponsorships] no in_scope member with congresses to collect.');
const out = [];
for (const m of chosen) {
  for (const kind of ['sponsored', 'cosponsored']) {
    out.push({ json: {
      member_id: m.member_id,
      congresses: m.congresses,
      kind,
      url: 'https://api.congress.gov/v3/member/' + m.member_id + '/' + kind + '-legislation?limit=250&format=json',
    } });
  }
}
return out;

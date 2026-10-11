// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, step 5. Which bills need their text
// link from congress.gov.
//
// A bill new to the record (WF2 and WF4 both ask at first sight), and a bill
// already held that still has no text link and whose file changed: its text may
// have been published since, which is when a title-only impact statement is
// redone.
//
// Always emits at least one item, so the request node runs and the chain goes
// on when there is nothing to ask: a placeholder item marked skip.
// ===================================================================
const work = $('Find Work').first().json;
const maxBills = Number($('Config').first().json.max_bill_files) || 300;
const batch = (work.bills || []).slice(0, maxBills);
const out = [];
for (const b of batch) {
  if (b.in_core && b.has_text_url) continue;
  const m = String(b.bill_id).match(/^([a-z]+)([0-9]+)-([0-9]+)$/);
  if (!m) continue;
  out.push({ json: { bill_id: b.bill_id, url: 'https://api.congress.gov/v3/bill/' + m[3] + '/' + m[1] + '/' + m[2] + '/text?format=json' } });
}
if (!out.length) out.push({ json: { skip: true, bill_id: null, url: 'https://api.congress.gov/v3/congress/current?format=json' } });
return out;

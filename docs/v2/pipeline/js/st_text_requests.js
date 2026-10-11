// ===================================================================
// v2 PIPELINE: IMPACT STATEMENTS, step 2. One congress.gov text-version list
// request per changed bill (WF5b "Fetch Text Versions"). Always at least one
// item, so the request node runs: a placeholder marked skip.
// ===================================================================
const changed = $('Get Candidates').first().json.changed || [];
const out = changed.map((b) => ({ json: { bill_id: b['Bill ID'],
  url: 'https://api.congress.gov/v3/bill/' + b.Congress + '/' + b['Bill Type'] + '/' + b['Bill Number'] + '/text?format=json' } }));
if (!out.length) out.push({ json: { skip: true, url: 'https://api.congress.gov/v3/congress/current?format=json' } });
return out;

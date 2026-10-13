const item = $('Loop Over Items').item.json;

const title         = item['Official Title'] || '';
const htmUrl        = item['requested_text_url'] || item['Bill Text URL HTM'] || item['Bill Text URL'] || '';
const billStatusUrl = item['Bill Status URL'] || '';
const requestedVersion = String(item['requested_version'] || '').trim();

// Large bill detection - expanded to catch NDAA official title phrasing
const LARGE_BILL_KEYWORDS = [
  'National Defense Authorization',
  'authorize appropriations for fiscal year',
  'military activities of the Department of Defense',
  'Consolidated Appropriations',
  'Making Appropriations',
  'Omnibus',
  'Further Consolidated',
  'Further Additional Continuing',
  'Continuing Appropriations',
  'Continuing Resolution',
  // v2 (2026-10-11): reconciliation bills are as long as an omnibus; hr1-119's
  // statement summarised its appropriations and missed every tax provision.
  'provide for reconciliation'
];

const isLargeBill = LARGE_BILL_KEYWORDS.some(k =>
  title.toLowerCase().includes(k.toLowerCase())
);

// VERSIONED REQUESTS ARE FETCHED, NOT BROWSED (changed 2026-09-29)
// Versioned requests used to be marked FULL_TEXT, which instructs the model to
// read the Bill Text URL itself. Since web search was scoped to external target
// documents only, the model cannot fetch an arbitrary bill URL - so it silently
// fell back to the Official Title and Subject tags already in the prompt and
// summarised THOSE. That is why hr5334-119's enrolled row described the
// educator expense deduction (its Bills Master title) rather than the Russia
// sanctions text it actually contains, and why s1071-119's introduced row
// described the NDAA (its current title) rather than the disinterment measure.
// The titles were right the whole time because WF5b extracts them from the
// text; only the summaries were guessed.
//
// Now the version's text is FETCHED by Fetch Bill Summary and handed to the
// model inline, the same way a BILLSTATUS summary is. The model is given no
// URL to browse and no opportunity to substitute metadata.
//
// v2 (2026-10-11): EVERY BILL IS FETCHED, NOT BROWSED. The same failure hit
// bill-level statements: told to read the Bill Text URL, the model made no web
// search for hr5334-119 or sres13-118 and wrote "the supplied bill text was
// unavailable". A bill-level request now gets its text inline too; a large bill
// keeps the BILLSTATUS summary; a bill with no published text gets the
// BILLSTATUS summary rather than its title alone. Nothing is left to browse.
const versionFetchUrl = requestedVersion || (!isLargeBill && htmUrl) ? htmUrl : '';
const contentSource = 'BILLSTATUS_SUMMARY';   // inline text or summary supplied; prompt forbids fetching

if (!htmUrl) {
  console.warn(`No Bill Text URL for ${item['Bill ID']} - model will rely on BILLSTATUS summary or metadata only`);
}
if (requestedVersion) {
  console.log(`[WF5] ${item['Bill ID']} versioned request ${requestedVersion} (${item['requested_version_date'] || 'no date'}) -> fetching ${versionFetchUrl || 'NO URL'} for inline text`);
}

return [{
  json: {
    ...item,
    bill_text_url:       htmUrl,
    bill_status_url:     billStatusUrl,
    version_fetch_url:   versionFetchUrl,
    bill_content_source: contentSource,
    is_large_bill:       isLargeBill
  }
}];

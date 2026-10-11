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
  'Continuing Resolution'
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
const versionFetchUrl = requestedVersion ? htmUrl : '';
const contentSource = requestedVersion
  ? 'BILLSTATUS_SUMMARY'   // inline text supplied; prompt forbids fetching
  : (isLargeBill ? 'BILLSTATUS_SUMMARY' : 'FULL_TEXT');

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

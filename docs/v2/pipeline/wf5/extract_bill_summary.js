const item = $('Prepare Bill Context').item.json;
const contentSource = item['bill_content_source'];
const requestedVersion = String(item['requested_version'] || '').trim();
const body = $('Fetch Bill Summary').item.json.data || '';

// VERSIONED REQUEST: inline the version's OWN text.
//
// TEXT BUDGET (cut from 120,000 to 30,000 chars on 2026-09-30). At 120k every
// call carried roughly 30k tokens, and a batch of 16 blew the tokens-per-minute
// ceiling outright - runs 14189 and 14190 lost every call to "The service is
// receiving too many requests from you" and wrote nothing. 30k characters is
// about 7.5k tokens, a 4x reduction, and it costs almost nothing in coverage:
// only continuing resolutions and NDAAs run longer, and a bill's operative
// provisions, enacting clause and short title are all at the front. The cut is
// recorded so a truncated summary is never mistaken for a complete reading.
//
// UNUSABLE TEXT: congress.gov publishes no Formatted Text HTM for some
// versions, so WF5b falls back to the PDF url; fetched as text that is binary
// noise and the model would fall back to the Official Title. A PDF header, a
// low readable-character ratio, or a body under 400 chars flags the row instead.
// v2 (2026-10-11): a bill-level request with a text link is inlined the same way.
const inlineLabel = requestedVersion || 'current text';
if (item['version_fetch_url']) {
  const raw = String(body || '');
  let text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

  const looksPdf = /^%PDF-/.test(raw.trim());
  const readable = (text.match(/[A-Za-z0-9 .,;:()'"-]/g) || []).length;
  const readableRatio = text.length ? readable / text.length : 0;
  const tooShort = text.length < 400;
  const unusable = looksPdf || tooShort || readableRatio < 0.85;

  if (unusable) {
    const why = looksPdf ? 'PDF, not text'
      : tooShort ? ('only ' + text.length + ' chars')
      : ('readable ratio ' + readableRatio.toFixed(2));
    console.log('[WF5] ' + item['Bill ID'] + ' ' + inlineLabel +
      ': VERSION TEXT UNUSABLE (' + why + ') - row flagged, summary not trustworthy');
    return [{ json: { ...item,
      bill_summary_text: '',
      bill_summary_action_date: String(item['requested_version_date'] || ''),
      bill_summary_error: 'version text unusable: ' + why,
      version_text_unusable: true
    }}];
  }

  const fullLen = text.length;
  const LIMIT = 30000;
  let note = '';
  if (fullLen > LIMIT) {
    text = text.slice(0, LIMIT);
    note = 'version text truncated at ' + LIMIT + ' of ' + fullLen + ' chars';
  }
  console.log('[WF5] ' + item['Bill ID'] + ' ' + inlineLabel + ': inlined ' +
    Math.min(fullLen, LIMIT) + ' chars' + (note ? ' (' + note + ')' : ''));
  return [{ json: { ...item,
    bill_summary_text: text,
    bill_summary_action_date: String(item['requested_version_date'] || ''),
    bill_summary_error: note,
    version_text_unusable: false
  }}];
}

if (contentSource !== 'BILLSTATUS_SUMMARY') {
  return [{ json: { ...item, bill_summary_text: '', bill_summary_action_date: '' } }];
}

const xml = body;

if (!xml) {
  return [{ json: { ...item, bill_summary_text: '', bill_summary_action_date: '',
    bill_summary_error: 'No XML returned from BILLSTATUS fetch' }}];
}

const summaryRegex = /<summary>([\s\S]*?)<\/summary>/gi;
const matches = [...xml.matchAll(summaryRegex)];

if (!matches.length) {
  return [{ json: { ...item, bill_summary_text: '', bill_summary_action_date: '',
    bill_summary_error: 'No <summary> elements found in BILLSTATUS XML' }}];
}

const summaries = matches.map(match => {
  const block     = match[1];
  const dateMatch = block.match(/<actionDate>(.*?)<\/actionDate>/);
  const textMatch = block.match(/<text>([\s\S]*?)<\/text>/);
  const rawText = textMatch ? textMatch[1] : '';
  const decoded = rawText
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const plainText = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { actionDate: dateMatch ? dateMatch[1].trim() : '', text: plainText };
});

summaries.sort((a, b) => b.actionDate.localeCompare(a.actionDate));

let chosen = summaries[0];
let versionNote = '';
const reqDate = String(item['requested_version_date'] || '').slice(0, 10);
if (reqDate) {
  const eligible = summaries.filter(s => s.actionDate && s.actionDate.slice(0, 10) <= reqDate);
  if (eligible.length) {
    chosen = eligible[0];
  } else {
    versionNote = 'no BILLSTATUS summary dated on or before requested version ' + reqDate + '; used newest (' + (chosen.actionDate || 'undated') + ')';
    console.log('[WF5] ' + item['Bill ID'] + ': ' + versionNote);
  }
}

return [{ json: { ...item,
  bill_summary_text: chosen.text,
  bill_summary_action_date: chosen.actionDate,
  bill_summary_error: versionNote
}}];

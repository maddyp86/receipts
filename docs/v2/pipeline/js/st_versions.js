// ===================================================================
// v2 PIPELINE: IMPACT STATEMENTS, step 3. Which text versions need their own
// statement. WF5b "Build Version Requests", carried over; only its inputs
// change (core instead of the Versions tab and Bills Master).
//
//   text versions <= 1  -> STATUS_CHANGE, nothing to regenerate
//   text versions  > 1  -> every version without a statement is requested,
//                          oldest first, unless its operative text (enacting
//                          clause to the end marker) matches an earlier one
//   disapproval resolutions under chapter 8 of title 5 are never versioned
//   max_pairs caps the requests; a bill past the cap waits whole for next run
// ===================================================================
const maxPairs = Math.max(1, parseInt(cfg.max_pairs, 10) || 100);
const changed = $('Get Candidates').first().json.changed || [];
const reqs = $('Text Requests').all().map((i) => i.json);
const resp = $input.all().map((i) => i.json);
if (reqs.length !== resp.length) throw new Error('[v2 statements] pairing mismatch: ' + resp.length + ' text lists for ' + reqs.length + ' requests.');
const byBill = new Map();
for (let i = 0; i < reqs.length; i++) if (!reqs[i].skip) byBill.set(reqs[i].bill_id, resp[i]);

const isDisapproval = (title) => /congressional\s+disapproval\s+under\s+chapter\s+8\s+of\s+title\s+5/i.test(title || '');
const codeFromUrl = (u) => { const m = String(u || '').match(/BILLS-\d+[a-z]+\d+([a-z]+)\.(htm|html|xml|pdf)/i); return m ? m[1].toLowerCase() : ''; };
const sortKey = (v) => (S(v.date) ? S(v.date) : '9999-12-31');
const plain = (html) => {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/&lt;all&gt;/gi, ' @@END@@ ').replace(/<all>/gi, ' @@END@@ ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return s.replace(/\s+/g, ' ').trim();
};
const operative = (html) => {
  let s = plain(html);
  const m = s.match(/(Resolved by the Senate and House|Resolved,\s|Be it enacted)/i);
  if (!m) return '';
  s = s.slice(m.index);
  const cuts = [s.indexOf('@@END@@'), s.search(/Calendar No\./i)].filter((i) => i > 0);
  if (cuts.length) s = s.slice(0, Math.min.apply(null, cuts));
  s = s.trim().toLowerCase();
  return s.length >= 100 ? s : '';
};
const versionTitle = (html) => {
  const s = plain(html);
  const enact = s.search(/(Resolved by the Senate and House|Resolved,\s|Be it enacted)/i);
  if (enact < 0) return '';
  const head = s.slice(0, enact);
  const re = /\b(AN ACT|A BILL|A JOINT RESOLUTION|JOINT RESOLUTION|CONCURRENT RESOLUTION|RESOLUTION)\b/gi;
  let last = -1, lastLen = 0, mm;
  while ((mm = re.exec(head)) !== null) { last = mm.index; lastLen = mm[0].length; }
  if (last < 0) return '';
  let t = head.slice(last + lastLen).replace(/^[\s_.\-]+/, '').replace(/[\s_]+$/, '').trim();
  t = t.replace(/``/g, '"').replace(/''/g, '"');
  return (t.length < 20 || t.length > 600) ? '' : t;
};
const textHash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  let h2 = 52711;
  for (let i = s.length - 1; i >= 0; i--) h2 = (((h2 << 5) + h2) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + h2.toString(36);
};

const requests = [];
const queue = [];
let requested = 0, deferred = 0, deduped = 0, textUnusable = 0, titleMissing = 0, fetchFailed = 0;
for (const c of changed) {
  const billId = c['Bill ID'];
  const r = byBill.get(billId) || {};
  const tv = Array.isArray(r.textVersions) ? r.textVersions : null;
  if (!tv) { fetchFailed++; queue.push({ bill_id: billId, reason: 'FETCH_FAILED' }); continue; }
  const versions = [];
  for (const v of tv) {
    const formats = Array.isArray(v.formats) ? v.formats : [];
    let url = '';
    for (const p of ['Formatted Text', 'Formatted XML', 'PDF']) { const f = formats.find((x) => S(x.type) === p); if (f && f.url) { url = f.url; break; } }
    if (!url && formats[0]) url = formats[0].url || '';
    const code = codeFromUrl(url);
    if (!code) continue;
    versions.push({ code, type: S(v.type), date: S(v.date).slice(0, 10), url, title: '' });
  }
  const codes = Array.from(new Set(versions.map((v) => v.code)));
  if (isDisapproval(c['Official Title'])) { queue.push({ bill_id: billId, reason: 'STATUS_CHANGE', note: 'disapproval resolution, never versioned' }); continue; }
  if (codes.length <= 1) { queue.push({ bill_id: billId, reason: 'STATUS_CHANGE', versions: codes }); continue; }
  const have = new Set((c.have || []).map((x) => String(x).toLowerCase()));
  const seen = new Set();
  const candidates = [];
  for (const v of versions.filter((x) => !have.has(x.code))) { if (seen.has(v.code)) continue; seen.add(v.code); candidates.push(v); }
  candidates.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  if (candidates.length && requested >= maxPairs) { deferred++; continue; }
  const toRequest = [];
  const skipped = [];
  const hashes = new Map();
  for (const v of candidates) {
    let h = null;
    try {
      const res = await this.helpers.httpRequest({ url: v.url, json: false, timeout: 30000 });
      const body = typeof res === 'string' ? res : (res && res.body ? String(res.body) : '');
      const op = operative(body);
      if (op) h = textHash(op); else textUnusable++;
      v.title = versionTitle(body);
      if (!v.title) titleMissing++;
    } catch (e) { textUnusable++; titleMissing++; }
    if (h && hashes.has(h)) { skipped.push(v.code + '=' + hashes.get(h)); deduped++; continue; }
    if (h) hashes.set(h, v.code);
    toRequest.push(v);
  }
  if (!toRequest.length) { queue.push({ bill_id: billId, reason: 'STATUS_CHANGE', versions: codes, skipped }); continue; }
  for (const v of toRequest) {
    requested++;
    const row = Object.assign({}, c);
    delete row.have;
    requests.push(Object.assign(row, {
      requested_version: v.code, requested_version_type: v.type, requested_version_date: v.date,
      requested_text_url: v.url, requested_version_title: v.title || '',
    }));
  }
  queue.push({ bill_id: billId, reason: 'VERSION_CHANGE', versions: codes, requested: toRequest.map((v) => v.code), skipped });
}
console.log('[v2 statements] ' + changed.length + ' changed bills | ' + requested + ' version pairs | ' + deferred + ' deferred | ' + deduped + ' identical text | ' + fetchFailed + ' list fetch failed');
return [{ json: { requests, queue, counts: { changed: changed.length, requested, deferred, deduped, text_unusable: textUnusable, title_missing: titleMissing, fetch_failed: fetchFailed } } }];

// ===================================================================
// v2 PIPELINE: SPONSORSHIPS AND BILLS, the Result node. Replaces the generic
// Result that build.py's tail() gives every other workflow.
//
// Published to n8n by hand on 17 Oct 2026 (ingest run 107) and brought into
// the repo on 4 Nov 2026 verbatim, so a rebuild no longer drops it. See
// docs/RECONCILIATION.md, 2026-11-04.
// ===================================================================
// One summary back to the caller. A run with errors fails here, AFTER
// writing what it could, so the failure email goes out.
//
// A bill a senator has only just introduced is on their congress.gov list
// hours before the bulk store publishes its file (S.Res. 950 and 951, run 107:
// 404 at 07:00, published that evening). That lag is not a failure: the bill
// waits for the next run, listed under not_yet_published. Still missing
// PENDING_DAYS after it was introduced, it is an error again and the alert
// goes out.
const PENDING_DAYS = 3;
const r = $('Report').first().json;
let runId = null;
try { runId = $('Close Run').first().json.run_id; } catch (e) { runId = null; }
let newPairs = [];
try { newPairs = $('Find Work').first().json.new_pairs || []; } catch (e) { newPairs = []; }
const introOf = (billId) => newPairs
  .filter((p) => p.bill_id === billId && p.introduced_date)
  .map((p) => String(p.introduced_date).slice(0, 10)).sort()[0] || null;
const stale = [];
const fresh = [];
for (const u of r.summary.unreadable || []) {
  const introduced = introOf(u.bill_id);
  const ageDays = introduced ? (Date.now() - new Date(introduced + 'T00:00:00Z').getTime()) / 86400000 : null;
  const pending = / 404\b/.test(String(u.error || '')) && ageDays !== null && ageDays <= PENDING_DAYS;
  (pending ? fresh : stale).push(Object.assign({}, u, { introduced }));
}
const errs = (r.summary.errors || []).filter((e) => !/bill file\(s\) could not be read/.test(e));
if (stale.length) errs.push(stale.length + ' bill file(s) could not be read; they are retried next run: ' + stale.map((u) => u.bill_id).join(', '));
const out = Object.assign({}, r.summary, { unreadable: stale, not_yet_published: fresh, errors: errs, changes: r.changes, ingest_run_id: runId });
if (errs.length && !r.dry_run) throw new Error('[' + $workflow.name + '] ' + errs.join('; ') + (runId ? ' (ingest run ' + runId + ')' : ''));
return [{ json: out }];

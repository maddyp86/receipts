// ============================================
// FLATTEN IMPACT STATEMENT
// ============================================
// DETERMINISTIC Impact UID, derived from bill_id.
// Previously this was Math.random() based, so appendOrUpdate on Impact UID
// could NEVER match an existing row - every re-processing of a bill appended a
// SECOND impact statement under a new UID (s5015-119 had both YBVJMM and
// XHKRH3). That also orphaned the stakeholders, whose UIDs are {ImpactUID}-S1,
// -S2..., which broke the stakeholder join in Bill Embeddings.
// One bill = one impact statement = one stable UID, forever.
//
// VERSIONED ROWS (added 2026-09-19). A versioned request (requested_version
// set by Diff Code from WF5c) keys the row on hash(bill_id|version_code) and
// is routed by Versioned? to Impact Statements - Versions. The main tab's
// Impact UID is untouched: it stays hash(bill_id), so the stakeholder join and
// WF6 are unaffected. Versioned rows carry their stakeholders as a JSON column
// rather than fanning out to Affected Stakeholders.
//
// ERROR GUARD (added 2026-08-07). Parse JSON emits an error item - carrying
// `error` and no `impact_statement` - when the model returns unparseable JSON.
// This node used to destructure that item and dereference
// impact_statement.bill_keywords, throwing a TypeError. Because the node runs
// with onError: continue, the throw became an item `{error: ...}` rather than a
// failure, and Add/Update Impact Statement then mapped every column off an
// object with none of them, writing a row of empty strings to the sheet.
// s3386-119 did exactly this on executions 10554 and 10570.
//
// Errored items are now skipped and logged rather than written. The bill keeps
// Impact Statement Created = FALSE, so it is re-queued on the next run instead
// of being recorded as processed-but-blank. A model failure must never look
// like a successful write.
// ============================================
// TAXONOMY VALIDATION GATE (added 2026-08-09)
// ============================================
// 32 action rows / 30 bills reached Pinecone carrying an (issue_primary,
// issue_sub) pair that does not exist in the Approved Taxonomy. The pair is the
// join key for taxonomy keywords, so an invalid pair means the bill embeds with
// NO "Taxonomy Keywords:" line in pageContent - a thin vector, silently
// under-retrieved. Valid pair -> keywords present; invalid pair -> absent; zero
// exceptions across 943 impact rows. Nothing between the model and the sheet
// checked this.
//
// The prompt already forbids it twice ("NEVER invent a Primary Issue or Sub
// Issue", "NEVER output a (Primary Issue, Sub Issue) pair not present in
// Reference 2"), so a third instruction is not the fix. A gate is, because it
// holds regardless of WHY the model drifted.
//
// One confirmed root cause was not model drift at all: three Subject Area
// Mapping rows (customs enforcement / immigration status and procedures /
// visas and passports) carried 'Foreign Policy & Defense' + 'Immigration &
// Border Security', a pair absent from the taxonomy. Reference 3 is explicitly
// allowed to override the Policy Area primary, so the model produced an invalid
// pair while obeying every rule it was given. Those rows are corrected, but
// they explain only 2 of the 30 bills - the rest have no identified cause,
// which is exactly why this is a gate and not a one-off repair.
//
// Behaviour, in order:
//   pair valid                                  -> pass through
//   invalid, sub-issue unique to one primary    -> REPAIR the primary, log it
//   invalid and ambiguous, or sub unknown       -> SKIP, log loudly, do not write
//
// The unrepairable case SKIPS rather than throws, and that is deliberate. This
// node runs onError: continueRegularOutput, so a throw here is NOT a failure -
// n8n converts it into an item on the regular output, which flows to
// Add/Update Impact Statement and writes a row of empty strings. That is the
// exact 2026-08-07 bug described above, and a throw would have reintroduced it:
// a silent bad classification replaced by a silent blank row.
//
// Skipping keeps Impact Statement Created = FALSE for that bill, so it is
// re-queued on the next run rather than recorded as processed. The bill cannot
// be silently lost, only silently deferred - and the log line names every one.
//
// The repair case is the observed failure mode: a real sub-issue attached to
// the wrong primary (e.g. 'Elections & Voting Rights' under Government Reform
// instead of Civil Rights & Liberties).
//
// Measured against the 30 bills repaired by hand on 2026-08-09, this gate would
// have AUTO-REPAIRED 18 and SKIPPED 12. All 18 repairs match the answer chosen
// manually, exactly - where a sub-issue exists under only one primary, the
// deterministic answer and the human answer are the same. The 12 skipped are the
// ones that genuinely needed judgement: their sub-issue ('Terrorism Risk
// Insurance', 'Employee Benefits', 'Sanctions', ...) does not exist in the
// taxonomy at all, so no answer is derivable and guessing would be worse than
// deferring the bill.
//
// Repairs are LOGGED rather than silent - if the repair count climbs, that is
// the model degrading and it must stay visible, not quietly corrected.

// Returns null rather than throwing, for the same reason the unrepairable case
// skips: under onError: continueRegularOutput a throw becomes an item on the
// regular output and Add/Update Impact Statement writes it as a blank row.
// Nothing in this node may throw.
function loadTaxonomy() {
  let rows;
  try {
    rows = $('Get Approved Taxonomy').all();
  } catch (e) {
    console.log('[taxonomy gate] Get Approved Taxonomy is unavailable (' + e.message +
                '). Refusing to write unvalidated rows - 0 written, batch re-queues next run.');
    return null;
  }
  const pairs = new Set();
  const subToPrimaries = new Map();
  for (const r of rows) {
    const p = String((r.json || {})['Primary Issue'] || '').trim();
    const s = String((r.json || {})['Sub Issue'] || '').trim();
    if (!p || !s) continue;
    pairs.add(p + '||' + s);
    if (!subToPrimaries.has(s)) subToPrimaries.set(s, new Set());
    subToPrimaries.get(s).add(p);
  }
  if (pairs.size === 0) {
    console.log('[taxonomy gate] Approved Taxonomy returned 0 usable pairs. Refusing to ' +
                'write unvalidated rows - 0 written, batch re-queues next run.');
    return null;
  }
  return { pairs: pairs, subToPrimaries: subToPrimaries };
}

function impactUID(billId) {
  const key = String(billId || '').trim();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h << 5) + h) ^ key.charCodeAt(i)) >>> 0;
  let uid = h.toString(36).toUpperCase();
  // second pass so short hashes still fill 6 chars deterministically
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) h2 = (((h2 << 5) + h2) ^ key.charCodeAt(key.length - 1 - i)) >>> 0;
  uid = (uid + h2.toString(36).toUpperCase()).slice(0, 6);
  return uid.padEnd(6, '0');
}

const items = $input.all();
const results = [];
const skipped = [];
const repaired = [];
const unresolved = [];

// A broken gate that passes everything is worse than no gate - it looks like
// validation happened. If the taxonomy cannot be loaded, write nothing; every
// bill keeps Impact Statement Created = FALSE and returns on the next run.
const TAX = loadTaxonomy();
if (!TAX) return [];

for (const item of items) {
  const { bill_id, title, congress, impact_statement } = item.json;

  // GUARD 1 - upstream parse/API failure. Parse JSON already recorded the
  // reason; carry it into the log rather than dereferencing a missing object.
  if (item.json.error) {
    skipped.push(`${bill_id || '(no bill_id)'}: ${item.json.error}` +
                 (item.json.error_message ? ` - ${item.json.error_message}` : ''));
    continue;
  }

  // GUARD 2 - defensive. Nothing should reach here without an impact_statement
  // object, but a blank sheet write is worse than a skipped bill.
  if (!impact_statement || typeof impact_statement !== 'object') {
    skipped.push(`${bill_id || '(no bill_id)'}: missing impact_statement object`);
    continue;
  }

  // GUARD 3 - a row with no bill_id cannot be upserted. Add/Update matches on
  // Bill ID, so an empty value appends an unmatchable row.
  if (!bill_id || !String(bill_id).trim()) {
    skipped.push('(no bill_id): refusing to write a row with an empty match key');
    continue;
  }

  // GUARD 4 - taxonomy validity. See the gate notes above. Runs before the UID
  // is derived so nothing invalid gets as far as being shaped for the sheet.
  let primary = String(impact_statement.issue_primary || '').trim();
  let sub     = String(impact_statement.issue_sub || '').trim();

  if (!TAX.pairs.has(primary + '||' + sub)) {
    const owners = TAX.subToPrimaries.get(sub);
    if (owners && owners.size === 1) {
      const corrected = Array.from(owners)[0];
      repaired.push(`${bill_id}: '${primary}' / '${sub}' -> '${corrected}' / '${sub}'`);
      primary = corrected;
    } else if (!owners) {
      unresolved.push(`${bill_id}: sub-issue '${sub}' does not exist in the Approved Taxonomy (primary was '${primary}')`);
      continue;
    } else {
      unresolved.push(`${bill_id}: pair '${primary}' / '${sub}' is invalid and '${sub}' is ambiguous across ${Array.from(owners).join(', ')}`);
      continue;
    }
  }

  // Deterministic: same bill always yields the same UID. A versioned request
  // keys on bill|version so each text version gets its own stable row on the
  // Versions tab without touching the main tab's UID.
  const requestedVersion = String(item.json.requested_version || '').trim();
  const impactUIDValue = requestedVersion
    ? impactUID(String(bill_id).trim() + '|' + requestedVersion)
    : impactUID(bill_id);

  // Congress arrives from Parse JSON; derive from bill_id as a fallback only.
  const resolvedCongress =
    (congress ?? (bill_id ? parseInt(String(bill_id).split('-').pop(), 10) : null));

  // Normalize bill_keywords — accept array or comma-separated string
  const rawKeywords = impact_statement.bill_keywords || [];
  const keywordsArray = Array.isArray(rawKeywords)
    ? rawKeywords
    : String(rawKeywords).split(',').map(k => k.trim()).filter(Boolean);

  const stakeholdersOut = (impact_statement.affected_stakeholders || []).map(stakeholder => ({
    impact_statement_uid: impactUIDValue,
    stakeholder_group:    stakeholder.group,
    positive_impact:      (stakeholder.positive_impact || []).join('; '),
    negative_impact:      (stakeholder.negative_impact || []).join('; ')
  }));

  // Create flattened impact statement record
  results.push({
    json: {
      // Identifiers
      impact_uid:   impactUIDValue,
      bill_id:      bill_id,
      congress:     resolvedCongress,
      title:        title,

      // Policy classification
      policy_area_raw: impact_statement.policy_area_raw,
      issue_primary:   primary,
      issue_sub:       sub,

      // Effects and mechanisms (joined as strings)
      intended_effects: (impact_statement.intended_effects || []).join('; '),
      mechanisms:       (impact_statement.mechanisms || []).join('; '),

      // Bill keywords — stored as both joined string (for Sheets)
      // and array (for Pinecone metadata and pageContent assembly)
      bill_keywords:        keywordsArray.join(', '),

      // Summary
      neutral_summary: impact_statement.neutral_summary,

      // Classification audit
      classification_note: impact_statement.classification_note || '',

      // Regulatory action block (Parse JSON always supplies a normalized one;
      // defaulted here so the sheet mappings never dereference undefined)
      regulatory_action: impact_statement.regulatory_action || {
        reverses_existing_policy: false, target_type: 'NONE', target_name: 'N/A',
        target_source: 'N/A', target_effect: 'N/A', direction_confidence: 0
      },

      // Keep stakeholders as structured array for downstream processing
      affected_stakeholders: stakeholdersOut,
      stakeholders_json:     JSON.stringify(stakeholdersOut),

      // Version identity (empty on the normal path)
      version_title:          String(item.json.version_title || ''),
      requested_version:      requestedVersion,
      requested_version_type: String(item.json.requested_version_type || ''),
      requested_version_date: String(item.json.requested_version_date || ''),
      requested_text_url:     String(item.json.requested_text_url || ''),
      summary_action_date:    String(item.json.summary_action_date || '')
    }
  });
}

// ============================================
// CROSS-VERSION TAXONOMY DIVERGENCE (added 2026-09-19)
// ============================================
// The (Primary Issue, Sub Issue) pair is the join key for taxonomy keywords and
// feeds retrieval, and it proved unstable across versions of the SAME bill in
// the first versions backfill:
//   s1071-119  is,es  -> Families / Family Policy
//              eah,enr-> Foreign Policy & Defense / Defense Spending
//   s836-119   is,es  -> Government Reform / Government Operations
//              rs     -> Civil Rights & Liberties / Minors & Children
// s1071's eah and enr genuinely ARE a different bill (a VA disinterment
// measure became the NDAA), so divergence is sometimes correct. s836's rs
// diverging from its own is and es on near-identical text is model drift.
//
// Because both cases exist, this FLAGS rather than pins: no value is changed,
// a taxonomy_divergent flag is set on every affected row and the bill is named
// in the log. Pinning to the first version seen would silently overwrite the
// correct answer on genuine gut-and-amend bills, which is the one case the
// whole versions track exists to capture.
//
// BATCHING (fixed 2026-09-20 after run 13883). This node sits inside
// Loop Over Items1 and therefore runs ONCE PER ROW - 13 invocations of one row
// each on that run. The first version of this check compared rows within a
// single invocation and so could never see more than one, reporting zero
// divergence while s1071-119 and s836-119 both plainly diverged. The map is
// built from $('Parse JSON').all(), which returns the whole batch regardless of
// loop position, and the flag is then applied to whichever row is in hand.
//
// Those are PRE-taxonomy-repair pairs: a repaired primary could in principle
// resolve or create a divergence the map does not see. Repairs are rare and
// logged separately, so the approximation is accepted rather than restructuring
// the loop.
//
// Only versioned rows are compared. The normal path writes one row per bill and
// has nothing to diverge from.
let parsedRows = [];
try { parsedRows = $('Parse JSON').all().map(i => i.json); } catch (e) { parsedRows = []; }

const byBill = new Map();
for (const j of parsedRows) {
  if (!j || !j.requested_version || j.error) continue;
  const st = j.impact_statement || {};
  const primary = String(st.issue_primary || '').trim();
  const sub = String(st.issue_sub || '').trim();
  if (!primary || !sub) continue;
  const b = String(j.bill_id || '');
  if (!byBill.has(b)) byBill.set(b, []);
  byBill.get(b).push({ version: j.requested_version, pair: primary + ' / ' + sub });
}

const divergenceByBill = new Map();
const divergent = [];
for (const [billId, rows] of byBill.entries()) {
  if (rows.length < 2) continue;
  const pairs = new Map();
  for (const r of rows) {
    if (!pairs.has(r.pair)) pairs.set(r.pair, []);
    pairs.get(r.pair).push(r.version);
  }
  if (pairs.size < 2) continue;
  const detail = Array.from(pairs.entries())
    .map(([pair, codes]) => codes.join(',') + ' -> ' + pair)
    .join(' | ');
  divergenceByBill.set(billId, detail);
  divergent.push(billId + ': ' + detail);
}

for (const r of results) {
  if (!r.json.requested_version) continue;
  const detail = divergenceByBill.get(String(r.json.bill_id || ''));
  if (detail) {
    r.json.taxonomy_divergent = true;
    r.json.taxonomy_divergence_detail = detail;
  }
}
if (divergent.length && results.some(r => r.json.taxonomy_divergent)) {
  console.log(
    '[versions] TAXONOMY DIVERGENCE across versions of ' + divergent.length +
    ' bill(s) - rows written and flagged, NOT corrected: ' + divergent.join(' :: ') +
    ' :: review whether the bill genuinely changed subject (gut-and-amend) or the ' +
    'model drifted on identical text.'
  );
}

// Reported AFTER the loop so the log names every offending bill at once rather
// than surfacing the first and hiding the rest. Not a throw - see the gate
// notes: onError: continueRegularOutput would turn a throw into a blank sheet
// row, which is the failure this gate exists to prevent.
if (unresolved.length) {
  console.log(
    `[taxonomy gate] UNRESOLVED ${unresolved.length} bill(s) - NOT WRITTEN, will be ` +
    `re-queued next run: ${unresolved.join(' | ')} :: fix by adding the missing pair ` +
    `to the Approved Taxonomy, or by correcting the Subject Area Mapping row that ` +
    `points at a pair which no longer exists.`
  );
}

if (repaired.length) {
  console.log(`[taxonomy gate] REPAIRED ${repaired.length} invalid pair(s): ${repaired.join(' | ')}`);
}

if (skipped.length) {
  console.log(`[flatten] SKIPPED ${skipped.length} bill(s), nothing written for them: ${skipped.join(' | ')}`);
}
console.log(
  `Flattened ${results.length} impact statements (deterministic UIDs) | ` +
  `taxonomy repaired ${repaired.length} | taxonomy unresolved ${unresolved.length} | ` +
  `skipped ${skipped.length} | taxonomy divergent bills ${divergent.length} | in ${items.length}`
);
return results;

// ===================================================================
// PRE-EVALUATOR GATES  (WF10a — new Code node, "Run Once for All Items")
// ===================================================================
// Wiring:  Enrich With Statement Type -> THIS NODE -> Scorable?
//   Scorable? [true]  -> Loop Over Items (evaluator)
//   Scorable? [false] -> Format Gated Alignments   (see 04: reads 'Gate Verdict')
//
// Deterministic. Reads only the enriched match row plus two reference reads
// by $() reference (Get Statements for Date/Scope columns, Get Roll Call Votes
// for cloture result). Every rule here is one the LLM cannot be trusted to
// apply because it lacks the inputs, and every rule fails OPEN when its inputs
// are missing — a missing column costs one wasted evaluation, never a silently
// dropped promise. The gate reason always says what it could and could not see.
//
// Gates, in order (first hit wins; all hits are recorded in 'Gate Hits'):
//   G1a BOUNDED promise, action outside [Date, Valid Until]  -> NOT_APPLICABLE_EXPIRED
//   G1b promise names an administration, bill is a different one -> NOT_APPLICABLE_EXPIRED
//   G1c promise presupposes MAJORITY_LEADER, senator was not one at action date -> NOT_APPLICABLE_EXPIRED
//   G1d Speech Act OPERATIONAL / CREDIT_CLAIM / RHETORIC          -> NOT_APPLICABLE
//   G2  cloture dated after passage (vote pairing across versions) -> NOT_DETERMINABLE
//   G3  floor leader NAY on cloture, whip YEA (Rule XIII switch)  -> PROCEDURAL_SWITCH
//   G4  broad vehicle with generic stakeholders                   -> NOT_DETERMINABLE
//   G4b Partial Subtype DATED_VEHICLE (from WF7b)                 -> NOT_APPLICABLE_EXPIRED
//
// Rows that pass carry the context the evaluator v7 prompt expects:
//   'Promise Date', 'Scope', 'Valid Until', 'Anchor Entity', 'Role Condition',
//   'Senator Role', 'Cloture Result', 'Bill Class', 'Vote Flags'
// ===================================================================

const S = (v) => (v === null || v === undefined ? '' : String(v).trim());
const U = (v) => S(v).toUpperCase();
const pick = (o, name) => {
  const t = S(name).toLowerCase();
  for (const k of Object.keys(o || {})) if (S(k).toLowerCase() === t) return o[k];
  return undefined;
};
const voteOf = (v) => {
  const t = U(v);
  if (['YEA','AYE','YES'].includes(t)) return 'YEA';
  if (['NAY','NO'].includes(t)) return 'NAY';
  if (t.includes('NOT')) return 'NOT_VOTING';
  return null;
};
const parseDate = (v) => {
  const t = S(v);
  if (!t || t === 'NA' || t === 'N/A' || t === 'UNKNOWN') return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
};
const iso = (d) => (d ? d.toISOString().slice(0,10) : 'unknown');
const congressOf = (billId) => { const m = S(billId).match(/-(\d{3})$/); return m ? m[1] : ''; };

// ---------------- REFERENCE DATA ----------------
// Fallback only. Prefer a 'Role' column on the Politicians tab, format
// "MAJORITY_LEADER:119;MINORITY_LEADER:118" (role:congress pairs).
const FLOOR_LEADERS_FALLBACK = {
  '118': { S000148: 'MAJORITY_LEADER', M000355: 'MINORITY_LEADER' },
  '119': { T000250: 'MAJORITY_LEADER', S000148: 'MINORITY_LEADER' }
};
const PRESIDENT_BY_CONGRESS = { '117': 'BIDEN', '118': 'BIDEN', '119': 'TRUMP' };
const CONGRESS_START = { '117': '2021-01-03', '118': '2023-01-03', '119': '2025-01-03', '120': '2027-01-03' };

const BROAD_VEHICLE_RE = /continuing appropriations|consolidated appropriations|further appropriations|omnibus|minibus|authorize appropriations for fiscal year|making appropriations for the department|making appropriations for military construction|making emergency supplemental appropriations|en bloc consideration/i;
const GENERIC_STAKEHOLDER_RE = /^(federal agencies( and executive branch departments)?|department of defense|active duty military personnel|senators|u\.s\. senators|federal government|congress|federal agencies and departments)$/i;
const NON_SCORABLE_SPEECH = new Set(['OPERATIONAL', 'CREDIT_CLAIM', 'RHETORIC']);

// ---------------- reference reads (fail open) ----------------
const stmtMeta = new Map();          // Promise UID -> {date, scope, validUntil, anchor, role, speechAct}
try {
  for (const it of $('Get Statements').all()) {
    const j = it.json || {};
    const uid = S(pick(j, 'Promise UID'));
    if (!uid) continue;
    stmtMeta.set(uid, {
      date:       parseDate(pick(j, 'Date')),
      scope:      U(pick(j, 'Scope')),
      validUntil: parseDate(pick(j, 'Valid Until')),
      validUntilRaw: S(pick(j, 'Valid Until')),
      anchor:     S(pick(j, 'Anchor Entity')),
      role:       U(pick(j, 'Role Condition')),
      speechAct:  U(pick(j, 'Speech Act'))
    });
  }
} catch (e) { console.log('[GATES] Get Statements unavailable: ' + e.message); }

const rollCall = new Map();          // Vote ID -> {result, date}
let rollCallHasResult = false;
try {
  for (const it of $('Get Roll Call Votes').all()) {
    const j = it.json || {};
    const vid = S(pick(j, 'Vote ID'));
    if (!vid) continue;
    const result = U(pick(j, 'Results') || pick(j, 'Result') || pick(j, 'Vote Result') || pick(j, 'Outcome'));
    if (result) rollCallHasResult = true;
    rollCall.set(vid, { result, date: parseDate(pick(j, 'Date')) });
  }
} catch (e) { console.log('[GATES] Get Roll Call Votes unavailable: ' + e.message); }

let politicianRole = '';             // raw 'Role' cell from Politicians tab, if present
try { politicianRole = S(pick($('Get Politician').first().json || {}, 'Role')); } catch (e) {}

const roleAt = (pol, congress) => {
  // "MAJORITY_LEADER:119;MINORITY_LEADER:118"
  if (politicianRole) {
    for (const part of politicianRole.split(';')) {
      const [r, c] = part.split(':').map(S);
      if (c === congress && r) return U(r);
    }
  }
  return (FLOOR_LEADERS_FALLBACK[congress] || {})[pol] || 'NONE';
};
const clotureResultNorm = (r) => {
  if (!r) return '';
  if (/REJECT|FAIL|NOT AGREED|NOT INVOKED/.test(r)) return 'REJECTED';
  if (/AGREED|INVOKED|PASS|CONFIRM|ADOPT/.test(r)) return 'AGREED';
  return r;
};

// ---------------- MAIN ----------------
const items = $input.all();
const out = [];
const tally = {};
let passed = 0;

for (const item of items) {
  const j = item.json;
  const hits = [];

  // Already gated upstream (promise type / stance)? Pass through untouched.
  if (pick(j, 'Scorable') === false) { out.push(item); tally['upstream'] = (tally['upstream'] || 0) + 1; continue; }

  const pol      = S(pick(j, 'Politician ID'));
  const uid      = S(pick(j, 'Promise UID'));
  const billId   = S(pick(j, 'Bill ID'));
  const congress = congressOf(billId);
  const promise  = S(pick(j, 'Promise Text'));
  const title    = S(pick(j, 'Bill Title'));
  const meta     = stmtMeta.get(uid) || {};

  const cloture  = voteOf(pick(j, 'Cloture Vote'));
  const passage  = voteOf(pick(j, 'Passage Vote'));
  const whip     = voteOf(pick(j, 'Party Whip Vote'));
  const clotureId = S(pick(j, 'Cloture Vote ID'));
  const clotureDate = parseDate(pick(j, 'Cloture Vote Date'));
  const passageDate = parseDate(pick(j, 'Passage Vote Date'));
  const actionDate  = passageDate || clotureDate || (congress && CONGRESS_START[congress] ? new Date(CONGRESS_START[congress]) : null);
  const actionDateIsProxy = !passageDate && !clotureDate;

  const senatorRole = roleAt(pol, congress);
  const rc = rollCall.get(clotureId) || {};
  const clotureResult = clotureResultNorm(rc.result);

  // Stakeholders: first group only is on the row as 'Stakeholder Group'; the
  // full array may be present as Affected_Stakeholders from Group Stakeholders.
  const stakeArr = Array.isArray(j.Affected_Stakeholders) ? j.Affected_Stakeholders.map(x => S(x['Stakeholder Group'])) : [S(pick(j, 'Stakeholder Group'))];
  const allGeneric = stakeArr.length > 0 && stakeArr.every(sg => !sg || GENERIC_STAKEHOLDER_RE.test(sg));
  const broad = BROAD_VEHICLE_RE.test(title);
  const billClass = broad ? 'BROAD_VEHICLE' : (/disapproval|disapproving|terminating|to repeal/i.test(title) ? 'REVERSAL' : 'TARGETED');

  // ---- G1d: speech act
  if (meta.speechAct && NON_SCORABLE_SPEECH.has(meta.speechAct)) {
    hits.push({ gate: 'G1_scope', verdict: 'NOT_APPLICABLE', reason:
      `Speech Act is ${meta.speechAct}. Scheduling, credit-claiming and rhetorical statements have no deliverable a vote or sponsorship can fulfil or break.` });
  }

  // ---- G1a: bounded window
  if (!hits.length && meta.scope === 'BOUNDED') {
    if (meta.validUntil && actionDate && actionDate > meta.validUntil) {
      hits.push({ gate: 'G1_scope', verdict: 'NOT_APPLICABLE_EXPIRED', reason:
        `Bounded statement (${meta.anchor || 'window'}) valid until ${iso(meta.validUntil)}; this action is dated ${iso(actionDate)}${actionDateIsProxy ? ' (Congress start used as proxy - no vote date on row)' : ''}. The statement had already closed.` });
    } else if (!meta.validUntil && meta.validUntilRaw === 'UNKNOWN') {
      hits.push({ gate: 'G1_scope', verdict: 'NOT_DETERMINABLE', reason:
        `Bounded statement with no resolvable window (Valid Until = UNKNOWN, statement date ${iso(meta.date)}). Cannot establish whether this action falls inside it.` });
    }
  }

  // ---- G1b: administration anchor
  if (!hits.length) {
    const m = promise.match(/President (Biden|Trump|Obama)|(Biden|Trump|Obama)('s)? (administration|EPA|nominees|judicial nominees)/i);
    const named = m ? U(m[1] || m[2]) : '';
    if (named && congress && PRESIDENT_BY_CONGRESS[congress] && PRESIDENT_BY_CONGRESS[congress] !== named) {
      hits.push({ gate: 'G1_scope', verdict: 'NOT_APPLICABLE_EXPIRED', reason:
        `Statement is about the ${named} administration; the bill is from the ${congress}th Congress (${PRESIDENT_BY_CONGRESS[congress]} administration). Different object.` });
    }
  }

  // ---- G1c: role precondition
  if (!hits.length && meta.role === 'MAJORITY_LEADER' && senatorRole !== 'MAJORITY_LEADER') {
    hits.push({ gate: 'G1_scope', verdict: 'NOT_APPLICABLE_EXPIRED', reason:
      `Statement presupposes control of the floor (Role Condition = MAJORITY_LEADER); at the time of this action the senator was ${senatorRole === 'NONE' ? 'not in leadership' : senatorRole}. The precondition no longer held.` });
  }

  // ---- G4b: WF7b said the promise pointed at one closed vehicle
  if (!hits.length && U(pick(j, 'Partial Subtype')) === 'DATED_VEHICLE') {
    hits.push({ gate: 'G4_vehicle', verdict: 'NOT_APPLICABLE_EXPIRED', reason:
      `Relevance step classified the statement as pointing at a specific closed vehicle (${S(pick(j, 'Anchor Vehicle')) || 'see Anchor Vehicle'}); this bill is a different one.` });
  }

  // ---- G2: vote pairing sanity
  if (!hits.length && clotureDate && passageDate && clotureDate > passageDate) {
    hits.push({ gate: 'G2_split_vote', verdict: 'NOT_DETERMINABLE', reason:
      `Cloture (${iso(clotureDate)}) is dated after passage (${iso(passageDate)}): the two votes are on different versions of the vehicle. Cannot pair them into one action.` });
  }

  // ---- G3: floor leader reconsideration switch
  if (!hits.length && senatorRole !== 'NONE' && cloture === 'NAY' && whip === 'YEA') {
    const resultKnown = !!clotureResult;
    if (!resultKnown || clotureResult === 'REJECTED') {
      hits.push({ gate: 'G3_leader_switch', verdict: 'PROCEDURAL_SWITCH', reason:
        `${senatorRole.replace('_', ' ').toLowerCase()} voted NAY on cloture (${clotureId}) while the party whip voted YEA` +
        (resultKnown ? ' and cloture was rejected' : (rollCallHasResult ? '; cloture result not found for this roll call' : '; Roll Call Votes has no Result column, so outcome is unverified')) +
        `. Under Senate Rule XIII only a member on the prevailing side may move to reconsider; a leader switching to NAY on a failing cloture is preserving that motion, not opposing the bill.` });
    }
  }

  // ---- G4: broad vehicle with generic stakeholders
  if (!hits.length && broad && allGeneric) {
    hits.push({ gate: 'G4_vehicle', verdict: 'NOT_DETERMINABLE', reason:
      `Bill is a broad vehicle ("${title.slice(0, 80)}") and the impact analysis names only generic stakeholders (${stakeArr.filter(Boolean).join('; ') || 'none'}). A vote on a vehicle that funds or authorizes everything is not evidence about one promise unless the promised item is named.` });
  }

  // ---- record
  const hit = hits[0];
  const passedRow = !hit;
  if (passedRow) passed++;
  for (const h of hits) tally[h.gate + ':' + h.verdict] = (tally[h.gate + ':' + h.verdict] || 0) + 1;

  // Split-vote flag travels with the row either way; evaluator v7 and
  // deriveAlignment both read it.
  const flags = [];
  if (cloture && passage && cloture !== passage && cloture !== 'NOT_VOTING' && passage !== 'NOT_VOTING') flags.push('SPLIT_VOTE');
  if (actionDateIsProxy) flags.push('ACTION_DATE_PROXY');
  if (senatorRole !== 'NONE') flags.push('FLOOR_LEADER');

  out.push({ json: Object.assign({}, j, {
    'Scorable': passedRow,
    'Gate Verdict': hit ? hit.verdict : '',
    'Gate Reason': hit ? hit.reason : S(pick(j, 'Gate Reason')),
    'Gate Hits': hits.map(h => h.gate + ':' + h.verdict).join(';'),
    // context for evaluator v7
    'Promise Date': iso(meta.date),
    'Scope': meta.scope || 'UNKNOWN',
    'Valid Until': meta.validUntil ? iso(meta.validUntil) : (meta.validUntilRaw || ''),
    'Anchor Entity': meta.anchor || '',
    'Role Condition': meta.role || 'UNKNOWN',
    'Senator Role': senatorRole,
    'Cloture Result': clotureResult || 'UNKNOWN',
    'Bill Congress': congress,
    'Action Date': iso(actionDate),
    'Bill Class': billClass,
    'Vote Flags': flags.join(';')
  })});
}

console.log(`[GATES] ${items.length} rows -> ${passed} to evaluator | gated: ${JSON.stringify(tally)} | statements with Scope columns: ${[...stmtMeta.values()].filter(m => m.scope).length}/${stmtMeta.size} | roll call has Result: ${rollCallHasResult}`);

if (out.length !== items.length) throw new Error(`Pre-Evaluator Gates: emitted ${out.length} rows for ${items.length} inputs`);
return out;

// ===================================================================
// deriveAlignment — REPLACEMENT for the function of the same name inside
// WF10a 'Parse LLM Response'. Replace from `const deriveAlignment = (` through
// the closing `};` of that function. Nothing else in the node changes, except
// the two call-site additions noted at the bottom.
// ===================================================================
// 2026-09-05 — "ANY NAY GOVERNS" REMOVED.
// The previous rule collapsed every split cloture/passage vote to opposition,
// in both directions: cloture NAY + passage YEA -> "the block is the real
// position"; cloture YEA + passage NAY -> "the passage NAY is the real
// position". Whichever vote was NAY became decisive. That is not a rule about
// which vote is binding; it is a rule that a split is always a BROKE. Audit
// found 14 rows produced this way, including March 2025 CR votes where the
// cloture YEA was the operative 60-vote act and the passage NAY was symbolic.
//
// New rule, applied SYMMETRICALLY:
//   - If both votes exist and agree -> that direction.
//   - If they diverge: the vote taken at the BINDING threshold governs.
//       Cloture requires 60 (or 51 on nominations after 2013/2017, which are
//       handled as passage-only rows). When a cloture vote exists on a bill,
//       cloture is where the bill lives or dies -> cloture governs.
//       Passage governs only when no cloture vote was taken.
//     A divergent row ALWAYS carries the 'SPLIT_VOTE' flag so the sheet, WF11
//     and the query tool display both votes, and confidence is capped at 0.75
//     downstream (see evaluator v7 + the cap at the call site).
//   - Sponsor + any NAY -> PROCEDURAL_SWITCH (unchanged).
//   - Rows already stamped by Pre-Evaluator Gates ('Gate Verdict') never reach
//     this function; they exit at Scorable? [false].
// ===================================================================
const deriveAlignment = (billEffect, matchData, statementType) => {
  const effect = String(billEffect || '').toUpperCase();
  const isPromise = statementType === 'Campaign Promise';
  const KEPT  = isPromise ? 'KEPT'  : 'CONSISTENT';
  const BROKE = isPromise ? 'BROKE' : 'INCONSISTENT';
  const ND    = 'NOT_DETERMINABLE';

  if (effect === 'ERROR') return { verdict: 'ERROR', governing: 'NA', split: false };
  if (effect === 'NEUTRAL' || effect === 'CONTESTED') return { verdict: ND, governing: 'NA', split: false };
  if (effect !== 'ADVANCE' && effect !== 'HINDER') return { verdict: ND, governing: 'NA', split: false };

  const voteOf = (v) => {
    const t = String(v == null ? '' : v).trim().toUpperCase();
    if (t === 'YEA' || t === 'AYE' || t === 'YES') return 'YEA';
    if (t === 'NAY' || t === 'NO') return 'NAY';
    return null;
  };
  const truthy = (v) => {
    const t = String(v == null ? '' : v).trim().toUpperCase();
    return t === 'TRUE' || t === 'YES' || t === 'Y' || t === '1';
  };

  const cloture = voteOf(matchData['Cloture Vote']);
  const passage = voteOf(matchData['Passage Vote']);
  const plain   = voteOf(matchData['Vote']);        // legacy resolved vote, used only if neither typed vote exists
  const sponsored = truthy(matchData['Is Sponsor']) || truthy(matchData['Is Co-Sponsor']);

  const anyNay = [cloture, passage, plain].includes('NAY');
  if (sponsored && anyNay) return { verdict: 'PROCEDURAL_SWITCH', governing: 'SPONSOR_NAY', split: false };

  let effective = null, governing = 'NA', split = false;
  if (cloture && passage) {
    split = cloture !== passage;
    effective = cloture;                 // cloture is the binding vote when it exists
    governing = split ? 'CLOTURE (60-vote threshold; split vote)' : 'CLOTURE+PASSAGE (agree)';
  } else if (cloture) { effective = cloture; governing = 'CLOTURE (only vote recorded)'; }
  else if (passage)   { effective = passage; governing = 'PASSAGE (no cloture vote)'; }
  else if (plain)     { effective = plain;   governing = 'VOTE (untyped)'; }

  let supported;
  if (effective) supported = effective === 'YEA';
  else if (sponsored) { supported = true; governing = 'SPONSORSHIP'; }
  else return { verdict: ND, governing: 'NO_ACTION', split: false };

  const verdict = effect === 'ADVANCE' ? (supported ? KEPT : BROKE) : (supported ? BROKE : KEPT);
  return { verdict, governing, split };
};

// ===================================================================
// CALL-SITE CHANGES inside the MAIN loop of 'Parse LLM Response'
// ===================================================================
// The function now returns an object. Where the node currently does something like:
//
//     const derivedVerdict = deriveAlignment(billEffect, matchData, statementType);
//
// change to:
//
//     const derived = deriveAlignment(billEffect, matchData, statementType);
//     const derivedVerdict = derived.verdict;
//
// and in the results.push({ json: { ... } }) success block add:
//
//     vote_governing: derived.governing,
//     vote_flags: [
//       derived.split ? 'SPLIT_VOTE' : null,
//       s(matchData['Vote Flags'], '').includes('FLOOR_LEADER') ? 'FLOOR_LEADER' : null
//     ].filter(Boolean).join(';'),
//     alignment_confidence: toStr(
//       derived.split
//         ? Math.min(parseFloat(parsed.alignment_confidence ?? parsed.confidence ?? 0), 0.75)
//         : (parsed.alignment_confidence ?? parsed.confidence ?? '0')
//     ),
//
// (replace the existing alignment_confidence line). Add 'Vote Governing',
// 'Vote Flags' and 'Grade' columns to 'Add Promise Alignments (Workflow A)'.
//
// GRADE = PENDING on every accusation (added 2026-09-05, WF13 contract):
//
//     grade: ['BROKE','INCONSISTENT'].includes(derivedVerdict) ? 'PENDING'
//          : (parseInt(String(matchData['Promise Alignment UID'] || matchUid).slice(-2), 36) % 10 === 0 ? 'PENDING' : ''),
//
// BROKE/INCONSISTENT always queue for the post-write judge (WF13). A stable
// 10% of KEPT/CONSISTENT (deterministic on UID, so re-runs pick the same rows)
// also queue, so the KEPT audit accumulates without a separate exercise.
// WF11/WF12 must exclude Grade in {PENDING, REVIEW_REQUIRED} from the Trust
// Index and count them in the denominator as disclosed-pending.
//
// The templatedReasoning() helper should mention the governing vote when split:
//     if (derived.split) return 'The senator voted ' + matchData['Cloture Vote'] +
//       ' on cloture and ' + matchData['Passage Vote'] + ' on passage. Cloture is the ' +
//       'binding 60-vote threshold, so it is treated as the effective position; ' +
//       'both votes are shown. ' + <existing sentence>;

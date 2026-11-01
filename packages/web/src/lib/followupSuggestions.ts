import type { QueryResult } from '@receipts/shared';

// ===========================================================================
// Three tappable first questions for "Ask about this result".
//
// The empty chat box is the moment people leave: they have an answer and no
// idea what they could ask. These are built from THIS result, so each one is
// a question the explain-only follow-up can actually answer from the run's
// own record — why a bill counted or didn't, how sure the answer is — never a
// question that needs a new search (the server would refuse it, which is the
// worst possible first follow-up).
// ===========================================================================

export const MAX_SUGGESTIONS = 3;

/** A bill's short name for a question: its number if we have it, else its id. */
function billName(b: { bill_number?: string; bill_id: string }): string {
  return (b.bill_number ?? b.bill_id).trim();
}

export function suggestFollowups(result: QueryResult): string[] {
  const out: string[] = [];
  const counted = result.scored.evidence.length;
  const gated = result.gated ?? [];
  const nd = result.scored.verdict === 'NOT_DETERMINABLE' && !result.record;
  const recordVotes = result.record ? result.record.counted.for + result.record.counted.against : 0;
  /** A record question that found nothing to count: there are no votes to ask about. */
  const recordEmpty = Boolean(result.record) && recordVotes === 0;

  if (recordEmpty) {
    out.push('Why couldn’t you find a vote on this?');
    if (gated[0]) out.push(`Why didn’t ${billName(gated[0])} count?`);
    out.push('How could I ask this so it can be checked?');
    out.push('What doesn’t this answer cover?');
    return [...new Set(out)].slice(0, MAX_SUGGESTIONS);
  }

  if (nd) {
    out.push('Why couldn’t you give a clear answer?');
  } else if (counted > 1 || recordVotes > 1) {
    out.push('Which vote mattered most for this answer?');
  } else if (counted === 1) {
    out.push('What did that bill actually do?');
  }

  if (gated[0]) out.push(`Why didn’t ${billName(gated[0])} count?`);

  if (!result.record && !nd && result.scored.band) out.push('How sure is this answer, and why?');
  else if (result.record) out.push('Did they ever vote the other way on this?');

  out.push('What doesn’t this answer cover?');

  return [...new Set(out)].slice(0, MAX_SUGGESTIONS);
}

import { SIMILARITY } from '../scoring/config.js';

// ===========================================================================
// Where a bill went, from the run's own trace.
//
// "Not in evidence" covers three different failures, and a reviewer needs to
// know which: the search never returned it, the relevance check dropped it,
// or it was returned and kept but scored below the evidence floor. Read-only:
// this explains a result and changes nothing.
// ===========================================================================

export interface TraceStepLike {
  stage?: string;
  subject?: string | null;
  input?: unknown;
  output?: unknown;
}

interface Candidate { bill_id?: string; score?: number }

const norm = (b: string) => b.trim().toLowerCase();

export function whereIsBill(bill: string, steps: TraceStepLike[]): string {
  const want = norm(bill);
  const retrieve = steps.filter((s) => s.stage === 'RETRIEVE')
    .map((s) => s.output as { candidates?: Candidate[]; returned?: number } | undefined);
  // The trace keeps only the candidates at or above the retrieval floor, so a
  // bill absent from them was either not returned or returned below it.
  const retrieved: Candidate[] = retrieve.flatMap((o) => o?.candidates ?? []);
  const returned = retrieve.reduce((a, o) => a + (o?.returned ?? 0), 0);
  const i = retrieved.findIndex((c) => norm(c.bill_id ?? '') === want);
  if (i < 0) {
    return `not retrieved at or above the retrieval floor ${SIMILARITY.WEAK} (${retrieved.length} of ${returned} returned were)`;
  }
  const score = Number(retrieved[i]!.score);
  const at = `rank ${i + 1} of ${retrieved.length}, score ${score.toFixed(3)}`;

  const rel = steps.find((s) => s.stage === 'RELEVANCE' && norm(String(s.subject ?? '')).includes(`-${want}-`));
  const relVerdict = (rel?.output as { parsed?: { verdict?: string } } | undefined)?.parsed?.verdict;
  if (relVerdict && relVerdict !== 'TRUE_POSITIVE') return `retrieved (${at}); dropped by the relevance check as ${relVerdict}`;
  if (score < SIMILARITY.WEAK) return `retrieved (${at}); below the retrieval floor ${SIMILARITY.WEAK}`;
  if (score < SIMILARITY.STRONG) {
    return `retrieved (${at})${relVerdict ? `, relevance ${relVerdict}` : ''}; below the evidence floor ${SIMILARITY.STRONG}`;
  }
  return `retrieved (${at})${relVerdict ? `, relevance ${relVerdict}` : ''}`;
}

/** How the statement was classified, and whether the orchestrator disagreed. */
export function classificationOf(steps: TraceStepLike[]): string {
  const c = steps.find((s) => s.stage === 'CLASSIFY')?.output as
    | { interpretation?: { primary_issue?: string; sub_issue?: string; stance?: string }; disagreements?: string[] }
    | undefined;
  if (!c?.interpretation) return 'unknown';
  const { primary_issue, sub_issue, stance } = c.interpretation;
  const dis = c.disagreements?.length ? ` (orchestrator disagreed: ${c.disagreements.join('; ')})` : '';
  return `${primary_issue ?? '?'} / ${sub_issue ?? '?'} · ${stance ?? '?'}${dis}`;
}

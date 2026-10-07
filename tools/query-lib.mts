// Shared by tools/run-queries.mts and tools/stability.mts: the measured query
// list, the decisions a change must not move, and what a run's trace says about
// its retrieval.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { QueryResult } from '@receipts/shared';

export interface Query { id: string; senator: string; promise: string }

/** The four promises from the caching measurement (#35), then two more. */
export const QUERIES: Query[] = [
  { id: 'schumer-clean-air', senator: 'S000148', promise: 'promised to protect clean air standards from rollback' },
  {
    id: 'schumer-gun-safety',
    senator: 'S000148',
    promise:
      'There is no single solution that will end gun violence overnight, but by establishing smart gun safety measures like universal background checks, closing the gun show loophole, and red flag laws, we can keep guns out of the hands of people who could hurt themselves or others.',
  },
  { id: 'thune-troop-pay', senator: 'T000250', promise: 'promised to make sure our troops get a pay raise and the military is fully funded' },
  { id: 'schumer-drug-prices', senator: 'S000148', promise: 'promised to lower prescription drug prices' },
  { id: 'thune-death-tax', senator: 'T000250', promise: 'promised to repeal the death tax' },
  { id: 'schumer-clean-energy', senator: 'S000148', promise: 'promised to invest in clean energy and fight climate change' },
];

/** The decisions a change must not move. */
export function decisionsOf(result: QueryResult | null) {
  if (!result) return null;
  const s = result.scored;
  return {
    interpretation: {
      primary_issue: result.interpretation.primary_issue,
      sub_issue: result.interpretation.sub_issue,
      stance: result.interpretation.stance,
      statement_type: result.interpretation.statement_type,
    },
    verdict: s.verdict,
    band: s.band,
    mode: s.mode,
    nd_reason: s.nd_reason,
    evidence: s.evidence
      .map((e) => ({
        action_uid: e.action_uid,
        bill_effect: e.bill_effect,
        outcome: e.outcome,
        direction: e.direction,
        record: e.record ?? null,
        text_version: e.text_version ? `${e.text_version.status}:${e.text_version.code ?? '-'}` : null,
      }))
      .sort((a, b) => a.action_uid.localeCompare(b.action_uid)),
    gated: (result.gated ?? [])
      .map((g) => ({ action_uid: g.action_uid, gate: g.gate }))
      .sort((a, b) => a.action_uid.localeCompare(b.action_uid)),
    judge: result.judge?.disposition ?? null,
    enrichment_gaps: result.enrichment_gaps ?? [],
  };
}

const TRACES = fileURLToPath(new URL('../.data/traces/', import.meta.url));

/** Every step of a run, from its local trace file. */
export async function traceSteps(runId: string): Promise<Array<Record<string, any>>> {
  const file = (await readdir(TRACES)).find((f) => f.includes(runId));
  if (!file) throw new Error(`no local trace for ${runId}`);
  return (await readFile(`${TRACES}${file}`, 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.type === 'step');
}

/** What the trace says the run embedded, retrieved, admitted, and classified. */
export async function retrievalFacts(runId: string) {
  const steps = await traceSteps(runId);
  const embed = steps.find((s) => s.stage === 'EMBED');
  const retrieve = steps.find((s) => s.stage === 'RETRIEVE');
  const gate = steps.find((s) => s.stage === 'EVIDENCE_GATE');
  const classify = steps.find((s) => s.stage === 'CLASSIFY_MODEL');
  const classifierInput =
    classify?.output?.content?.find((b: any) => b.type === 'tool_use' && b.name === 'interpret_promise')?.input ?? null;
  return {
    embedded_text: (embed?.output?.embedded_text as string | undefined) ?? null,
    top10: ((retrieve?.output?.candidates ?? []) as Array<{ bill_id: string }>).map((c) => c.bill_id),
    admitted: ((gate?.output?.admitted ?? []) as string[]).slice().sort(),
    classifier_input: classifierInput as Record<string, unknown> | null,
  };
}

import { afterAll, describe, expect, it } from 'vitest';
import {
  ENRICHMENT_GAP_PHRASE,
  enrichmentGapSentence,
  type EnrichmentGap,
  type StreamEvent,
} from '@receipts/shared';
import {
  ENRICHMENT_GAP_OF,
  MirrorEnrichmentSource,
  nullEnrichmentSource,
  type EnrichmentPart,
} from './enrichment.js';
import { isCacheable } from '../data/ResultCache.js';

// ===========================================================================
// AN ENRICHMENT READ THAT FAILS IS VISIBLE, NOT ONLY LOGGED.
//
// Live run 5f719ce1 (2026-10-04): the Supabase pooler timed out on the cloture
// results and bill progress reads. Both fail OPEN by design — a timing gate
// with no vote date does not fire — but the failure went only to the server
// log. The trace said "ok · 0 bill(s) with progress", indistinguishable from a
// bill with no progress row, and the explainer was told vote dates and roles
// were available.
//
// Now each read reports its failure to the run that suffered it; the run
// traces it, puts it on the result, tells the explainer, and is not cached.
// The reader here is the REAL MirrorEnrichmentSource pointed at a port that
// refuses connections, so every read fails through its actual catch block.
// ===========================================================================

// Port 1 refuses at once; no test waits on a timeout.
const dead = new MirrorEnrichmentSource('postgresql://nobody:nothing@127.0.0.1:1/none');
afterAll(() => dead.close());

function collector() {
  const failed: Array<{ part: EnrichmentPart; message: string }> = [];
  return { failed, report: (part: EnrichmentPart, message: string) => failed.push({ part, message }) };
}

describe('every read reports its own failure', () => {
  it('refs: roles and cloture results', async () => {
    const { failed, report } = collector();
    const refs = await dead.refs(report);
    expect(failed.map((f) => f.part).sort()).toEqual(['cloture_results', 'roles']);
    // Still fails OPEN: the hardcoded leader table stands in.
    expect(refs.roleAt('T000250', '119')).toBe('MAJORITY_LEADER');
  });

  it('per-action rows', async () => {
    const { failed, report } = collector();
    expect((await dead.forActions(['ACT-1'], report)).size).toBe(0);
    expect(failed.map((f) => f.part)).toEqual(['actions']);
    expect(failed[0]!.message).toBeTruthy();
  });

  it('bill progress', async () => {
    const { failed, report } = collector();
    expect((await dead.forBills(['s1-119'], report)).size).toBe(0);
    expect(failed.map((f) => f.part)).toEqual(['bill_progress']);
  });

  it('text versions', async () => {
    const { failed, report } = collector();
    expect((await dead.forVersions(['s1-119'], report)).size).toBe(0);
    expect(failed.map((f) => f.part)).toEqual(['text_versions']);
  });

  // The reader is one shared instance; a failure must reach only the run that
  // passed the callback, never the next caller.
  it('reports to the caller only, and still works with no callback', async () => {
    const a = collector();
    await dead.forBills(['s1-119'], a.report);
    await expect(dead.forBills(['s1-119'])).resolves.toBeInstanceOf(Map);
    expect(a.failed).toHaveLength(1);
  });

  // Nothing to read is not a failed read.
  it('an empty request reports nothing', async () => {
    const { failed, report } = collector();
    await dead.forActions([], report);
    await dead.forBills([], report);
    await dead.forVersions([], report);
    expect(failed).toEqual([]);
  });

  it('the null source has nothing to fail', async () => {
    const { failed, report } = collector();
    await nullEnrichmentSource.refs(report);
    await nullEnrichmentSource.forActions(['ACT-1'], report);
    expect(failed).toEqual([]);
  });
});

describe('what the reader is told', () => {
  it('every read maps to a part of the record a reader recognises', () => {
    const parts: EnrichmentPart[] = ['roles', 'cloture_results', 'actions', 'whip_votes', 'cloture_questions', 'bill_progress', 'text_versions'];
    for (const p of parts) expect(ENRICHMENT_GAP_PHRASE[ENRICHMENT_GAP_OF[p]]).toBeTruthy();
  });

  it('says which part, that the checks ran without it, and to try again', () => {
    expect(enrichmentGapSentence(['vote_records', 'bill_progress'])).toBe(
      "Part of the record we check against couldn't be read for this answer: the dates of the senator's votes and sponsorships; and how far each bill got. " +
        'The checks that depend on it ran without it, so treat this result with extra caution — trying again may complete it.',
    );
  });

  it('says nothing when every read succeeded', () => {
    expect(enrichmentGapSentence([])).toBeNull();
    expect(enrichmentGapSentence(undefined)).toBeNull();
  });

  it('lists a part once however many of its reads failed', () => {
    const s = enrichmentGapSentence(['roll_call_context', 'roll_call_context'] as EnrichmentGap[])!;
    expect(s.match(/roll-call results/g)).toHaveLength(1);
  });

  it('claims nothing about the senator', () => {
    const s = enrichmentGapSentence(['vote_records', 'roll_call_context', 'bill_progress', 'text_versions'])!;
    expect(s).not.toMatch(/\bkept\b|\bbroke\b|\b(he|she|his|her)\b/i);
  });
});

describe('the session cache', () => {
  const result = (gaps?: EnrichmentGap[]) =>
    ({ type: 'result', result: { scored: { verdict: 'KEPT', nd_reason: null }, enrichment_gaps: gaps } }) as unknown as StreamEvent;

  // The note says trying again may complete the check. Cached, it couldn't.
  it('does not keep a result reached with reads missing', () => {
    expect(isCacheable([result(['vote_records'])])).toBe(false);
  });

  it('keeps a clean result', () => {
    expect(isCacheable([result([])])).toBe(true);
    expect(isCacheable([result()])).toBe(true);
  });
});

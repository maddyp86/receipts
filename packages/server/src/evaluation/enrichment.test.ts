import { describe, expect, it } from 'vitest';
import { nullEnrichmentSource } from './enrichment.js';
import { preEvaluatorGates, type GateRow } from './preEvaluatorGates.js';

// ===========================================================================
// The enrichment seam.
//
// MirrorEnrichmentSource needs a live database, so what is pinned here is the
// CONTRACT: what the gates do when enrichment is present versus absent. The
// absent case is the one that matters — it is what shipped for weeks, and it
// has to degrade rather than mislead.
// ===========================================================================

const leaderNay: GateRow = {
  politician_id: 'T000250',
  bill_id: 'hr1-119',
  promise_text: 'I will bring this bill to the floor.',
  bill_title: 'A bill',
  cloture_vote: 'NAY',
};

describe('nullEnrichmentSource — degrades, never misleads', () => {
  it('supplies no per-action enrichment', async () => {
    expect((await nullEnrichmentSource.forActions(['ACT-1'])).size).toBe(0);
  });

  it('reports that the roll-call source has no results, rather than implying agreement', async () => {
    const refs = await nullEnrichmentSource.refs();
    expect(refs.rollCallHasResult).toBe(false);
    expect(refs.clotureResult('s1-119')).toBe('');
  });

  // fix/03's own fallback, not an absence of data — so the two MVP senators
  // still resolve even with nothing synced.
  it('still resolves the floor leaders from the hardcoded table', async () => {
    const refs = await nullEnrichmentSource.refs();
    expect(refs.roleAt('T000250', '119')).toBe('MAJORITY_LEADER');
    expect(refs.roleAt('S000148', '118')).toBe('MAJORITY_LEADER');
    expect(refs.roleAt('X000001', '119')).toBe('NONE');
  });

  // THE POINT OF THE WHOLE FILE. Without a whip vote G3 cannot fire, so a
  // leader's Rule XIII manoeuvre reads as ordinary opposition.
  it('leaves G3 unable to fire, because the whip vote has no source', async () => {
    const refs = await nullEnrichmentSource.refs();
    const r = preEvaluatorGates(leaderNay, { scope: 'STANDING' }, refs);
    expect(r.scorable).toBe(true);
    expect(r.hits).toHaveLength(0);
  });
});

describe('with enrichment present, the same row gates', () => {
  it('fires G3 once a whip vote and role are available', async () => {
    const refs = await nullEnrichmentSource.refs();
    const enriched: GateRow = { ...leaderNay, party_whip_vote: 'YEA', cloture_vote_id: 's1-119' };
    const r = preEvaluatorGates(enriched, { scope: 'STANDING' }, refs);
    expect(r.scorable).toBe(false);
    expect(r.hit?.verdict).toBe('PROCEDURAL_SWITCH');
  });

  // The difference between the two cases above is one field. That is the whole
  // argument for the mirror: the gate was correct all along and had no inputs.
  it('fires G1a once a vote date replaces the Congress-start proxy', async () => {
    const refs = await nullEnrichmentSource.refs();
    const meta = { scope: 'BOUNDED', validUntil: new Date('2025-06-01') };

    const withoutDate = preEvaluatorGates(leaderNay, meta, refs);
    expect(withoutDate.context.vote_flags).toContain('ACTION_DATE_PROXY');

    const withDate = preEvaluatorGates(
      { ...leaderNay, passage_vote_date: '2025-09-01' },
      meta,
      refs,
    );
    expect(withDate.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
    expect(withDate.context.vote_flags).not.toContain('ACTION_DATE_PROXY');
  });
});

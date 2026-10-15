import { describe, expect, it } from 'vitest';
import type { Interpretation, MatchedAction, NoteEvent } from '@receipts/shared';
import { dispatchTool, newSession } from './dispatch.js';
import { fixtureEnvelope } from '../evaluation/responsesFetcher.js';
import { billName, gatedNote, readDoneNote, relevanceDoneNote } from './narrate.js';

// ===========================================================================
// Narration: the lines the reader watches while the answer is worked out.
// Built from what the pipeline decided, never from a model's reasoning, and
// never a verdict — the verdict comes after every bill is read, and a second
// read can still hold it back.
// ===========================================================================

const VERDICT_WORDS = /\b(kept|broke|broken|keeps|breaks|consistent|inconsistent|promise)\b/i;

describe('the copy', () => {
  it('cites the bill and shortens a long title', () => {
    expect(billName('s1071-119', 'A bill to do one thing')).toBe('S. 1071 — A bill to do one thing');
    expect(billName('hjres45-118', 'x'.repeat(200)).length).toBeLessThan(90);
    expect(billName('weird-id', '')).toBe('weird-id');
  });

  it('a bill read is said as which way the bill pushes, never as a verdict', () => {
    for (const effect of ['ADVANCE', 'HINDER', 'NEUTRAL', 'CONTESTED', 'ERROR', 'SOMETHING_NEW']) {
      const n = readDoneNote('A1', 's1-119', effect);
      expect(n.text.startsWith('S. 1:')).toBe(true);
      expect(n.text).not.toMatch(VERDICT_WORDS);
      expect(n.status).not.toBe('running');
    }
  });

  it('says kept or set aside only once the evidence gate has decided', () => {
    expect(relevanceDoneNote('A1', 's1-119', 'PARTIAL').status).toBe('running');
    expect(relevanceDoneNote('A1', 's1-119', 'PARTIAL').text).not.toMatch(/kept|set aside/);
    expect(relevanceDoneNote('A1', 's1-119', 'PARTIAL', false)).toMatchObject({ status: 'skipped', text: 'S. 1: partly about this — set aside' });
    expect(relevanceDoneNote('A1', 's1-119', 'TRUE_POSITIVE', true)).toMatchObject({ status: 'done', text: 'S. 1: about this — kept' });
  });

  it('a gated row carries the first sentence of its reason', () => {
    const n = gatedNote('A1', 'hr2-118', 'We read this as a pledge. It can’t be checked. More.');
    expect(n.text).toBe('H.R. 2: not counted. We read this as a pledge.');
  });
});

// ---------------------------------------------------------------------------

const interpretation = {
  raw: 'supports lowering drug prices', statement_type: 'Policy Position', provenance: 'default',
  restated: 'x', primary_issue: 'Health', sub_issue: 'Drug Pricing', stance: 'In Favor',
  promise_type: 'policy', key_policy_terms: [], is_evaluable: true,
} as unknown as Interpretation;

const match = (bill: string): MatchedAction =>
  ({
    action_uid: `ACT-${bill}`, bill_id: bill, title: `Bill ${bill}`, summary: 's', intended_effects: 'e',
    mechanisms: 'm', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea', cloture_vote: 'NA',
    passage_vote: 'Yea', bill_keywords: [], primary_issue: 'Health', sub_issue: 'Drug Pricing',
    source_url: 'https://www.congress.gov/x', score: 0.6, strength: 'STRONG', missing_fields: [],
  }) as MatchedAction;

const billOf = (body: { input: Array<{ role: string; content: unknown }> }) =>
  /Bill ID:\s*\**\s*(\S+?)[\s*(]/.exec(String(body.input.find((m) => m.role === 'user')?.content ?? ''))?.[1] ?? '?';

describe('reading the bills', () => {
  it('says each bill as it is read, then which way it pushes, one line per bill', async () => {
    const session = newSession('S000148', interpretation.raw);
    session.interpretation = interpretation;
    session.scope = { scope: 'STANDING' } as never;
    session.matches = [match('s10-119'), match('hr20-119')];
    session.evaluated = [];
    session.fulfillmentFetcher = async (body) =>
      fixtureEnvelope({ bill_effect: billOf(body) === 's10-119' ? 'ADVANCE' : 'NEUTRAL', alignment: 'NA', confidence: 0.9, same_object: true });
    const notes: Array<Omit<NoteEvent, 'type'>> = [];
    session.narrate = (n) => notes.push(n);

    await dispatchTool(session, 'evaluate_effects', {});

    const reads = notes.filter((n) => n.group === 'read');
    expect(reads.filter((n) => n.status === 'running').map((n) => n.key).sort()).toEqual(['read:ACT-hr20-119', 'read:ACT-s10-119']);
    const final = new Map(reads.map((n) => [n.key, n]));
    expect(final.get('read:ACT-s10-119')!.text).toBe('S. 10: the bill pushes toward this');
    expect(final.get('read:ACT-hr20-119')!.text).toBe('H.R. 20: doesn’t move this either way');
    // Every line is said under the step the reader sees working.
    expect(notes.every((n) => n.step === 'score')).toBe(true);
  });

  it('nothing is said when nobody is listening', async () => {
    const session = newSession('S000148', interpretation.raw);
    session.interpretation = interpretation;
    session.matches = [];
    await expect(dispatchTool(session, 'evaluate_effects', {})).resolves.toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from 'vitest';
import type { ScoredResult, Senator, StreamEvent } from '@receipts/shared';
import type { EvaluatedCandidate } from '../evaluation/relevance.js';
import { actionPhrase, billUrl, buildNotCounted, readerReason } from './notCounted.js';
import { finish } from './loop.js';
import { newSession, type QuerySession } from './dispatch.js';

// ===========================================================================
// The bills the relevance check read and did not count reach the reader, each
// with its reason. Before this, Schumer's background-checks answer showed two
// bills and said only that eight others "were read as being about a different
// subject" — the safe-storage and assault-weapons bills beside them were
// invisible.
// ===========================================================================

const cand = (over: Partial<EvaluatedCandidate> & { verdict?: string; topic?: string; reasoning?: string }): EvaluatedCandidate =>
  ({
    action_uid: over.action_uid ?? 'ACT-S-s1-118-S000148',
    bill_id: over.bill_id ?? 's1-118',
    bill_title: over.bill_title ?? 'A bill',
    is_sponsor: over.is_sponsor ?? 'FALSE',
    is_cosponsor: over.is_cosponsor ?? 'TRUE',
    vote: over.vote ?? 'NA',
    passage_vote: over.passage_vote,
    cloture_vote: over.cloture_vote,
    similarity_score: over.similarity_score ?? 0.6,
    relevance: {
      verdict: over.verdict ?? 'FALSE_POSITIVE',
      topic_relevant: over.topic ?? 'No',
      reasoning: over.reasoning ?? 'This is a sponsorship action, but the bill is about something else.',
      evaluation_status: 'LLM_EVALUATED',
    },
  }) as unknown as EvaluatedCandidate;

describe('readerReason', () => {
  // Real reasoning from the 11 October background-checks run.
  it('drops "This is a sponsorship action, but" and keeps the substance', () => {
    expect(
      readerReason(
        'This is a sponsorship action, but the bill is about assault weapons bans and large-capacity magazines, not universal background checks.',
      ),
    ).toBe('The bill is about assault weapons bans and large-capacity magazines, not universal background checks.');
  });

  it('drops a whole opening sentence that only names the evaluation path', () => {
    expect(
      readerReason(
        'This is a sponsorship-path case because the senator co-sponsored the bill and no vote is available. The promise is about expanding background checks, while the bill is a CDC research authorization.',
      ),
    ).toBe('The promise is about expanding background checks, while the bill is a CDC research authorization.');
  });

  it('drops "This uses the Sponsorship Path…" the same way', () => {
    expect(
      readerReason(
        'This uses the Sponsorship Path, since the senator is a co-sponsor and has no vote on the bill. The promise is about background checks; the bill is about safe storage.',
      ),
    ).toBe('The promise is about background checks; the bill is about safe storage.');
  });

  it('handles a vote', () => {
    expect(readerReason('This is a vote, but the bill concerns extending the health care premium tax credit.')).toBe(
      'The bill concerns extending the health care premium tax credit.',
    );
  });

  it('leaves reasoning that does not open with bookkeeping alone', () => {
    const s = 'The senator’s co-sponsorship is a real legislative action, but the bill is about firearm liability.';
    expect(readerReason(s)).toBe(s);
  });

  it('never returns the bookkeeping sentence on its own as empty', () => {
    expect(readerReason('This is a sponsorship action.')).toBe('This is a sponsorship action.');
  });
});

describe('actionPhrase', () => {
  it('names sponsorship', () => {
    expect(actionPhrase(cand({ is_sponsor: 'TRUE', is_cosponsor: 'FALSE' }))).toBe('Sponsored');
    expect(actionPhrase(cand({}))).toBe('Cosponsored');
  });

  it('names a passage vote', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', passage_vote: 'Nay' }))).toBe('Voted Nay on passage');
  });

  // Run 3bf66a32: s3386-119, s4381-118 and hr7024-118 had only a cloture vote,
  // passage_vote NA, and were labelled "Voted YEA on passage" from `vote`.
  it('names a cloture-only vote as cloture, not passage, even when `vote` is set', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', cloture_vote: 'YEA', passage_vote: 'NA', vote: 'YEA' }))).toBe(
      'Voted Yea on cloture (no passage vote)',
    );
  });

  it('names cloture and passage separately when both happened', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', cloture_vote: 'Yea', passage_vote: 'Nay', vote: 'Nay' }))).toBe(
      'Voted Yea on cloture and Nay on passage',
    );
  });

  it('keeps a sponsor’s votes beside the sponsorship', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'TRUE', cloture_vote: 'Yea', passage_vote: 'NA' }))).toBe(
      'Cosponsored; voted Yea on cloture (no passage vote)',
    );
  });

  it('falls back to the resolved vote only when neither slot is filled', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', vote: 'YEA' }))).toBe('Voted Yea');
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', vote: 'NOT VOTING' }))).toBe('Did not vote');
  });

  it('says "did not vote" for an absence rather than "voted Not Voting"', () => {
    expect(actionPhrase(cand({ is_cosponsor: 'FALSE', cloture_vote: 'Not Voting', passage_vote: 'NA' }))).toBe(
      'Did not vote on cloture (no passage vote)',
    );
  });
});

describe('billUrl', () => {
  it('links the bill on congress.gov', () => {
    expect(billUrl('s1026-118')).toBe('https://www.congress.gov/bill/118th-congress/senate-bill/1026');
    expect(billUrl('sres351-118')).toBe('https://www.congress.gov/bill/118th-congress/senate-resolution/351');
    expect(billUrl('nonsense')).toBe('');
  });
});

describe('buildNotCounted', () => {
  const none = { bill_ids: new Set<string>(), action_uids: new Set<string>() };

  it('splits related from unrelated, related first, each by similarity', () => {
    const rows = buildNotCounted(
      [
        cand({ action_uid: 'u1', bill_id: 's25-118', similarity_score: 0.62 }),
        cand({ action_uid: 'r1', bill_id: 's173-118', verdict: 'PARTIAL', topic: 'Yes', similarity_score: 0.55 }),
        cand({ action_uid: 'r2', bill_id: 's1531-119', verdict: 'PARTIAL', topic: 'Yes', similarity_score: 0.6 }),
      ],
      new Set(),
      none,
    );
    expect(rows.map((r) => [r.bill_id, r.tier])).toEqual([
      ['s1531-119', 'related'],
      ['s173-118', 'related'],
      ['s25-118', 'unrelated'],
    ]);
  });

  it('leaves out what was admitted, gated, or counted through another action on the same bill', () => {
    const rows = buildNotCounted(
      [
        cand({ action_uid: 'admitted', bill_id: 's494-118' }),
        cand({ action_uid: 'vote-on-admitted-bill', bill_id: 's3214-119' }),
        cand({ action_uid: 'gated', bill_id: 's9-118' }),
        cand({ action_uid: 'kept', bill_id: 's726-119' }),
        cand({ action_uid: 'kept', bill_id: 's726-119' }),
      ],
      new Set(['admitted']),
      { bill_ids: new Set(['s494-118', 's3214-119']), action_uids: new Set(['gated']) },
    );
    expect(rows.map((r) => r.action_uid)).toEqual(['kept']);
  });

  it('says plainly when the check could not read a bill, and counts it as related', () => {
    const c = cand({ action_uid: 'err' });
    (c.relevance as unknown as Record<string, unknown>).evaluation_status = 'ERROR';
    const row = buildNotCounted([c], new Set(), none)[0]!;
    expect(row.tier).toBe('related');
    expect(row.reason).toMatch(/could not read this bill/);
  });
});

describe('the not-counted bills reach the browser', () => {
  const senator: Senator = { politician_id: 'S000148', name: 'Chuck Schumer', cached: true };
  const scored = { verdict: 'KEPT', band: 'Medium', receipt: { trace: [] }, evidence: [] } as unknown as ScoredResult;

  const run = (over: Partial<QuerySession>) => {
    const session: QuerySession = {
      ...newSession('S000148', 'supports expanding background checks'),
      senator,
      interpretation: { raw: 'x' } as QuerySession['interpretation'],
      scored,
      ...over,
    };
    const emitted: StreamEvent[] = [];
    finish(session, (e) => emitted.push(e));
    const event = emitted.find((e) => e.type === 'result');
    if (!event || event.type !== 'result') throw new Error('no result');
    return event.result;
  };

  it('is attached when the relevance check ran', () => {
    const result = run({
      matches: [{ action_uid: 'a', bill_id: 's494-118' }] as never,
      evaluated: [
        cand({ action_uid: 'a', bill_id: 's494-118', verdict: 'TRUE_POSITIVE', topic: 'Yes' }),
        cand({ action_uid: 'b', bill_id: 's173-118', verdict: 'PARTIAL', topic: 'Yes' }),
        cand({ action_uid: 'c', bill_id: 's25-118' }),
      ],
      relevance: {
        admitted: [{ action_uid: 'a' }],
        dropped: { 'PARTIAL/DIRECTIONAL': 1, FALSE_POSITIVE: 1 },
        tiers: { TRUE_POSITIVE: 1 },
        admittedBeforeDedupe: 1,
        candidatesIn: 3,
      } as never,
    });
    expect(result.not_counted?.map((r) => [r.bill_id, r.tier])).toEqual([
      ['s173-118', 'related'],
      ['s25-118', 'unrelated'],
    ]);
  });

  it('is absent, not empty, when the check never ran', () => {
    const result = run({ matches: [{ action_uid: 'a', bill_id: 's494-118' }] as never });
    expect(result.not_counted).toBeUndefined();
  });
});

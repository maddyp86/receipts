import { describe, expect, it } from 'vitest';
import type { QueryResult } from '@receipts/shared';
import { MAX_SUGGESTIONS, suggestFollowups } from './followupSuggestions.js';

// Only the fields the helper reads; the rest of a result is irrelevant here.
function result(over: {
  verdict?: 'KEPT' | 'BROKE' | 'NOT_DETERMINABLE';
  band?: 'High' | 'Medium' | 'Low' | null;
  evidence?: number;
  gated?: Array<{ bill_id: string; bill_number?: string }>;
  record?: { for: number; against: number };
}): QueryResult {
  return {
    scored: {
      verdict: over.verdict ?? 'KEPT',
      band: over.band === undefined ? 'Medium' : over.band,
      evidence: Array.from({ length: over.evidence ?? 2 }, (_, i) => ({ action_uid: `a${i}` })),
      nd_reason: over.verdict === 'NOT_DETERMINABLE' ? 'NO_MATCHES' : null,
    },
    gated: over.gated?.map((g, i) => ({ action_uid: `g${i}`, title: 't', gate: 'G', reason: 'r', ...g })),
    record: over.record ? { label: 'VOTED_FOR', reason: 'VOTES', rows: [], counted: over.record, set_aside: 0 } : undefined,
  } as unknown as QueryResult;
}

describe('suggested follow-ups', () => {
  it('never offers more than three, and never repeats one', () => {
    for (const r of [result({}), result({ gated: [{ bill_id: 'hr1-119', bill_number: 'H.R. 1' }] }), result({ verdict: 'NOT_DETERMINABLE', band: null, evidence: 0 })]) {
      const s = suggestFollowups(r);
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      expect(new Set(s).size).toBe(s.length);
    }
  });

  it('names the first bill that was set aside, by its number', () => {
    const s = suggestFollowups(result({ gated: [{ bill_id: 'hr1-119', bill_number: 'H.R. 1' }] }));
    expect(s).toContain('Why didn’t H.R. 1 count?');
  });

  it('asks why there is no clear answer when there is none, and not how sure it is', () => {
    const s = suggestFollowups(result({ verdict: 'NOT_DETERMINABLE', band: null, evidence: 0 }));
    expect(s[0]).toBe('Why couldn’t you give a clear answer?');
    expect(s.join(' ')).not.toMatch(/how sure/i);
  });

  it('on a record question, asks about the votes rather than a confidence the page does not show', () => {
    const s = suggestFollowups(result({ record: { for: 3, against: 0 }, evidence: 0 }));
    expect(s).toContain('Which vote mattered most for this answer?');
    expect(s.join(' ')).not.toMatch(/how sure/i);
  });

  it('on a record question that found nothing, never asks about votes it does not have', () => {
    const s = suggestFollowups(result({ record: { for: 0, against: 0 }, evidence: 0 }));
    expect(s[0]).toBe('Why couldn’t you find a vote on this?');
    expect(s.join(' ')).not.toMatch(/other way|mattered most/);
  });
});

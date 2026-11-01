import { describe, expect, it } from 'vitest';
import { cleanProps, followupRow, validateClientEvent } from './FunnelStore.js';

const SESSION = '3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f';
const RUN = 'd98db78f-1111-4222-8333-444455556666';

describe('funnel events', () => {
  it('drops any property not in the closed shape — question text cannot get through', () => {
    const p = cleanProps({
      politician_id: 'T000250',
      source: 'starter',
      nth: 2,
      outcome: 'VOTED_FOR',
      run_id: RUN,
      promise_text: 'Did they vote for the Laken Riley Act?',
      question: 'anything',
    });
    // run_id is dropped too: it would join a count to the stored question.
    expect(p).toEqual({ politician_id: 'T000250', source: 'starter', nth: 2, outcome: 'VOTED_FOR' });
  });

  it('drops allowed keys whose values are the wrong shape', () => {
    expect(
      cleanProps({ politician_id: 'Thune', source: 'ad', nth: 1.5, outcome: 'voted for it, sort of', run_id: 'x' }),
    ).toEqual({});
  });

  it('accepts the page’s four events and refuses followup_asked from outside', () => {
    for (const event of ['landing_view', 'starter_used', 'query_submitted', 'result_shown']) {
      expect(validateClientEvent({ session: SESSION, event }).ok).toBe(true);
    }
    expect(validateClientEvent({ session: SESSION, event: 'followup_asked' }).ok).toBe(false);
    expect(validateClientEvent({ session: SESSION, event: 'purchase' }).ok).toBe(false);
  });

  it('needs a real session id', () => {
    expect(validateClientEvent({ session: '', event: 'landing_view' }).ok).toBe(false);
    expect(validateClientEvent({ session: 'abc', event: 'landing_view' }).ok).toBe(false);
    expect(followupRow(undefined)).toBeNull();
    expect(followupRow(SESSION)).toEqual({ session_key: SESSION, event: 'followup_asked', props: {} });
  });
});

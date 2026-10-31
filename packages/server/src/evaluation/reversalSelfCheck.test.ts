import { describe, expect, it } from 'vitest';
import { buildFulfillmentUserMessage, reversalSelfCheck, type FulfillmentCandidate } from './fulfillment.js';

// ===========================================================================
// s2556-119 (Ossoff, trace 9b534012, 31 Oct). The bill repeals the OBBBA
// health subtitle; its own intended effects remove the 400% cap on premium
// tax credits. Its Target Effect gave that same change to the target, so
// "repeal an expansion" read as a cut and a co-sponsorship of an expansion
// counted against extending the credits. One reversal row in about seven had
// the bill's own effect in the target field (migration 023). The evaluator
// is now told to check for it, and to send it to NEUTRAL when it finds it.
// ===========================================================================

const base = {
  promise_uid: 'QUERY',
  promise_text: 'Extend the ACA tax credits.',
  statement_type: 'Policy Position',
  bill_id: 's2556-119',
  bill_title: 'A bill to repeal the changes made by the health subtitle of the One Big Beautiful Bill Act, and for other purposes.',
  bill_intended_effects: 'Permanently removes the 400% income cap for premium tax credit eligibility.',
} as unknown as FulfillmentCandidate;

const reversal = {
  ...base,
  reverses_existing_policy: 'true',
  target_name: 'health subtitle of the One Big Beautiful Bill Act',
  target_effect: 'Expanded eligibility for health insurance premium tax credits by removing the 400% income cap.',
} as FulfillmentCandidate;

describe('the reversal self-check', () => {
  it('is in the message for a reversal with a target effect, and names the conflict', () => {
    const msg = buildFulfillmentUserMessage(reversal);
    expect(msg).toContain('Check before using Target Effect');
    expect(msg).toContain('IMPACT_CONFLICT');
    // It sits with the target fields, before the closing instruction.
    expect(msg.indexOf('Check before using Target Effect')).toBeGreaterThan(msg.indexOf('- Target Effect:'));
    expect(msg.trimEnd().endsWith('Return the JSON specified in the system message.')).toBe(true);
  });

  it('is absent when the bill is not a reversal, or the target effect is empty', () => {
    expect(reversalSelfCheck(base)).toBe('');
    expect(reversalSelfCheck({ ...reversal, reverses_existing_policy: 'false' })).toBe('');
    expect(reversalSelfCheck({ ...reversal, target_effect: 'N/A' })).toBe('');
    expect(reversalSelfCheck({ ...reversal, target_effect: undefined })).toBe('');
    expect(buildFulfillmentUserMessage(base)).not.toContain('Check before using Target Effect');
  });
});

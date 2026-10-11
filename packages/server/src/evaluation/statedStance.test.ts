import { describe, expect, it } from 'vitest';
import type { MatchedAction } from '@receipts/shared';
import { dispatchTool, newSession, toFulfillmentCandidate } from '../orchestrator/dispatch.js';
import { buildFulfillmentUserMessage } from './fulfillment.js';
import { CLASSIFY_SYSTEM_PROMPT } from './classify.js';
import { statedStance } from './statedStance.js';

// ===========================================================================
// The stance double negative (2026-10-10, eval case 40, run fb5fcdba).
//
// "supports ending tariffs on imported goods" was labelled Opposed — to
// tariffs. The bill reader saw the statement and the label together, read
// "opposed to ending tariffs", and called a resolution ending the tariff
// emergency HINDER. The statement's own opening word now sets the label.
// ===========================================================================

describe('statedStance', () => {
  it.each([
    ['supports ending tariffs on imported goods', 'In Favor'],
    ['supports overturning California\'s electric vehicle rules', 'In Favor'],
    ['supports restricting abortion', 'In Favor'],
    ['promised to protect clean air standards from rollback', 'In Favor'],
    ['He voted for the Laken Riley Act', 'In Favor'],
    ['backs expanding VA health care', 'In Favor'],
    ['opposes federal funding for abortion', 'Opposed'],
    ['opposes ending the filibuster', 'Opposed'],
    ['She is against new tariffs', 'Opposed'],
    ['voted against the debt limit increase', 'Opposed'],
  ] as const)('%s → %s', (text, stance) => {
    expect(statedStance(text)).toBe(stance);
  });

  it.each([
    'end tariffs on imported goods',
    'protect clean air standards',
    'never supported raising the minimum wage',
    'does not support ending tariffs',
    'supportive families are good',
    'supports',
  ])('%s → none: the opening does not settle it', (text) => {
    expect(statedStance(text)).toBeNull();
  });
});

describe('the interpretation takes its stance from the statement', () => {
  const classifier = {
    primary_issue: 'Budget & Economy', sub_issue: 'Trade / Free Trade', stance: 'Opposed', promise_type: 'policy',
    restated: 'Opposes tariffs on imported goods.', key_policy_terms: ['tariffs'], reasoning: 'r', is_evaluable: true,
  };
  const interpret = async (text: string, classified: Record<string, unknown>, corrections?: Record<string, unknown>) => {
    const session = newSession('S000148', text, corrections as never);
    session.classifyFetcher = async () => structuredClone(classified);
    const env = await dispatchTool(session, 'interpret_promise', { ...classified, stance: 'In Favor' });
    expect(env.ok).toBe(true);
    return session;
  };

  it('"supports ending tariffs" is In Favor, and the paraphrase in the other frame is replaced', async () => {
    const s = await interpret('supports ending tariffs on imported goods', classifier);
    expect(s.interpretation!.stance).toBe('In Favor');
    expect(s.interpretation!.restated).toBe('Supports ending tariffs on imported goods.');
    expect(s.classifyDisagreements).toContain(
      'stance: the statement\'s own words say "In Favor", the classifier said "Opposed" (the statement\'s words win)',
    );
    expect(s.embeddingText).toContain('Stance: In Favor');
  });

  it('a matching label keeps the classifier\'s paraphrase, and logs nothing', async () => {
    const s = await interpret('supports ending tariffs on imported goods', {
      ...classifier, stance: 'In Favor', restated: 'End tariffs on imported goods.',
    });
    expect(s.interpretation!.stance).toBe('In Favor');
    expect(s.interpretation!.restated).toBe('End tariffs on imported goods.');
    expect(s.classifyDisagreements).toEqual([]);
  });

  it('a matching label with a paraphrase that opens the other way gets the statement instead', async () => {
    const s = await interpret('supports protecting clean air standards from rollback', {
      ...classifier, stance: 'In Favor', restated: 'Opposes elimination or weakening of existing clean air standards.',
    });
    expect(s.interpretation!.restated).toBe('Supports protecting clean air standards from rollback.');
  });

  it('a statement with no stance word keeps the classifier\'s label', async () => {
    const s = await interpret('end tariffs on imported goods', classifier);
    expect(s.interpretation!.stance).toBe('Opposed');
    expect(s.interpretation!.restated).toBe('Opposes tariffs on imported goods.');
  });

  it('a reader\'s correction still wins over the statement\'s words', async () => {
    const s = await interpret('supports ending tariffs on imported goods', classifier, { stance: 'Opposed' });
    expect(s.interpretation!.stance).toBe('Opposed');
  });

  it('the bill reader is shown the statement with the stance its words state', async () => {
    const s = await interpret('supports ending tariffs on imported goods', classifier);
    s.scope = { scope: 'STANDING' } as never;
    const m = {
      action_uid: 'ACT-sjres88-119-S000148', bill_id: 'sjres88-119',
      title: 'A joint resolution terminating the national emergency declared to impose global tariffs.',
      summary: 'Terminates the national emergency declared to impose global tariffs.',
      action_type: 'voted', vote: 'Yea', primary_issue: 'Budget & Economy', sub_issue: 'Trade / Free Trade',
    } as unknown as MatchedAction;
    const message = buildFulfillmentUserMessage(toFulfillmentCandidate(s, m));
    expect(message).toContain('- Statement: supports ending tariffs on imported goods\n- Stance: In Favor\n');
  });
});

describe('the classifier is told the same rule', () => {
  it('reads the stance against the statement\'s own words, with the tariffs example', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/the statement's direction toward the policy its own words name/);
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/"Supports ending tariffs" is In Favor — of ending tariffs — not Opposed to tariffs\./);
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/Write `restated` in the same frame as the stance/);
  });
});

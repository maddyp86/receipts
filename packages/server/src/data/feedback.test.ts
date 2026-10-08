import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABEL, FEEDBACK_THANKS } from '@receipts/shared';
import { nullFeedbackStore, validateFeedback } from './FeedbackStore.js';

// ===========================================================================
// READER FEEDBACK — what it records, and that it can never change a verdict.
// ===========================================================================

const RUN = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const base = { run_id: RUN, politician_id: 'S000148', promise_text: 'promised to protect clean air', verdict_shown: 'KEPT · Low' };

describe('what each piece of feedback records', () => {
  it.each(FEEDBACK_KINDS.result)('%s is about the whole answer, and names no bill', (kind) => {
    const r = validateFeedback({ ...base, kind, comment: '  read it as the opposite  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row).toEqual({
        ...base, kind, level: 'result', action_uid: null, bill_id: null, comment: 'read it as the opposite',
      });
    }
  });

  it.each(FEEDBACK_KINDS.evidence)('%s is about one bill, and says which', (kind) => {
    const r = validateFeedback({ ...base, kind, action_uid: 'ACT-sjres31-119-S000148', bill_id: 'sjres31-119' });
    expect(r.ok && r.row.level).toBe('evidence');
    expect(r.ok && r.row.bill_id).toBe('sjres31-119');
  });

  it('the four kinds are the four the reader is offered', () => {
    expect([...FEEDBACK_KINDS.result, ...FEEDBACK_KINDS.evidence].sort()).toEqual(
      ['BILL_NOT_RELEVANT', 'BILL_READ_BACKWARDS', 'QUESTION_MISREAD', 'VERDICT_WRONG'],
    );
    for (const k of [...FEEDBACK_KINDS.result, ...FEEDBACK_KINDS.evidence]) expect(FEEDBACK_KIND_LABEL[k]).toBeTruthy();
  });

  it('a comment is optional', () => {
    const r = validateFeedback({ ...base, kind: 'VERDICT_WRONG' });
    expect(r.ok && r.row.comment).toBeNull();
  });
});

describe('what is refused, with a reason', () => {
  it.each([
    ['an unknown kind', { ...base, kind: 'OTHER' }],
    ['no run id', { ...base, kind: 'VERDICT_WRONG', run_id: '' }],
    ['a bad senator id', { ...base, kind: 'VERDICT_WRONG', politician_id: 'Schumer' }],
    ['no question', { ...base, kind: 'VERDICT_WRONG', promise_text: '' }],
    ['a comment over 1,000 characters', { ...base, kind: 'VERDICT_WRONG', comment: 'x'.repeat(1001) }],
    ['a bill-level kind with no bill', { ...base, kind: 'BILL_READ_BACKWARDS' }],
    ['a result-level kind naming a bill', { ...base, kind: 'VERDICT_WRONG', action_uid: 'ACT-x', bill_id: 'x' }],
  ])('%s', (_name, body) => {
    const r = validateFeedback(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBeTruthy();
  });
});

describe('it can never change a verdict', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../docs/supabase-migration-012-feedback.sql', import.meta.url)),
    'utf8',
  );

  // Structural, like the corpus firewall: the app role can write feedback
  // and do nothing else with it, so no code path can read it back.
  it('the app role is granted INSERT and nothing else', () => {
    expect(sql).toMatch(/grant insert on app\.app_feedback to receipts_app;/);
    expect(sql).not.toMatch(/grant [^;]*select[^;]*app\.app_feedback/i);
    expect(sql).toMatch(/revoke select, update, delete on app\.app_feedback from receipts_app;/);
  });

  it('the store has no read method', async () => {
    const mod = await import('./FeedbackStore.js');
    expect(Object.keys(mod.nullFeedbackStore).sort()).toEqual(['add', 'kind']);
    expect(Object.getOwnPropertyNames(mod.SupabaseFeedbackStore.prototype).sort()).toEqual(['add', 'constructor']);
  });

  it('stores no IP, user agent or session', () => {
    expect(sql).not.toMatch(/\b(ip|ip_address|user_agent|session_id)\b\s+text/);
  });

  it('the thanks says it does not change the answer', () => {
    expect(FEEDBACK_THANKS).toMatch(/doesn't change this answer/);
  });
});

describe('with no database', () => {
  it('refuses to pretend it stored anything', async () => {
    await expect(nullFeedbackStore.add({} as never)).rejects.toThrow(/cannot be stored/);
  });
});

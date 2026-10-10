import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_PROMPT_BILL,
  FEEDBACK_PROMPT_KINDS,
  FEEDBACK_PROMPT_RESULT,
  FEEDBACK_PROMPT_THANKS,
  FEEDBACK_THANKS,
} from '@receipts/shared';
import { ACCEPTED_KINDS, SupabaseFeedbackStore, constraintAcceptsPrompts, nullFeedbackStore, validateFeedback } from './FeedbackStore.js';

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
    expect(Object.keys(mod.nullFeedbackStore).sort()).toEqual(['add', 'kind', 'promptsAccepted']);
    expect(Object.getOwnPropertyNames(mod.SupabaseFeedbackStore.prototype).sort()).toEqual(['add', 'constructor', 'promptsAccepted']);
  });

  // promptsAccepted reads the table's DEFINITION from the catalog (whether
  // migration 013 has run), never a feedback row. Pinned on its source.
  it('the one other method reads the catalog, never a feedback row', () => {
    const src = SupabaseFeedbackStore.prototype.promptsAccepted.toString();
    expect(src).toMatch(/from pg_constraint/);
    expect(src).not.toMatch(/from\s+app\.app_feedback/i);
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

// ===========================================================================
// THE TWO PROMPTS — answers a reader is asked for (migration 013).
// ===========================================================================

describe('the prompts', () => {
  it.each(FEEDBACK_PROMPT_KINDS.result)('%s is about the whole answer, and names no bill', (kind) => {
    const r = validateFeedback({ ...base, kind });
    expect(r.ok && r.row).toMatchObject({ kind, level: 'result', action_uid: null, bill_id: null });
    expect(validateFeedback({ ...base, kind, action_uid: 'ACT-x', bill_id: 'x' }).ok).toBe(false);
  });

  it('a bill’s "yes" is about one bill, and says which; its "no" is the kind that already existed', () => {
    expect(FEEDBACK_PROMPT_KINDS.evidence).toEqual(['BILL_RELEVANT']);
    const bill = { action_uid: 'ACT-sjres31-119-S000148', bill_id: 'sjres31-119' };
    for (const kind of ['BILL_RELEVANT', 'BILL_NOT_RELEVANT']) {
      const r = validateFeedback({ ...base, kind, ...bill });
      expect(r.ok && r.row).toMatchObject({ kind, level: 'evidence', bill_id: 'sjres31-119' });
    }
    expect(validateFeedback({ ...base, kind: 'BILL_RELEVANT' }).ok).toBe(false);
  });

  // Agreement mostly measures whether the reader likes the member. Both
  // prompts ask about fit, which a reader of either party answers alike.
  it('ask whether it fits what was asked, never whether the reader agrees', () => {
    for (const prompt of [FEEDBACK_PROMPT_RESULT, FEEDBACK_PROMPT_BILL]) {
      expect(prompt).toMatch(/what you asked\?$/);
      expect(prompt).not.toMatch(/agree|right|correct|fair/i);
    }
  });

  it('the thanks says, like the other one, that nothing on screen changes', () => {
    expect(FEEDBACK_PROMPT_THANKS).toMatch(/doesn't change this answer/);
  });

  it('every kind has words, and the "what looks wrong" list is still the four', () => {
    for (const k of ACCEPTED_KINDS) expect(FEEDBACK_KIND_LABEL[k]).toBeTruthy();
    expect([...FEEDBACK_KINDS.result, ...FEEDBACK_KINDS.evidence]).toHaveLength(4);
  });
});

describe('migration 013', () => {
  const sql013 = readFileSync(
    fileURLToPath(new URL('../../../../docs/supabase-migration-013-feedback-prompts.sql', import.meta.url)),
    'utf8',
  );
  const body = sql013.replace(/^\s*--.*$/gm, '');

  // The table refuses any kind its check does not list. A kind the code
  // accepts and the migration forgot is feedback that fails at the database.
  it('allows exactly the kinds the endpoint accepts', () => {
    const list = /check \(kind in \(([^)]+)\)\)/i.exec(body)![1]!;
    const allowed = [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    expect(allowed).toEqual([...ACCEPTED_KINDS].sort());
  });

  it('changes no grant and no policy: still insert-only, still never read back', () => {
    expect(body).not.toMatch(/\bgrant\b/i);
    expect(body).not.toMatch(/\bpolicy\b/i);
    expect(body).not.toMatch(/\b(drop|alter) table\b(?![^;]*constraint)/i);
  });

  it('is one transaction', () => {
    expect(body).toMatch(/\bbegin;[\s\S]*\bcommit;/i);
  });
});

describe('feedback prompts are offered only once the table accepts them', () => {
  // The kind constraint exactly as production reads today (012), and as 013 leaves it.
  const before = "CHECK ((kind = ANY (ARRAY['QUESTION_MISREAD'::text, 'VERDICT_WRONG'::text, 'BILL_NOT_RELEVANT'::text, 'BILL_READ_BACKWARDS'::text])))";
  const after = "CHECK ((kind = ANY (ARRAY['QUESTION_MISREAD'::text, 'VERDICT_WRONG'::text, 'BILL_NOT_RELEVANT'::text, 'BILL_READ_BACKWARDS'::text, 'ANSWERED_YES'::text, 'ANSWERED_PARTLY'::text, 'ANSWERED_NO'::text, 'BILL_RELEVANT'::text])))";
  const other = 'CHECK ((char_length(promise_text) <= 2000))';

  it('before migration 013: not offered', () => {
    expect(constraintAcceptsPrompts([other, before])).toBe(false);
  });
  it('after it: offered', () => {
    expect(constraintAcceptsPrompts([other, after])).toBe(true);
  });
  it('no kind constraint found: not offered', () => {
    expect(constraintAcceptsPrompts([other])).toBe(false);
  });
  it('with no database: not offered', async () => {
    expect(await nullFeedbackStore.promptsAccepted()).toBe(false);
  });
});

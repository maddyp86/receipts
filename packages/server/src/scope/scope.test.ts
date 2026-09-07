import { describe, expect, it } from 'vitest';
import { VALID_UNTIL_UNKNOWN, isTestableSpeechAct } from '@receipts/shared';
import { scopePostCheck, type RawScopeOutput } from './postCheck.js';
import {
  classifyScope,
  haltForScope,
  InMemoryScopeCache,
  normaliseStatementText,
  scopeCacheKey,
  type ScopeFetcher,
} from './classifyScope.js';
import {
  SCOPE_CLASSIFIER_SYSTEM_PROMPT,
  SCOPE_CLASSIFIER_SYSTEM_PROMPT_LENGTH,
  SCOPE_CLASSIFIER_SYSTEM_PROMPT_VERSION,
} from './scopeClassifierPrompt.js';

const MODEL = 'claude-haiku-4-5 / scope-classifier-v1.1';

const check = (text: string, raw: RawScopeOutput | null = {}, date = '') =>
  scopePostCheck({ text, date }, raw, MODEL);

// ===========================================================================
// The prompt itself
// ===========================================================================

describe('scope classifier prompt', () => {
  it('matches its asserted length', () => {
    expect(SCOPE_CLASSIFIER_SYSTEM_PROMPT).toHaveLength(SCOPE_CLASSIFIER_SYSTEM_PROMPT_LENGTH);
  });

  // Handoff v2 §1. Without this paragraph "I support the IRA" was BOUNDED and
  // expired 730 days after it was said, so a later repeal vote could not be
  // tested against it. If this fails, the prompt was regenerated from v1.
  it('carries the v1.1 rule that a POSITION naming a law stays STANDING', () => {
    const normalised = SCOPE_CLASSIFIER_SYSTEM_PROMPT.replace(/\s+/g, ' ');
    expect(normalised).toContain(
      'is an opinion about it, not a pledge to act on it, and stays STANDING',
    );
    expect(SCOPE_CLASSIFIER_SYSTEM_PROMPT_VERSION).toBe('scope-classifier-v1.1');
  });
});

// ===========================================================================
// Post-check — the deterministic overrides
// ===========================================================================

describe('scopePostCheck overrides', () => {
  it('forces OPERATIONAL on scheduling language the model called a commitment', () => {
    const r = check('I will file cloture on these nominees.', { speech_act: 'COMMITMENT' });
    expect(r.speech_act).toBe('OPERATIONAL');
    expect(r.flags).toContain('SPEECH_ACT_OVERRIDE_OPERATIONAL');
  });

  it('demotes a COMMITMENT to CREDIT_CLAIM on delivery language', () => {
    const r = check('I am proud to have secured $15M for the port.', { speech_act: 'COMMITMENT' });
    expect(r.speech_act).toBe('CREDIT_CLAIM');
    expect(r.flags).toContain('SPEECH_ACT_OVERRIDE_CREDIT');
  });

  it('forces BOUNDED on deictic language', () => {
    const r = check('I will vote against this bill.', { speech_act: 'COMMITMENT', scope: 'STANDING' });
    expect(r.scope).toBe('BOUNDED');
    expect(r.flags).toContain('SCOPE_OVERRIDE_BOUNDED');
  });

  it('every OPERATIONAL statement is BOUNDED', () => {
    const r = check('The Senate will take up the CR next week.', { scope: 'STANDING' });
    expect(r.speech_act).toBe('OPERATIONAL');
    expect(r.scope).toBe('BOUNDED');
  });

  it('infers MAJORITY_LEADER from first-person floor control', () => {
    const r = check('I will file cloture on them.', { role_condition: 'NONE' });
    expect(r.role_condition).toBe('MAJORITY_LEADER');
    expect(r.flags).toContain('ROLE_OVERRIDE_LEADER');
  });

  it('leaves a plain position alone', () => {
    const r = check('I support universal background checks.', {
      speech_act: 'POSITION',
      scope: 'STANDING',
      confidence: 0.9,
    });
    expect(r.speech_act).toBe('POSITION');
    expect(r.scope).toBe('STANDING');
    expect(r.flags).toHaveLength(0);
  });
});

describe('scopePostCheck valid_until', () => {
  it('derives a president term end', () => {
    const r = check("I will oppose President Biden's judicial nominees.", { scope: 'BOUNDED' });
    expect(r.valid_until).toBe('2025-01-20');
    expect(r.flags).toContain('VALID_UNTIL_DERIVED');
  });

  it('derives a fiscal year end', () => {
    const r = check('I will secure this funding in FY2023.', { scope: 'BOUNDED' });
    expect(r.valid_until).toBe('2023-09-30');
  });

  it('adds 30 days to a relative window when the date is known', () => {
    const r = check('We will vote on this next week.', { scope: 'BOUNDED' }, '2025-03-01');
    expect(r.valid_until).toBe('2025-03-31');
  });

  it('returns UNKNOWN for a relative window with no statement date', () => {
    const r = check('We will vote on this next week.', { scope: 'BOUNDED' });
    expect(r.valid_until).toBe(VALID_UNTIL_UNKNOWN);
  });

  // STANDING means "no last testable date"; UNKNOWN means "bounded, window
  // unresolved". Only one of them halts a query, so they must not collapse.
  it('clears valid_until on STANDING rather than leaving UNKNOWN', () => {
    const r = check('Rural broadband is essential.', {
      scope: 'STANDING',
      valid_until: VALID_UNTIL_UNKNOWN,
    });
    expect(r.valid_until).toBe('');
    expect(r.valid_until).not.toBe(VALID_UNTIL_UNKNOWN);
  });
});

describe('scopePostCheck robustness', () => {
  it('degrades to the deterministic layer when the model output is unparseable', () => {
    const r = check('The Senate will vote tomorrow.', null);
    expect(r.speech_act).toBe('OPERATIONAL');
    expect(r.scope).toBe('BOUNDED');
  });

  // A value outside the vocabulary would defeat every downstream
  // `=== 'BOUNDED'` test silently, so it is replaced and flagged.
  it('rejects an out-of-vocabulary value rather than passing it through', () => {
    const r = check('A statement.', { speech_act: 'PLEDGE', scope: 'PERMANENT' });
    expect(r.speech_act).toBe('POSITION');
    expect(r.scope).toBe('STANDING');
    expect(r.flags.some((f) => f.startsWith('SPEECH_ACT_UNRECOGNISED'))).toBe(true);
    expect(r.flags.some((f) => f.startsWith('SCOPE_UNRECOGNISED'))).toBe(true);
  });
});

// ===========================================================================
// Halts
// ===========================================================================

describe('haltForScope', () => {
  const base = check('I support universal background checks.', {
    speech_act: 'POSITION',
    scope: 'STANDING',
  });

  it('lets a testable statement through', () => {
    expect(haltForScope(base)).toBeNull();
  });

  it.each(['OPERATIONAL', 'CREDIT_CLAIM', 'RHETORIC'] as const)(
    'halts %s as non-testable',
    (act) => {
      expect(isTestableSpeechAct(act)).toBe(false);
      const halt = haltForScope({ ...base, speech_act: act });
      expect(halt?.reason).toBe('NON_TESTABLE_SPEECH_ACT');
      expect(halt?.recoverable_with_date).toBe(false);
    },
  );

  it('asks for a date on a bounded statement with an unresolved window', () => {
    const halt = haltForScope({ ...base, scope: 'BOUNDED', valid_until: VALID_UNTIL_UNKNOWN });
    expect(halt?.reason).toBe('STATEMENT_DATE_REQUIRED');
    expect(halt?.recoverable_with_date).toBe(true);
  });

  it('does not halt a bounded statement whose window resolved', () => {
    expect(haltForScope({ ...base, scope: 'BOUNDED', valid_until: '2025-01-20' })).toBeNull();
  });

  // Order matters: a scheduling remark with an unresolvable window should be
  // explained as a scheduling remark, not prompted for a date that won't help.
  it('reports the speech act first when both conditions hold', () => {
    const halt = haltForScope({
      ...base,
      speech_act: 'OPERATIONAL',
      scope: 'BOUNDED',
      valid_until: VALID_UNTIL_UNKNOWN,
    });
    expect(halt?.reason).toBe('NON_TESTABLE_SPEECH_ACT');
  });
});

// ===========================================================================
// Cache
// ===========================================================================

describe('scope classification cache', () => {
  it('normalises whitespace and case', () => {
    expect(normaliseStatementText('  I  Support   This ')).toBe('i support this');
  });

  // The window is derived from text AND date, so the date must be in the key.
  // Caching on text alone serves a window computed for a different date.
  it('keys on the date as well as the text', () => {
    const a = scopeCacheKey({ text: 'We vote next week.', date: '2025-03-01' });
    const b = scopeCacheKey({ text: 'We vote next week.', date: '2026-03-01' });
    const c = scopeCacheKey({ text: 'we  vote   next week.', date: '2025-03-01' });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it('calls the model once for a repeated statement', async () => {
    let calls = 0;
    const fetcher: ScopeFetcher = async () => {
      calls += 1;
      return { speech_act: 'POSITION', scope: 'STANDING', confidence: 0.9 };
    };
    const cache = new InMemoryScopeCache();
    const input = { text: 'I support rural broadband.', date: '' };

    const first = await classifyScope(input, { fetcher, cache });
    const second = await classifyScope(input, { fetcher, cache });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('records when the model response could not be parsed', async () => {
    const fetcher: ScopeFetcher = async () => null;
    const r = await classifyScope(
      { text: 'I support rural broadband.', date: '' },
      { fetcher, cache: new InMemoryScopeCache() },
    );
    expect(r.flags).toContain('SCOPE_MODEL_UNPARSED');
  });
});

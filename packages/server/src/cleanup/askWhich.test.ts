import { describe, expect, it } from 'vitest';
import { whichPolicyFor } from '@receipts/shared';
import { askWhichPolicy, checkWhich } from './askWhich.js';
import { ASK_WHICH_SYSTEM_PROMPT } from './askWhichPrompt.js';

// ===========================================================================
// "Which policy?" (2026-10-11). "He promised not to raise my taxes" names a
// side but not a policy; the reader is offered readings and picks one. The
// model may add specificity — the reader sees and chooses it — but the code
// check holds what an option may never add.
// ===========================================================================

const TAXES = 'He promised not to raise my taxes.';
const ask = (options: Array<{ label: string; statement: string }>, topic = 'taxes', question = 'Which taxes do you mean?') => ({ action: 'ASK_WHICH', topic, question, options });

describe('checkWhich', () => {
  it('the taxes case: three readings on the reader\'s side', () => {
    const d = checkWhich(TAXES, ask([
      { label: 'Income taxes', statement: 'opposes raising income taxes on individuals' },
      { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
      { label: 'Taxes in general', statement: 'opposes raising taxes' },
    ]));
    expect(d).toEqual({
      action: 'ASK_WHICH', topic: 'taxes', question: 'Which taxes do you mean?',
      options: [
        { label: 'Income taxes', statement: 'opposes raising income taxes on individuals' },
        { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
        { label: 'Taxes in general', statement: 'opposes raising taxes' },
      ],
    });
  });

  it('drops an option on the other side; with fewer than two left, asks nothing', () => {
    const d = checkWhich(TAXES, ask([
      { label: 'Income taxes', statement: 'opposes raising income taxes on individuals' },
      { label: 'Taxes on the wealthy', statement: 'supports raising taxes on high earners' },
    ]));
    expect(d.action).toBe('SPECIFIC');
    expect(d.action === 'SPECIFIC' && d.reason).toMatch(/takes a side the reader did not/);
  });

  it('drops a camp\'s label, a pronoun subject, an off-topic reading and a question', () => {
    const d = checkWhich(TAXES, ask([
      { label: 'Estate tax', statement: 'opposes the death tax' },
      { label: 'Him', statement: 'he opposes raising taxes' },
      { label: 'Tariffs', statement: 'opposes raising tariffs on imports' },
      { label: 'Which?', statement: 'opposes raising payroll taxes?' },
    ]));
    expect(d.action).toBe('SPECIFIC');
    const reason = d.action === 'SPECIFIC' ? d.reason : '';
    expect(reason).toMatch(/camp's label/);
    expect(reason).toMatch(/does not open with a side/);
    expect(reason).toMatch(/not on the reader's topic/);
    expect(reason).toMatch(/statement unusable/);
  });

  it('asks nothing when the statement itself has no readable side', () => {
    expect(checkWhich('my taxes', ask([
      { label: 'Income taxes', statement: 'opposes raising income taxes' },
      { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
    ])).action).toBe('SPECIFIC');
  });

  it('a question that does not read as "Which …?" on their topic falls back to a fixed one', () => {
    const opts = [
      { label: 'Income taxes', statement: 'opposes raising income taxes' },
      { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
    ];
    const q = (question: string) => {
      const d = checkWhich(TAXES, ask(opts, 'taxes', question));
      return d.action === 'ASK_WHICH' ? d.question : null;
    };
    expect(q('Which taxes do you mean?')).toBe('Which taxes do you mean?');
    expect(q('What about the death tax?')).toBe('Which one do you mean?');
    expect(q('Which policy?')).toBe('Which one do you mean?');
  });

  it('a topic must be in the reader\'s own words', () => {
    expect(checkWhich(TAXES, ask([
      { label: 'Income taxes', statement: 'opposes raising income taxes' },
      { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
    ], 'fiscal policy')).action).toBe('SPECIFIC');
  });

  it('SPECIFIC, nonsense and nothing are all "check it as typed"', () => {
    expect(checkWhich('supports the Laken Riley Act', { action: 'SPECIFIC' }).action).toBe('SPECIFIC');
    expect(checkWhich(TAXES, { action: 'MAYBE' }).action).toBe('SPECIFIC');
    expect(checkWhich(TAXES, null).action).toBe('SPECIFIC');
  });
});

describe('askWhichPolicy', () => {
  it('fails open: a failed call checks the statement as typed', async () => {
    const d = await askWhichPolicy(TAXES, { fetcher: async () => { throw new Error('down'); } });
    expect(d).toEqual({ action: 'SPECIFIC', reason: 'unavailable: down' });
  });
});

describe('the question the reader sees', () => {
  it('names the area, keeps what they typed, and says nothing is checked until they pick', () => {
    const c = whichPolicyFor(TAXES, 'taxes', [
      { label: 'Income taxes', statement: 'opposes raising income taxes on individuals' },
      { label: 'Payroll taxes', statement: 'opposes raising payroll taxes' },
    ], 'Which taxes do you mean?');
    expect(c.reason).toBe('POLICY_REQUIRED');
    expect(c.title).toBe('Which taxes do you mean?');
    expect(c.original).toBe(TAXES);
    expect(c.message).toMatch(/We won’t guess/);
    expect(c.message).not.toContain('taxes');
    expect(whichPolicyFor(TAXES, 'the economy', []).title).toBe('Which one do you mean?');
  });

  it('the prompt keeps the side and forbids camp labels', () => {
    expect(ASK_WHICH_SYSTEM_PROMPT).toMatch(/Keep the voter's side exactly/);
    expect(ASK_WHICH_SYSTEM_PROMPT).toMatch(/death tax/);
    expect(ASK_WHICH_SYSTEM_PROMPT).toMatch(/When in doubt, SPECIFIC/);
  });
});

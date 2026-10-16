import { describe, expect, it } from 'vitest';
import { classifyInputKind, inputKindByRule, parseInputKind } from './inputKind.js';

// ===========================================================================
// What the voter typed: a question about the record, or a statement to check.
// Run 3bf66a32 turned "Did they vote to extend the enhanced ACA tax credits?"
// into Collins's own position. The rules below are the free check; the model
// is asked only about what they cannot place, and the voter after that.
// ===========================================================================

const kind = (t: string) => inputKindByRule(t)?.kind ?? null;

describe('clear record questions', () => {
  it.each([
    'Did they vote to extend the enhanced Affordable Care Act tax credits?',
    'Did they vote to protect abortion access?',
    'Has she sponsored a bill to lower drug prices?',
    'Does she support expanding background checks?',
    'Does he support the Laken Riley Act?',
    'Is he for raising the debt limit?',
    'Was she against the 2025 rescissions package?',
    // No punctuation, still a question.
    'did she vote for the insulin cap',
    'has he voted to repeal the estate tax',
    // A question mark is enough on its own.
    'Collins and the insulin cap?',
  ])('%s', (t) => {
    expect(kind(t)).toBe('RECORD_QUESTION');
  });
});

describe('clear statements', () => {
  it.each([
    'supports extending the enhanced Affordable Care Act tax credits',
    'opposes cutting Medicaid',
    'Collins promised to protect Medicare',
    'He promised not to raise my taxes.',
    'She said she would vote to lower drug prices',
    'will fight to secure the border',
    'I will protect clean air.',
    // A goal stated as a verb phrase.
    'Lower prescription drug prices.',
    'protect clean air standards from rollback',
    'Permanently classify fentanyl-related drugs as Schedule I so traffickers face full penalties.',
    // What ought to happen, or the speaker's own words.
    'Congress should repeal the outdated Iraq war authorizations.',
    "Trump's tariffs are a tax on American families and should be ended.",
    'I support our veterans.',
    // A quotation is the senator's words, whatever its punctuation.
    '"We must expand background checks for every gun sale."',
    '“Will I ever vote to raise taxes on working families? Never.”',
    // "Did she promise…" asks about a promise, so it is checked as one.
    'Did she promise to protect Social Security?',
  ])('%s', (t) => {
    expect(kind(t)).toBe('STATEMENT');
  });
});

describe('what the rules leave to the existing path or to the model', () => {
  it('an open question stays with the clean-up, which asks which side to check', () => {
    expect(inputKindByRule('What is their stance on abortion?')).toMatchObject({ kind: 'STATEMENT', decided_by: 'rule:open_question' });
  });

  it('a bare phrase is not placed by a rule', () => {
    expect(inputKindByRule('her record on the debt limit')).toBeNull();
    expect(inputKindByRule('taxes for working families')).toBeNull();
  });

  it('each decision says which rule made it', () => {
    expect(inputKindByRule('did she vote for the insulin cap')).toMatchObject({ decided_by: 'rule:question_opener' });
    expect(inputKindByRule('Collins and the insulin cap?')).toMatchObject({ decided_by: 'rule:question_mark' });
    expect(inputKindByRule('Collins promised to protect Medicare')).toMatchObject({ decided_by: 'rule:attribution' });
  });
});

describe('the model fallback', () => {
  const said = (out: unknown) => async () => out as never;

  it('uses a confident answer', async () => {
    const d = await classifyInputKind('her record on the debt limit', said({ kind: 'RECORD_QUESTION', confidence: 0.9 }));
    expect(d).toMatchObject({ kind: 'RECORD_QUESTION', decided_by: 'model', confidence: 0.9 });
  });

  it('asks the voter when the model is unsure or cannot tell', async () => {
    expect((await classifyInputKind('her record on the debt limit', said({ kind: 'STATEMENT', confidence: 0.55 }))).kind).toBe('UNCLEAR');
    expect((await classifyInputKind('her record on the debt limit', said({ kind: 'UNCLEAR', confidence: 0.9 }))).kind).toBe('UNCLEAR');
  });

  // An outage must not make every reader choose: the statement path is how
  // every input was handled before this check existed.
  it('falls back to the statement path when the model cannot be reached', async () => {
    const d = await classifyInputKind('her record on the debt limit', async () => {
      throw new Error('boom');
    });
    expect(d).toMatchObject({ kind: 'STATEMENT', decided_by: 'model_failed' });
  });

  it('never calls the model when a rule decides', async () => {
    let called = false;
    await classifyInputKind('did she vote for the insulin cap', async () => {
      called = true;
      return null;
    });
    expect(called).toBe(false);
  });

  it('parses strictly', () => {
    expect(parseInputKind('```json\n{"kind":"STATEMENT","confidence":0.8}\n```')).toEqual({ kind: 'STATEMENT', confidence: 0.8 });
    expect(parseInputKind('nonsense')).toEqual({ kind: 'UNCLEAR', confidence: 0 });
    expect(parseInputKind({ kind: 'maybe', confidence: 1 })).toEqual({ kind: 'UNCLEAR', confidence: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { clarifyFor } from '@receipts/shared';
import {
  InMemoryCleanupCache,
  carriedFrom,
  checkDecision,
  cleanUpInput,
  needsCleanUp,
  stubCleanupFetcher,
  type CleanupFetcher,
  sideNotTheirs,
} from './cleanUpInput.js';
import { CLEANUP_SYSTEM_PROMPT } from './cleanupPrompt.js';

// ===========================================================================
// INPUT CLEAN-UP.
//
// The rule under test: the tool may change the FORM of what a reader typed by
// itself, and must ASK before adding anything they did not say. Every case
// here is a string a tester actually typed (2026-10-09 run) or one of the
// signed-off eval statements.
// ===========================================================================

const fresh = () => ({ cache: new InMemoryCleanupCache() });
const returns = (raw: unknown): CleanupFetcher => async () => raw as never;
const never: CleanupFetcher = async () => {
  throw new Error('the model must not be called for this text');
};

describe('the free check: which text goes any further', () => {
  it.each([
    'Did he vote to repeal the Social Security penalties for teachers and firefighters?',
    'What is his stance on abortion?',
    'What is his policy stance on same-sex marriage?',
    'He said he was going to cancel student debt. Did he do that?',
    'How did he do on healthcare?',
    'where does she stand on guns',
    'does he support raising the minimum wage',
    'abortion',
    'gun control',
  ])('a question or a bare topic: %s', (text) => {
    expect(needsCleanUp(text)).toBe(true);
  });

  // The ten signed-off eval statements, and the entry screen's own examples.
  // None of them may reach the model: for a statement this step must not exist.
  it.each([
    'promised to protect clean air standards from rollback',
    'I will fight to make student loan repayment affordable and cancel student debt.',
    "We will pass legislation to protect a woman's right to an abortion.",
    "Trump's tariffs are a tax on American families and should be ended.",
    'I will fight to end the penalties that cut Social Security for teachers, firefighters and police.',
    'I will secure the border and stop illegal immigration.',
    'Congress should pass clear rules for stablecoins and crypto.',
    'I will lower prescription drug prices by letting Medicare negotiate.',
    'promised to require photo ID to vote',
    'promised to classify fentanyl-related drugs as Schedule I',
    'He supports protecting abortion rights.',
    'He promised to ban assault weapons.',
    'supports restricting abortion',
    'ban abortion',
    'secure the border',
    'lower drug prices',
    '',
  ])('a statement is left alone: %s', async (text) => {
    expect(needsCleanUp(text)).toBe(false);
    expect(await cleanUpInput(text, { ...fresh(), fetcher: never })).toEqual({ action: 'PASS', reason: 'not a question' });
  });
});

describe('a rewrite is accepted only when its words are the reader’s', () => {
  it.each([
    ['Did he vote to repeal the Social Security penalties for teachers and firefighters?', 'supports repealing the Social Security penalties for teachers and firefighters'],
    ['He said he was going to cancel student debt. Did he do that?', 'promised to cancel student debt'],
    ['Is she against the assault weapons ban?', 'opposes the assault weapons ban'],
    ['does he support raising the minimum wage', 'supports raising the minimum wage'],
    ['Has he done anything to secure the border?', 'supports securing the border'],
  ])('%s → %s', (original, statement) => {
    expect(checkDecision(original, { action: 'REWRITE', statement })).toEqual({ action: 'REWRITE', statement });
  });

  it('tidies quotes and a trailing full stop', () => {
    expect(checkDecision('does he support raising the minimum wage', { action: 'REWRITE', statement: ' "supports raising the minimum wage." ' }))
      .toEqual({ action: 'REWRITE', statement: 'supports raising the minimum wage' });
  });

  // The failure this guard exists for: a subject the reader never typed.
  it('refuses a rewrite that brings in a subject of its own', () => {
    const d = checkDecision('What is his stance on abortion?', { action: 'REWRITE', statement: 'supports banning abortion after six weeks' });
    expect(d.action).toBe('PASS');
    expect(checkDecision('Did he vote for the farm bill?', { action: 'REWRITE', statement: 'supports cutting food stamps and crop insurance' }).action).toBe('PASS');
  });

  it.each([
    ['still a question', 'does he support raising the minimum wage?'],
    ['names a subject, not a position', 'he supports raising the minimum wage'],
    ['empty', ''],
  ])('refuses a rewrite that is %s', (_why, statement) => {
    expect(checkDecision('does he support raising the minimum wage', { action: 'REWRITE', statement }).action).toBe('PASS');
  });
});

// The subject check cannot see a side: "supports" is statement form, so
// "supports abortion" carries every content word of a question that had none.
describe('a rewrite never brings a side the reader did not type', () => {
  it.each([
    ['an open question has no side', 'What is his stance on abortion?', 'supports abortion', 'abortion'],
    ['a noun that sounds like a verb is not a side', 'What is his stance on the assault weapons ban?', 'supports the assault weapons ban', 'the assault weapons ban'],
    ['a yes/no question with nothing proposed', 'Did he vote on the farm bill?', 'supports the farm bill', 'the farm bill'],
    ['the reader said against', 'Is she against the assault weapons ban?', 'supports the assault weapons ban', 'the assault weapons ban'],
    ['the reader did not say against', 'Did he vote to repeal the estate tax?', 'opposes repealing the estate tax', 'repealing the estate tax'],
  ])('%s: asks which way instead', (_why, original, statement, proposition) => {
    const d = checkDecision(original, { action: 'REWRITE', statement });
    expect(d).toMatchObject({ action: 'ASK_SIDE', proposition });
    expect(d.action === 'ASK_SIDE' && d.why).toMatch(/^rewrite refused: /);
  });

  // "ban" is the side. Three of the four other words being the reader's does not make it theirs.
  it('a direction the text does not have is refused outright', () => {
    const d = checkDecision('What has he done about assault weapons in schools?', { action: 'REWRITE', statement: 'voted to ban assault weapons in schools' });
    expect(d).toMatchObject({ action: 'PASS' });
    expect(d.action === 'PASS' && d.reason).toMatch(/adds a side.*"ban"/);
    expect(checkDecision('What is his stance on assault weapons?', { action: 'ASK_SIDE', proposition: 'banning assault weapons' }).action).toBe('PASS');
  });

  it.each([
    ['Did he vote for the farm bill?', 'voted for the farm bill'],
    ['Why did he vote against the border bill?', 'voted against the border bill'],
    ['Does he back the border wall?', 'supports the border wall'],
    ['Where does he stand — does he support term limits?', 'supports term limits'],
  ])('a side the reader did type is kept: %s → %s', (original, statement) => {
    expect(checkDecision(original, { action: 'REWRITE', statement })).toEqual({ action: 'REWRITE', statement });
  });

  it.each([
    ['What is his stance on abortion?', 'supports abortion'],
    ['Did he vote on the farm bill?', 'supports the farm bill'],
    ['Is she against the assault weapons ban?', 'supports the assault weapons ban'],
  ])('%s → %s is named as not theirs', (original, statement) => {
    expect(sideNotTheirs(original, statement)).toBeTruthy();
  });
});

describe('asking which side', () => {
  it.each([
    ['What is his stance on abortion?', 'legal access to abortion'],
    ['What is his policy stance on same-sex marriage?', 'legal recognition of same-sex marriage'],
    ['gun control', 'stricter gun laws'],
    ["What's his position on tariffs?", 'tariffs on imported goods'],
  ])('%s → %s', (original, proposition) => {
    expect(checkDecision(original, { action: 'ASK_SIDE', proposition })).toEqual({ action: 'ASK_SIDE', proposition });
  });

  // The side is ours to add, both ways. A proposition that arrives with one has picked.
  it('strips a side the model put on the proposition', () => {
    expect(checkDecision('abortion', { action: 'ASK_SIDE', proposition: 'opposes legal access to abortion' }))
      .toEqual({ action: 'ASK_SIDE', proposition: 'legal access to abortion' });
  });

  it('refuses a proposition about something else', () => {
    expect(checkDecision('What is his stance on abortion?', { action: 'ASK_SIDE', proposition: 'stricter gun laws' }).action).toBe('PASS');
  });

  it('always offers both sides, supports first, from the one proposition', () => {
    const c = clarifyFor('legal access to abortion');
    expect(c.options).toEqual([
      { label: 'Supports legal access to abortion', statement: 'supports legal access to abortion' },
      { label: 'Opposes legal access to abortion', statement: 'opposes legal access to abortion' },
    ]);
    // Either option, typed back in, is a statement and is left alone.
    for (const o of c.options) expect(needsCleanUp(o.statement)).toBe(false);
  });
});

describe('it fails open', () => {
  const Q = 'What is his stance on abortion?';

  it('a failed call passes the text through, and is not remembered', async () => {
    const opts = fresh();
    const failing: CleanupFetcher = async () => {
      throw new Error('boom');
    };
    expect((await cleanUpInput(Q, { ...opts, fetcher: failing })).action).toBe('PASS');
    // The next attempt calls the model again rather than replaying the failure.
    expect(await cleanUpInput(Q, { ...opts, fetcher: returns({ action: 'ASK_SIDE', proposition: 'legal access to abortion' }) }))
      .toEqual({ action: 'ASK_SIDE', proposition: 'legal access to abortion' });
  });

  it.each([
    ['unparseable output', null],
    ['an action it was never offered', { action: 'ANSWER', statement: 'he is pro-life' }],
    ['no action', {}],
    ['a model PASS', { action: 'PASS' }],
  ])('%s is a PASS', async (_why, raw) => {
    expect((await cleanUpInput(Q, { ...fresh(), fetcher: returns(raw) })).action).toBe('PASS');
  });

  it('never throws', async () => {
    const throwing: CleanupFetcher = () => Promise.reject('not even an Error');
    await expect(cleanUpInput(Q, { ...fresh(), fetcher: throwing })).resolves.toMatchObject({ action: 'PASS' });
  });
});

describe('the same text gets the same decision', () => {
  it('a second ask does not call the model again', async () => {
    const opts = fresh();
    const first = await cleanUpInput('does he support raising the minimum wage', {
      ...opts, fetcher: returns({ action: 'REWRITE', statement: 'supports raising the minimum wage' }),
    });
    expect(await cleanUpInput('  Does he support   raising the minimum wage ', { ...opts, fetcher: never })).toEqual(first);
  });
});

describe('carriedFrom', () => {
  it('counts a word as carried across an ending', () => {
    expect(carriedFrom('Has he done anything to secure the border?', 'supports securing the border')).toBe(1);
    expect(carriedFrom('gun control', 'stricter gun laws')).toBe(1);
  });
  it('is 0 for a candidate with no subject at all', () => {
    expect(carriedFrom('abortion', 'supports that')).toBe(0);
  });
});

describe('the demo stand-in', () => {
  const stub = stubCleanupFetcher();
  it.each([
    ['What is his stance on abortion?', { action: 'ASK_SIDE', proposition: 'abortion' }],
    ['He said he was going to cancel student debt. Did he do that?', { action: 'REWRITE', statement: 'promised to cancel student debt.' }],
    ['Did he vote to repeal the widget tax?', { action: 'REWRITE', statement: 'supports repeal the widget tax' }],
    ['gun control', { action: 'ASK_SIDE', proposition: 'gun control' }],
    ['How did he do on healthcare?', { action: 'PASS' }],
  ])('%s', async (text, expected) => {
    expect(await stub(text)).toEqual(expected);
  });
});

describe('the prompt', () => {
  it('never tells the model who is being checked, and tells it not to say', () => {
    expect(CLEANUP_SYSTEM_PROMPT).not.toMatch(/Schumer|Thune/);
    expect(CLEANUP_SYSTEM_PROMPT).toMatch(/Never name the member/);
    expect(CLEANUP_SYSTEM_PROMPT).toMatch(/Never add a side/);
  });

  // Every example in the prompt must itself survive the code's check, or the
  // prompt is teaching the model an answer the code will refuse.
  it('its own examples pass the check', () => {
    const examples = [...CLEANUP_SYSTEM_PROMPT.matchAll(/^- "(.+?)" -> (\{.+\})$/gm)];
    expect(examples.length).toBeGreaterThanOrEqual(10);
    for (const [, text, json] of examples) {
      const raw = JSON.parse(json!) as { action: string };
      expect(needsCleanUp(text!), text).toBe(true);
      expect(checkDecision(text!, raw).action, `${text} → ${json}`).toBe(raw.action);
    }
  });
});

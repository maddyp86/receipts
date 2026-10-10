import { describe, expect, it } from 'vitest';
import { isTestableSpeechAct, type ScopeClassification } from '@receipts/shared';
import { asReaderQuestion } from '../scope/readerQuestion.js';
import { checkSuggestion, readerSide } from './cleanUpInput.js';

// ===========================================================================
// Trace d4631308 (2026-10-10): "Did they vote to protect abortion access?",
// one of our own examples, was refused as RHETORIC. The backstop, and the
// rewording offered when a statement still cannot be checked.
// ===========================================================================

const rhetoric = (over: Partial<ScopeClassification> = {}): ScopeClassification =>
  ({
    speech_act: 'RHETORIC', scope: 'STANDING', valid_until: '', anchor_entity: '', role_condition: 'NONE',
    confidence: 0.8, reasoning: 'This is a rhetorical question … cannot be classified as BOUNDED.', ...over,
  }) as ScopeClassification;

describe('a reader\'s question is not the senator\'s rhetoric', () => {
  it('the reported question is read as a position, so it is not halted', () => {
    const r = asReaderQuestion(rhetoric(), 'Did they vote to protect abortion access?');
    expect(r.overridden).toBe(true);
    expect(r.scope.speech_act).toBe('POSITION');
    expect(isTestableSpeechAct(r.scope.speech_act)).toBe(true);
    expect(r.scope.reasoning).toMatch(/Overridden: a reader's question/);
  });

  it('rhetoric typed as a statement still halts', () => {
    const r = asReaderQuestion(rhetoric(), 'He fights every day for working families.');
    expect(r.overridden).toBe(false);
    expect(isTestableSpeechAct(r.scope.speech_act)).toBe(false);
  });

  it('only RHETORIC is overridden; other untestable acts are left alone', () => {
    const r = asReaderQuestion(rhetoric({ speech_act: 'OPERATIONAL' }), 'Will they vote next week?');
    expect(r.overridden).toBe(false);
    expect(r.scope.speech_act).toBe('OPERATIONAL');
  });
});

describe('which side the reader took', () => {
  it.each([
    ['I support our veterans.', 'for'],
    ['He promised to help working families', 'for'],
    ["She's against big government spending", 'against'],
    ['my senator and immigration', null],
    ['Is he a good leader?', null],
  ] as const)('%s → %s', (text, side) => {
    expect(readerSide(text)).toBe(side);
  });
});

describe('the rewording offered: never a side the reader did not take', () => {
  it('same side as the reader: one option, kept as suggested', () => {
    const d = checkSuggestion('I support our veterans.', { action: 'SUGGEST', statement: 'supports expanding VA health care for veterans' });
    expect(d).toEqual({ action: 'SUGGEST', options: [{ label: 'supports expanding VA health care for veterans', statement: 'supports expanding VA health care for veterans' }] });
  });

  it('a reader who took no side gets both sides, never one', () => {
    const d = checkSuggestion('my senator and immigration', { action: 'SUGGEST', statement: 'supports increasing funding for immigration enforcement' });
    expect(d.action).toBe('SUGGEST');
    if (d.action !== 'SUGGEST') return;
    expect(d.options.map((o) => o.statement)).toEqual([
      'supports increasing funding for immigration enforcement',
      'opposes increasing funding for immigration enforcement',
    ]);
  });

  it('a suggestion on the other side from the reader becomes both sides', () => {
    const d = checkSuggestion('I support our veterans.', { action: 'SUGGEST', statement: 'opposes cuts to veterans benefits' });
    expect(d.action === 'SUGGEST' && d.options).toHaveLength(2);
  });

  it('ASK_SIDE gives both sides of the proposition', () => {
    const d = checkSuggestion('healthcare', { action: 'ASK_SIDE', proposition: 'expanding Medicare coverage for health care' });
    expect(d.action === 'SUGGEST' && d.options.map((o) => o.label)).toEqual([
      'Supports expanding Medicare coverage for health care',
      'Opposes expanding Medicare coverage for health care',
    ]);
  });

  it.each([
    ['off the reader\'s topic', 'I support our veterans.', { action: 'SUGGEST', statement: 'supports lowering prescription drug prices' }],
    ['a question', 'I support our veterans.', { action: 'SUGGEST', statement: 'supports veterans?' }],
    ['no side at the start', 'I support our veterans.', { action: 'SUGGEST', statement: 'the VA health care expansion for veterans' }],
    ['a subject pronoun', 'I support our veterans.', { action: 'SUGGEST', statement: 'he supports veterans health care' }],
    ['the model said none', 'Is he a good leader?', { action: 'NONE' }],
    ['unparseable', 'I support our veterans.', null],
  ] as const)('nothing is offered when the suggestion is %s', (_n, text, raw) => {
    expect(checkSuggestion(text, raw as never).action).toBe('NONE');
  });
});

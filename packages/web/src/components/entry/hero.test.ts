import { describe, expect, it } from 'vitest';
import { STARTERS } from '../../data/topics.js';
import { withName } from './Hero.js';
import cases from '../../../../../docs/eval/cases.json' with { type: 'json' };

describe('hero starters', () => {
  it('each is an eval case, about the same member, with the same words', () => {
    const list = (Array.isArray(cases) ? cases : (cases as { cases: unknown[] }).cases) as Array<{ id: string; senator: string; statement: string }>;
    for (const s of STARTERS) {
      const c = list.find((x) => x.id === s.evalCase);
      expect(c, s.evalCase).toBeDefined();
      expect(c!.senator).toBe(s.politicianId);
      expect(c!.statement).toBe(s.text);
    }
  });

  it('puts the member’s name in the question', () => {
    expect(withName('Did they vote for the Laken Riley Act?', 'Thune')).toBe('Did Thune vote for the Laken Riley Act?');
    expect(withName('Do they support X?', 'Collins')).toBe('Does Collins support X?');
    expect(withName('promised to protect clean air', 'Schumer')).toBe('promised to protect clean air');
  });
});

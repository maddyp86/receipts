import { describe, expect, it } from 'vitest';
import { sanitizeReaderText } from '@receipts/shared';

// No em dashes reach a reader (15 Oct). The prompts and the fixed copy avoid
// them; this is the last pass over model text and older stored data.

describe('sanitizeReaderText', () => {
  it('turns a dash between words into a comma', () => {
    expect(sanitizeReaderText('That is a decision, not a gap — each one says why below.')).toBe(
      'That is a decision, not a gap, each one says why below.',
    );
    expect(sanitizeReaderText('This bill caps insulin copays — the drug-pricing goal you asked about — and Schumer co-sponsored it.')).toBe(
      'This bill caps insulin copays, the drug-pricing goal you asked about, and Schumer co-sponsored it.',
    );
  });

  it('turns a dash in a number range into a hyphen', () => {
    expect(sanitizeReaderText('119th Congress (2025–2026)')).toBe('119th Congress (2025-2026)');
    expect(sanitizeReaderText('It failed 51—48.')).toBe('It failed 51-48.');
  });

  it('drops a dash before punctuation and at either end', () => {
    expect(sanitizeReaderText('Not read — .')).toBe('Not read.');
    expect(sanitizeReaderText('— done')).toBe('done');
    expect(sanitizeReaderText('working —')).toBe('working');
  });

  it('leaves text with no dashes, and empty values, untouched', () => {
    const s = 'Collins voted Yea to end debate on S.3385.';
    expect(sanitizeReaderText(s)).toBe(s);
    expect(sanitizeReaderText('')).toBe('');
    expect(sanitizeReaderText(null)).toBeNull();
  });

  it('keeps ordinary hyphens', () => {
    expect(sanitizeReaderText('a co-sponsor of the drug-pricing bill')).toBe('a co-sponsor of the drug-pricing bill');
  });
});

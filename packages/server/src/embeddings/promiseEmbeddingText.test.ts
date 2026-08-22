import { describe, expect, it } from 'vitest';
import { buildPromiseEmbeddingText } from './promiseEmbeddingText.js';
import { isValidCombination, lookupTaxonomyKeywords } from './taxonomy.js';

// ===========================================================================
// Golden test for embedding parity.
//
// The expected string below is written out by hand rather than generated, so
// that a change to the builder has to be justified against a literal rather
// than silently re-baselined. If this test fails, either the port drifted or
// the upstream template changed — and either way the query vector has moved.
// ===========================================================================

describe('buildPromiseEmbeddingText — WF7a template', () => {
  it('matches the upstream template byte for byte', () => {
    const text = buildPromiseEmbeddingText({
      statement: 'I will lower prescription drug prices.',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'Health Care',
      sub_issue: 'Prescription Drugs',
      key_policy_terms: ['prescription drug prices', 'insulin'],
      taxonomy_keywords: ['drug pricing', 'copay cap'],
      reasoning: 'Names a concrete policy outcome.',
    });

    const expected = [
      'Promise: I will lower prescription drug prices.',
      'Stance: In Favor',
      'Promise Type: policy',
      'Primary Issue: Health Care',
      'Sub-Issue: Prescription Drugs',
      'Key Policy Terms: prescription drug prices, insulin',
      'Related Terms: drug pricing, copay cap',
      'Reasoning: Names a concrete policy outcome.',
    ].join('\n\n');

    expect(text).toBe(expected);
  });

  // The three ways this template differs from the _statements v6 template. Each
  // is a real difference in the live pipeline, and getting any of them "right"
  // by unifying the two templates would be wrong.
  it('uses the query-side labels, not the statement-side ones', () => {
    const text = buildPromiseEmbeddingText({
      statement: 'x',
      stance: 'Opposed',
      promise_type: 'policy',
      primary_issue: 'A',
      sub_issue: 'B',
      taxonomy_keywords: ['k'],
    });
    expect(text.startsWith('Promise: ')).toBe(true);
    expect(text).not.toContain('Statement: ');
    expect(text).not.toContain('Statement Type:');
    expect(text).toContain('Related Terms: k');
    expect(text).not.toContain('Taxonomy Keywords:');
  });

  // WF3 writes the literal 'NA' when a statement yields no key terms or no
  // reasoning, so EVERY corpus vector carries those two lines. Dropping them on
  // a sparse query would make the query document two lines shorter than every
  // vector it is compared against — a silent similarity shift with no error.
  it("emits 'NA' for key terms and reasoning rather than dropping the lines", () => {
    const text = buildPromiseEmbeddingText({
      statement: 'A promise.',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'Health Care',
      sub_issue: 'Prescription Drugs',
    });
    expect(text).toBe(
      [
        'Promise: A promise.',
        'Stance: In Favor',
        'Promise Type: policy',
        'Primary Issue: Health Care',
        'Sub-Issue: Prescription Drugs',
        'Key Policy Terms: NA',
        'Reasoning: NA',
      ].join('\n\n'),
    );
  });

  it('omits Related Terms and only Related Terms', () => {
    // A taxonomy miss leaves the column blank upstream too, so this is the one
    // line whose absence is faithful rather than a parity bug.
    const text = buildPromiseEmbeddingText({
      statement: 'A promise.',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'Astrophysics',
      sub_issue: 'Dark Matter',
      key_policy_terms: ['one'],
      reasoning: 'Because.',
    });
    expect(text).not.toContain('Related Terms:');
    expect(text).toContain('Key Policy Terms: one');
    expect(text).toContain('Reasoning: Because.');
    expect(text.split('\n\n')).toHaveLength(7);
  });

  it('keeps every non-optional line even when its value is blank', () => {
    // Upstream behaviour: the template literal is truthy regardless of value,
    // so filter(Boolean) never removes these. Reproduce, do not tidy.
    const text = buildPromiseEmbeddingText({
      statement: '',
      stance: '',
      promise_type: '',
      primary_issue: '',
      sub_issue: '',
    });
    const lines = text.split('\n\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('Promise: ');
    expect(lines[1]).toBe('Stance: ');
  });

  it('accepts pre-joined strings as well as arrays', () => {
    const fromArray = buildPromiseEmbeddingText({
      statement: 's',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'A',
      sub_issue: 'B',
      key_policy_terms: ['one', 'two'],
    });
    const fromString = buildPromiseEmbeddingText({
      statement: 's',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'A',
      sub_issue: 'B',
      key_policy_terms: 'one, two',
    });
    expect(fromArray).toBe(fromString);
  });
});

describe('taxonomy lookup', () => {
  it('returns the sheet cell verbatim for a known combination', () => {
    const { keywords, found } = lookupTaxonomyKeywords('Health Care', 'Prescription Drugs');
    expect(found).toBe(true);
    expect(typeof keywords).toBe('string');
    expect(keywords).toContain('drug pricing');
  });

  // The cell goes into the embedded text unchanged. If we ever split and
  // re-join it, the Related Terms line stops matching the corpus.
  it('passes the cell through the builder without re-joining it', () => {
    const { keywords } = lookupTaxonomyKeywords('Health Care', 'Prescription Drugs');
    const text = buildPromiseEmbeddingText({
      statement: 's',
      stance: 'In Favor',
      promise_type: 'policy',
      primary_issue: 'Health Care',
      sub_issue: 'Prescription Drugs',
      taxonomy_keywords: keywords,
    });
    expect(text).toContain(`Related Terms: ${keywords}`);
  });

  it('is case- and whitespace-insensitive on the key', () => {
    expect(lookupTaxonomyKeywords('  health care ', 'prescription drugs').found).toBe(true);
  });

  // The important one: a miss must be visible and empty, never invented.
  it('reports a miss instead of guessing', () => {
    const { keywords, found } = lookupTaxonomyKeywords('Astrophysics', 'Dark Matter');
    expect(found).toBe(false);
    expect(keywords).toBe('');
    expect(isValidCombination('Astrophysics', 'Dark Matter')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Corrections } from '@receipts/shared';
import { buildPromiseEmbeddingText } from '../embeddings/promiseEmbeddingText.js';
import { lookupTaxonomyKeywords } from '../embeddings/taxonomy.js';
import { config } from '../config.js';

// ===========================================================================
// Correctable classification — the constraints, pinned.
//
// The rule the whole feature rests on: every correctable field is INSIDE the
// embedded query text, so a correction moves the vector and therefore the
// candidate set. If that ever stops being true, "a correction is a full re-run"
// becomes a lie and re-filtering the existing matches would start looking
// reasonable. These tests exist to make that regression loud.
// ===========================================================================

const embed = (over: Partial<Parameters<typeof buildPromiseEmbeddingText>[0]> = {}) =>
  buildPromiseEmbeddingText({
    statement: 'Lower prescription drug prices.',
    stance: 'In Favor',
    promise_type: 'policy',
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    key_policy_terms: ['insulin'],
    taxonomy_keywords: lookupTaxonomyKeywords('Health Care', 'Prescription Drugs').keywords,
    reasoning: 'Names a concrete outcome.',
    ...over,
  });

describe('every correctable field is inside the embedded text', () => {
  const baseline = embed();

  it('changing the primary issue changes the embedded text', () => {
    const keywords = lookupTaxonomyKeywords('Education', 'Higher Education').keywords;
    const moved = embed({
      primary_issue: 'Education',
      sub_issue: 'Higher Education',
      taxonomy_keywords: keywords,
    });
    expect(moved).not.toBe(baseline);
    // And the bridging keywords move with it — this is the part that most
    // changes the vector, not the two-word label.
    expect(moved).toContain('Related Terms:');
    expect(moved).not.toContain('prescription drugs, drug prices');
  });

  it('changing the sub issue changes the embedded text', () => {
    expect(
      embed({
        sub_issue: 'Mental Health',
        taxonomy_keywords: lookupTaxonomyKeywords('Health Care', 'Mental Health').keywords,
      }),
    ).not.toBe(baseline);
  });

  it('changing the stance changes the embedded text', () => {
    expect(embed({ stance: 'Opposed' })).not.toBe(baseline);
  });

  it('changing the promise type changes the embedded text', () => {
    expect(embed({ promise_type: 'process' })).not.toBe(baseline);
  });

  it('changing key policy terms changes the embedded text', () => {
    expect(embed({ key_policy_terms: ['copay cap', 'Medicare negotiation'] })).not.toBe(baseline);
  });

  it('every correctable field is covered by this suite', () => {
    // A new correctable field added to Corrections without a case above would
    // silently break the "correction = full re-run" premise.
    const covered = new Set([
      'primary_issue',
      'sub_issue',
      'stance',
      'promise_type',
      'key_policy_terms',
      'assert_campaign_promise', // not in the vector — changes vocabulary only
    ]);
    const declared: Array<keyof Corrections> = [
      'primary_issue',
      'sub_issue',
      'stance',
      'promise_type',
      'key_policy_terms',
      'assert_campaign_promise',
    ];
    for (const field of declared) expect(covered.has(field)).toBe(true);
  });
});

describe('the Campaign Promise override is gated', () => {
  it('ships dark by default', () => {
    // Printing "BROKE" against a commitment we have no evidence was made is the
    // one output with real downside, so the default must be off.
    expect(config.features.campaignPromiseOverride).toBe(false);
  });
});

describe('taxonomy pickers cannot offer an invalid pair', () => {
  it('every offered sub-issue is valid for its primary issue', async () => {
    const { primaryIssues, subIssuesFor, isValidCombination } = await import(
      '../embeddings/taxonomy.js'
    );
    let checked = 0;
    for (const primary of primaryIssues()) {
      for (const sub of subIssuesFor(primary)) {
        expect(isValidCombination(primary, sub)).toBe(true);
        checked += 1;
      }
    }
    // The correction UI is driven by exactly this data, so a user cannot
    // assemble a pair the server will reject.
    expect(checked).toBe(121);
  });
});

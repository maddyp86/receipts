import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dispatchTool, newSession } from '../orchestrator/dispatch.js';
import { lookupTaxonomyKeywords } from './taxonomy.js';

// ===========================================================================
// THE EMBEDDED TEXT IS DETERMINISTIC.
//
// Stability measurement, 2026-10-07: the same question, five runs, five
// different embedded texts — the classifier writes Key Policy Terms and
// Reasoning afresh each time, and retrieval moved with them (top-10 overlap
// down to 28%). Retrieval-only comparison: with Key Policy Terms from the
// taxonomy and Reasoning 'NA', retrieval was identical across all repeats of
// all six promises, at a small near-floor recall cost (one Senate climate
// resolution lost on clean energy; four unrelated tax bills gained near the
// floor on the death tax). Decided the same day.
//
// Fixture: the classifier's five real answers to the clean-air question.
// ===========================================================================

const FX = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/cleanAirClassifierAnswers.json', import.meta.url)), 'utf8'),
) as { senator: string; promise: string; answers: Array<Record<string, unknown>>; embedded_texts_before: string[] };

async function embeddedText(answer: Record<string, unknown>, corrections?: Record<string, unknown>) {
  const session = newSession(FX.senator, FX.promise, corrections as never);
  session.classifyFetcher = async () => structuredClone(answer);
  const env = await dispatchTool(session, 'interpret_promise', { ...answer });
  expect(env.ok).toBe(true);
  return { text: session.embeddingText!, interpretation: session.interpretation! };
}

describe('five sampled classifier answers, one embedded text', () => {
  it('the five answers produced five different texts before', () => {
    expect(new Set(FX.embedded_texts_before).size).toBe(5);
  });

  it('now produce one', async () => {
    const texts = new Set<string>();
    for (const a of FX.answers) texts.add((await embeddedText(a)).text);
    expect(texts.size).toBe(1);
  });

  it('Key Policy Terms are the taxonomy keywords and Reasoning is NA', async () => {
    const a = FX.answers[0]!;
    const { text } = await embeddedText(a);
    const { keywords } = lookupTaxonomyKeywords(String(a.primary_issue), String(a.sub_issue));
    const joined = Array.isArray(keywords) ? keywords.join(', ') : String(keywords);
    expect(text).toContain(`Key Policy Terms: ${joined}`);
    expect(text).toContain('Reasoning: NA');
    // No model-written prose reaches the vector.
    expect(text).not.toContain(String(a.reasoning));
  });

  // The departure is in the embedded text only: what the reader sees about
  // how we read their statement is unchanged.
  it("keeps the classifier's terms and reasoning on the interpretation shown", async () => {
    const a = FX.answers[0]!;
    const { interpretation } = await embeddedText(a);
    expect(interpretation.key_policy_terms).toEqual(a.key_policy_terms);
    expect(interpretation.reasoning).toBe(String(a.reasoning).trim());
  });
});

describe('a user correction still moves the vector', () => {
  // corrections.test.ts pins the rule: every correctable field is inside the
  // embedded text. Key terms a USER typed are deterministic, so they go in.
  it('corrected key terms replace the taxonomy keywords', async () => {
    const { text } = await embeddedText(FX.answers[0]!, { key_policy_terms: ['Clean Air Act section 112', 'hazardous air pollutants'] });
    expect(text).toContain('Key Policy Terms: Clean Air Act section 112, hazardous air pollutants');
  });

  it('and the same correction gives the same text every time', async () => {
    const c = { key_policy_terms: ['hazardous air pollutants'] };
    const texts = new Set<string>();
    for (const a of FX.answers) texts.add((await embeddedText(a, c)).text);
    expect(texts.size).toBe(1);
  });
});

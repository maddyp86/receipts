import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { METHODOLOGY } from '@receipts/shared';
import { config } from './config.js';
import { RELEVANCE_MODEL, RELEVANCE_PROMPT_CACHE_KEY } from './evaluation/relevancePrompt.js';
import { EVALUATOR_SYSTEM_PROMPT_VERSION } from './evaluation/evaluatorPromptV8.js';
import { JUDGE_SYSTEM_PROMPT_VERSION } from './judge/judgePrompt.js';
import { EVIDENCE_TYPE_FACTOR, NEAR_MISS_REVIEW_LIMIT, SIMILARITY } from './scoring/config.js';
import { ACCUSATION_CONFIDENCE_FLOOR } from './scoring/withholding.js';

// ===========================================================================
// The public methodology page (/methodology) states models and numbers from
// shared/methodology.ts. This holds that file to the code that runs: change a
// model, a threshold or a weight without updating the page, and this fails.
// ===========================================================================

describe('the methodology page states what the code does', () => {
  it('models, per step', () => {
    expect(METHODOLOGY.models.classify).toBe(config.models.classify);
    expect(METHODOLOGY.models.fulfill).toBe(config.models.fulfill);
    expect(METHODOLOGY.models.explain).toBe(config.models.explain);
    expect(METHODOLOGY.models.judge).toBe(config.models.judge);
    expect(METHODOLOGY.models.relevance).toBe(RELEVANCE_MODEL);
    expect(METHODOLOGY.models.embedding).toBe(config.embeddings.model);
    expect(METHODOLOGY.embeddingDimensions).toBe(config.embeddings.dimensions);
  });

  it('the bill-summary model, from the batch pipeline workflow', () => {
    const wf = readFileSync(
      new URL('../../../docs/v2/pipeline/wf5/create_impact_statements.json', import.meta.url),
      'utf8',
    );
    expect(wf).toContain(METHODOLOGY.models.billSummary);
  });

  it('retrieval: top K, the floor, and the near-miss review', () => {
    expect(METHODOLOGY.retrieval.topK).toBe(config.retrieval.topK);
    expect(METHODOLOGY.retrieval.floor).toBe(SIMILARITY.WEAK);
    expect(METHODOLOGY.retrieval.floor).toBe(SIMILARITY.STRONG);
    expect(METHODOLOGY.retrieval.nearMissFloor).toBe(SIMILARITY.REVIEW);
    expect(METHODOLOGY.retrieval.nearMissLimit).toBe(NEAR_MISS_REVIEW_LIMIT);
  });

  it('evidence weights and the accusation floor', () => {
    expect(METHODOLOGY.weights).toEqual(EVIDENCE_TYPE_FACTOR);
    expect(METHODOLOGY.accusationFloor).toBe(ACCUSATION_CONFIDENCE_FLOOR);
  });

  it('the topic list', () => {
    const t = JSON.parse(readFileSync(new URL('./embeddings/taxonomy.json', import.meta.url), 'utf8')) as {
      rows: { primary_issue: string }[];
    };
    expect(METHODOLOGY.taxonomy.pairs).toBe(t.rows.length);
    expect(METHODOLOGY.taxonomy.issues).toBe(new Set(t.rows.map((r) => r.primary_issue)).size);
  });

  it('prompt versions', () => {
    expect(METHODOLOGY.prompts.relevance).toBe(RELEVANCE_PROMPT_CACHE_KEY);
    expect(METHODOLOGY.prompts.billEffect).toBe(EVALUATOR_SYSTEM_PROMPT_VERSION);
    expect(METHODOLOGY.prompts.judge).toBe(JUDGE_SYSTEM_PROMPT_VERSION);
  });
});

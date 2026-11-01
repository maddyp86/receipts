// ===========================================================================
// The numbers and models the public methodology page states (/methodology).
//
// MIRRORS THE SERVER. Each value is copied from the code that actually runs,
// and packages/server/src/methodology.test.ts fails if they drift apart. So
// change the server, run the tests, and update this file in the same PR.
// Sources:
//   models          packages/server/src/config.ts (models.*, embedding.*),
//                   evaluation/relevancePrompt.ts (RELEVANCE_MODEL)
//   billSummary     the batch pipeline's impact statements (docs/v2/pipeline/
//                   wf5/create_impact_statements.json); not in the server
//   retrieval       config.ts (retrieval.topK), scoring/config.ts (SIMILARITY,
//                   NEAR_MISS_REVIEW_LIMIT)
//   weights         scoring/config.ts (EVIDENCE_TYPE_FACTOR)
//   accusation      scoring/withholding.ts (ACCUSATION_CONFIDENCE_FLOOR)
//   taxonomy        embeddings/taxonomy.json
//   prompts         evaluatorPromptV8.ts, judgePrompt.ts, relevancePrompt.ts
// ===========================================================================

export const METHODOLOGY = {
  models: {
    /** Reads what you typed: question or statement, topic, stance, scope. */
    classify: 'claude-haiku-4-5',
    /** Writes each bill's summary, once, in the batch pipeline (not per question). */
    billSummary: 'gpt-5.4-mini',
    embedding: 'text-embedding-3-small',
    /** Decides whether each candidate bill is really about the question. */
    relevance: 'gpt-5.4-mini',
    /** Reads each counted bill: advances, hinders, neither. */
    fulfill: 'gpt-5.4-mini',
    /** Reviews every accusation before it is shown. */
    judge: 'claude-opus-5-5',
    /** Writes the explanation and answers follow-up questions. */
    explain: 'claude-sonnet-5-5',
  },
  embeddingDimensions: 1024,
  retrieval: {
    topK: 10,
    /** Similarity a bill needs to be considered at all. */
    floor: 0.5,
    /** The near-miss review looks between this and the floor… */
    nearMissFloor: 0.45,
    /** …at no more than this many bills. */
    nearMissLimit: 5,
  },
  weights: { vote: 1.0, sponsorship: 1.0, procedural: 0.5, associative: 0.3 },
  /** An accusation (Broke / Inconsistent) needs at least this confidence in the deciding reading. */
  accusationFloor: 0.7,
  taxonomy: { issues: 23, pairs: 121 },
  prompts: { relevance: 'match-eval-v3', billEffect: 'bill-effect-v8', judge: 'judge-v1' },
  coverage: { congresses: [118, 119], since: 'January 2023' },
} as const;

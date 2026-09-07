import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeRelevanceResponse, parseRelevanceResponse } from './relevance.js';
import {
  buildFulfillmentRequest,
  buildFulfillmentUserMessage,
  evaluateFulfillment,
  parseFulfillmentResponse,
  type FulfillmentCandidate,
} from './fulfillment.js';
import {
  EVALUATOR_SYSTEM_PROMPT,
  EVALUATOR_SYSTEM_PROMPT_LENGTH,
  EVALUATOR_SYSTEM_PROMPT_VERSION,
} from './evaluatorPromptV7.js';
import {
  MissingCredentialError,
  fixtureEnvelope,
  fixtureResponsesFetcher,
  liveResponsesFetcher,
} from './responsesFetcher.js';
import { applyEvidenceGate } from './evidenceGate.js';
import {
  CLASSIFY_SYSTEM_PROMPT,
  ClassifyUnavailableError,
  classifyPromise,
} from './classify.js';
import { isValidCombination } from '../embeddings/taxonomy.js';
import type { EvaluatedCandidate } from './relevance.js';

const candidate = (over: Partial<FulfillmentCandidate> = {}): FulfillmentCandidate => ({
  statement_type: 'Policy Position',
  promise_uid: 'QUERY',
  promise_text: 'Lower prescription drug prices.',
  promise_stance: 'In Favor',
  promise_primary_issue: 'Health Care',
  promise_sub_issue: 'Prescription Drugs',
  bill_id: 'hr5376-117',
  action_uid: 'ACT-hr5376-117-S000148',
  bill_title: 'Inflation Reduction Act of 2022',
  bill_summary: 'Allows Medicare to negotiate drug prices.',
  bill_primary_issue: 'Health Care',
  bill_sub_issue: 'Prescription Drugs',
  vote: 'YEA',
  is_sponsor: 'FALSE',
  is_cosponsor: 'FALSE',
  ...over,
});

// ===========================================================================
// ASSERTION 1 — the /v1/responses reasoning-item trap.
// ===========================================================================

describe('the reasoning-item trap', () => {
  it('finds the message by type, not by index 0', () => {
    const env = fixtureEnvelope({ bill_effect: 'ADVANCE', alignment: 'CONSISTENT', confidence: 0.8 });
    // Index 0 is the reasoning item — reading it would yield no text at all.
    expect(env.output![0]!.type).toBe('reasoning');
    const { text } = normalizeRelevanceResponse(env);
    expect(JSON.parse(text).bill_effect).toBe('ADVANCE');
  });

  it('throws with the seen item types when there is no message item', () => {
    expect(() =>
      normalizeRelevanceResponse({ output: [{ type: 'reasoning' }] } as never),
    ).toThrow(/No message item.*reasoning/s);
  });
});

// ===========================================================================
// ASSERTION 2 — unknown verdict / unknown effect become ERROR, never coerced.
// ===========================================================================

describe('unknown values become ERROR', () => {
  it('rejects an unknown relevance verdict', () => {
    const r = parseRelevanceResponse(JSON.stringify({ verdict: 'MAYBE_RELEVANT' }));
    expect(r.verdict).toBe('ERROR');
    expect(r.error).toMatch(/unknown verdict/i);
  });

  it('rejects an unknown bill_effect rather than coercing it to NEUTRAL', () => {
    // The coercion this guards against is the dangerous one: NEUTRAL is a
    // finding ("does not bear on the goal"), not an absence of one.
    const r = parseFulfillmentResponse(
      JSON.stringify({ bill_effect: 'PARTIALLY_ADVANCES', alignment: 'CONSISTENT' }),
    );
    expect(r.bill_effect).toBe('ERROR');
    expect(r.error).toMatch(/unknown bill_effect/i);
  });

  it('rejects an unknown alignment', () => {
    const r = parseFulfillmentResponse(
      JSON.stringify({ bill_effect: 'ADVANCE', alignment: 'MOSTLY_KEPT' }),
    );
    expect(r.alignment).toBe('ERROR');
  });

  it('treats an empty or non-JSON message as ERROR', () => {
    expect(parseFulfillmentResponse('').bill_effect).toBe('ERROR');
    expect(parseFulfillmentResponse('sorry, I cannot').bill_effect).toBe('ERROR');
  });
});

// ===========================================================================
// ASSERTION 3 — admitted ≤ candidates.
// ===========================================================================

describe('evidence gate — admitted never exceeds candidates', () => {
  const evaluated = (uid: string, verdict: string): EvaluatedCandidate =>
    ({
      promise_uid: 'QUERY',
      bill_id: `bill-${uid}`,
      action_uid: uid,
      similarity_score: 0.8,
      match_direction: 'promise_to_bill',
      relevance: {
        verdict,
        confidence: 0.9,
        effort_relevant: 'NA',
        action_relevant: 'Yes',
        specificity_match: 'Yes',
      },
    }) as unknown as EvaluatedCandidate;

  it('admits at most what it was given', () => {
    const input = [
      evaluated('a', 'TRUE_POSITIVE'),
      evaluated('b', 'FALSE_POSITIVE'),
      evaluated('c', 'TRUE_POSITIVE'),
    ];
    const gate = applyEvidenceGate(input);
    expect(gate.admitted.length).toBeLessThanOrEqual(input.length);
    expect(gate.admitted.length).toBe(2);
    expect(gate.dropped.FALSE_POSITIVE).toBe(1);
  });

  it('reports an all-excluded result as excluded, not as an empty record', () => {
    const gate = applyEvidenceGate([evaluated('a', 'FALSE_POSITIVE')]);
    expect(gate.admitted).toHaveLength(0);
    expect(gate.candidatesIn).toBe(1);
    // "1 retrieved, 0 admitted" must remain distinguishable from "0 retrieved".
    expect(Object.values(gate.dropped).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

// ===========================================================================
// Credentials and fixtures must never fabricate a result.
// ===========================================================================

describe('no silent success', () => {
  it('throws MissingCredentialError instead of returning an empty envelope', async () => {
    await expect(
      liveResponsesFetcher('fulfillment')(buildFulfillmentRequest(candidate())),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('throws on a fixture gap rather than answering for an unknown candidate', async () => {
    const fetcher = fixtureResponsesFetcher({});
    await expect(fetcher(buildFulfillmentRequest(candidate()))).rejects.toThrow(/no fixture envelope/i);
  });

  it('turns a transport failure into ERROR for that candidate, not NEUTRAL', async () => {
    const boom = async () => {
      throw new Error('network down');
    };
    const [out] = await evaluateFulfillment([candidate()], boom);
    expect(out!.result.bill_effect).toBe('ERROR');
    expect(out!.result.bill_effect).not.toBe('NEUTRAL');
  });

  it('never loses a candidate', async () => {
    const fetcher = fixtureResponsesFetcher({
      'hr1-118': fixtureEnvelope({ bill_effect: 'ADVANCE', alignment: 'CONSISTENT', confidence: 0.8 }),
      'hr2-118': fixtureEnvelope({ bill_effect: 'HINDER', alignment: 'INCONSISTENT', confidence: 0.7 }),
    });
    const out = await evaluateFulfillment(
      [
        candidate({ action_uid: 'ACT-1', bill_id: 'hr1-118' }),
        candidate({ action_uid: 'ACT-2', bill_id: 'hr2-118' }),
      ],
      fetcher,
    );
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.result.bill_effect)).toEqual(['ADVANCE', 'HINDER']);
  });
});

// ===========================================================================
// The extracted prompt is guarded at request time, not just at generation time.
// ===========================================================================

describe('evaluator prompt v7 integrity', () => {
  it('is exactly the asserted length and version', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toHaveLength(EVALUATOR_SYSTEM_PROMPT_LENGTH);
    expect(EVALUATOR_SYSTEM_PROMPT_LENGTH).toBe(9343);
    expect(EVALUATOR_SYSTEM_PROMPT_VERSION).toBe('promise-alignment-v7');
  });

  it('is a different prompt from the relevance one — never conflate them', async () => {
    const { RELEVANCE_SYSTEM_PROMPT } = await import('./relevancePrompt.js');
    expect(EVALUATOR_SYSTEM_PROMPT).not.toBe(RELEVANCE_SYSTEM_PROMPT);
    expect(RELEVANCE_SYSTEM_PROMPT).toHaveLength(13740);
  });

  // =========================================================================
  // BYTE-COMPLETENESS.
  //
  // The Policy Position penalty reaches the query tool ONLY because it is
  // carried in this prompt — nothing in code applies it. A silent trim would
  // therefore remove the penalty from every free-typed query (which defaults
  // to Policy Position) with no error and no visible diff in behaviour. So it
  // is asserted, not eyeballed: a content hash catches any edit anywhere, and
  // the named clauses say WHICH loss the hash is protecting against.
  // =========================================================================

  it('hashes exactly — any silent trim anywhere fails here', () => {
    const hash = createHash('sha256').update(EVALUATOR_SYSTEM_PROMPT, 'utf8').digest('hex');
    expect(hash).toBe('e181a26b83807a314f06f03c8c6a8d48c8c0fb0e18a9d57b02667c6f066672a5');
  });

  it('carries the Policy Position penalty and its ceiling', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toContain(
      'Apply a -0.1 confidence penalty; maximum 0.9',
    );
  });

  // Contract 2 lives in code (capSplitConfidence) AND here. Both, deliberately:
  // the prompt asks the model to cap itself, the code enforces it when it
  // doesn't. Losing the prompt half means every split row argues for a higher
  // confidence that then gets clamped, which shows up as reasoning that
  // contradicts the number beside it.
  it('carries the hard confidence caps', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toContain(
      'Hard caps: split vote 0.75; broad vehicle 0.7; policy position 0.9',
    );
  });

  it('carries the v7 additions — same_object gate and CONTESTED', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('STEP 0: SAME OBJECT?');
    expect(EVALUATOR_SYSTEM_PROMPT).toContain(
      'same_object = false -> bill_effect NEUTRAL -> NOT_DETERMINABLE',
    );
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('CONTESTED -> NOT_DETERMINABLE');
  });

  // Contract: cloture governs in BOTH directions. The prompt and
  // deriveAlignment must agree, or the model argues for one verdict while the
  // code returns the other and the reasoning shown to the user is about a
  // verdict nobody reached.
  it('states the symmetric cloture rule that deriveAlignment implements', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('cloture governs, in BOTH directions');
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('A split vote is disclosed, never collapsed.');
  });

  // =========================================================================
  // THE REMOVED v6 RULES.
  //
  // Each of these produced a specific false accusation in the 79-row audit.
  // They are asserted ABSENT because the failure mode is reintroduction —
  // someone restoring a clause "for coverage" after seeing NOT_DETERMINABLE
  // rates rise, which is exactly what v7 is supposed to cause.
  // =========================================================================

  it.each([
    ['the 0.6 confidence floor', 'An indirect or inferred link does NOT drop below 0.6'],
    ['the anti-NEUTRAL rule', 'NEVER return NEUTRAL'],
    ['cloture as always determinative', 'always determinative'],
    ['the mechanism-is-not-the-test section', 'MECHANISM IS NOT THE TEST'],
  ])('does not reintroduce %s', (_name, clause) => {
    expect(EVALUATOR_SYSTEM_PROMPT).not.toContain(clause);
  });

  // v6 passed the relevance step's conclusion into this call, which anchored
  // the fulfilment answer on a different question's reasoning. fix/07 removes
  // it from the payload entirely.
  it('does not send prior relevance reasoning in the payload', () => {
    const msg = buildFulfillmentUserMessage(candidate({ statement_type: 'Policy Position' }));
    expect(msg).not.toContain('Prior LLM Reasoning');
    expect(msg).not.toContain('PRIOR EVALUATION CONTEXT');
  });

  it('sends the v7 context fields, with explicit markers when absent', () => {
    const msg = buildFulfillmentUserMessage(candidate());
    expect(msg).toContain('- Scope: UNKNOWN');
    expect(msg).toContain('- Anchor entity: none');
    expect(msg).toContain('- Role condition: UNKNOWN');
    expect(msg).toContain('- Bill class: UNKNOWN');
    expect(msg).toContain('- Senator role at the time: UNKNOWN');
    expect(msg).toContain('- Vote flags: none');
  });

  it('sends the system prompt and routes the model through config', () => {
    const body = buildFulfillmentRequest(candidate());
    expect(body.model).toBe('gpt-5.4-mini');
    expect(body.input[0]!.role).toBe('system');
    expect(body.input[0]!.content).toHaveLength(EVALUATOR_SYSTEM_PROMPT_LENGTH);
    expect(body.reasoning.effort).toBe('low');
  });

  it('renders the statement type into the user message', () => {
    const msg = buildFulfillmentUserMessage(candidate({ statement_type: 'Policy Position' }));
    expect(msg).toContain('- Statement Type: Policy Position');
    expect(msg).toContain('- Bill ID: hr5376-117');
    expect(msg).toContain('  • N/A — no stakeholder data available');
  });
});

// ===========================================================================
// The classify leg, and the 12-row in-taxonomy check's detection logic.
//
// The live check needs ANTHROPIC_API_KEY and cannot run here. What CAN be
// verified without a key is that the check would actually catch drift — a
// harness that passes everything is worse than no harness.
// ===========================================================================

describe('classify routing', () => {
  const fetcherReturning = (input: Record<string, unknown>) => async () => input;

  const validPair = {
    restated: 'Lower prescription drug prices.',
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    stance: 'In Favor',
    promise_type: 'policy',
    is_evaluable: true,
    key_policy_terms: ['prescription drug prices'],
    reasoning: 'Names a concrete policy outcome.',
  };

  it('accepts a pair that is in the approved taxonomy', async () => {
    const r = await classifyPromise('x', fetcherReturning(validPair));
    expect(r.inTaxonomy).toBe(true);
    expect(r.model).toBe('claude-haiku-4-5');
  });

  it('CATCHES the exact drift the old taxonomy.json encoded', async () => {
    // "Healthcare" instead of "Health Care" — the precise fabrication that sat
    // in taxonomy.json for weeks. If the check cannot catch this, it is useless.
    const r = await classifyPromise(
      'x',
      fetcherReturning({ ...validPair, primary_issue: 'Healthcare' }),
    );
    expect(r.inTaxonomy).toBe(false);
  });

  it('catches a plausible-but-invented sub-issue', async () => {
    const r = await classifyPromise(
      'x',
      fetcherReturning({ ...validPair, sub_issue: 'Drug Pricing' }),
    );
    expect(r.inTaxonomy).toBe(false);
  });

  it('treats is_evaluable:false as in-taxonomy without a pair', async () => {
    // Refusing to classify is the CORRECT answer for a vague statement, not a
    // failure — forcing a pair would inject that subject into the query.
    const r = await classifyPromise(
      'Washington is broken.',
      fetcherReturning({ is_evaluable: false, primary_issue: '', sub_issue: '' }),
    );
    expect(r.inTaxonomy).toBe(true);
  });

  it('reports drift rather than snapping to the nearest valid pair', async () => {
    const r = await classifyPromise(
      'x',
      fetcherReturning({ ...validPair, primary_issue: 'Healthcare' }),
    );
    // The near-miss is preserved verbatim. Auto-correcting here would hide the
    // very drift the check measures.
    expect(r.input.primary_issue).toBe('Healthcare');
  });

  it('refuses to classify without a key rather than guessing', async () => {
    await expect(classifyPromise('x')).rejects.toBeInstanceOf(ClassifyUnavailableError);
  });

  it('offers the model a menu that is entirely in-taxonomy', () => {
    // Verifiable with no key: every pair the classifier is SHOWN must be valid,
    // or the prompt itself is inviting the drift the check then flags.
    const menu = CLASSIFY_SYSTEM_PROMPT;
    let primary = '';
    let checked = 0;
    for (const line of menu.split('\n')) {
      const p = /^\*\*(.+)\*\*$/.exec(line);
      if (p) { primary = p[1]!; continue; }
      const sub = /^ {2}- (.+)$/.exec(line);
      if (sub && primary) {
        expect(isValidCombination(primary, sub[1]!)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(121);
  });
});

// ===========================================================================
// Regression: the classify call must not inherit the loop's max_tokens.
//
// It did, and it made every live classification fail with "Streaming is
// required for operations that may take longer than 10 minutes" — the SDK
// refusing a non-streamed request with a 64000 ceiling. The two calls have
// different shapes and cannot share a budget.
// ===========================================================================

describe('classify max_tokens is independent of the loop', () => {
  it('is small enough for a non-streaming request', async () => {
    const src = await readFile(
      new URL('./classify.ts', import.meta.url),
      'utf8',
    );
    const declared = /const CLASSIFY_MAX_TOKENS = (\d+);/.exec(src)?.[1];
    expect(declared, 'CLASSIFY_MAX_TOKENS must be declared').toBeDefined();
    expect(Number(declared)).toBeLessThanOrEqual(8000);
  });

  it('does not reference config.anthropic.maxTokens', async () => {
    // The loop's ceiling is sized for a streamed turn sharing budget with
    // adaptive thinking. Reusing it here is the exact bug this guards.
    const src = await readFile(new URL('./classify.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/max_tokens:\s*config\.anthropic\.maxTokens/);
  });
});

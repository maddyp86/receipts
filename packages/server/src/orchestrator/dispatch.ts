import {
  BANNED_LEVEL1_TERMS,
  BANNED_MOTIVE_TERMS,
  fail,
  ok,
  type Envelope,
  type Explanation,
  type Interpretation,
  type MatchedAction,
  type ScoredResult,
  type Senator,
  type Stance,
  type PromiseType,
} from '@receipts/shared';
import { senatorCache } from '../data/SenatorCache.js';
import { queueStore } from '../data/QueueStore.js';
import { actionStore, embedder } from '../services.js';
import { buildPromiseEmbeddingText } from '../embeddings/promiseEmbeddingText.js';
import { isValidCombination, lookupTaxonomyKeywords } from '../embeddings/taxonomy.js';
import { evaluateRelevance, type RelevanceCandidate } from '../evaluation/relevance.js';
import { applyEvidenceGate, describeExclusions } from '../evaluation/evidenceGate.js';
import {
  evaluateFulfillment,
  type FulfillmentCandidate,
} from '../evaluation/fulfillment.js';
import { liveResponsesFetcher } from '../evaluation/responsesFetcher.js';
import { preEvaluatorGates, type GateResult } from '../evaluation/preEvaluatorGates.js';
import { enrichmentSource, type ActionEnrichment } from '../evaluation/enrichment.js';
import { judgeGates } from '../judge/judgeGates.js';
import { judgeErrorVerdict, judgeVerdict, type JudgeFetcher, type JudgeVerdict } from '../judge/judge.js';
import {
  applyDispositionToResult,
  applyJudgeVerdict,
  type DispositionResult,
} from '../judge/dispositions.js';
import { classifyPromise, type ClassifyFetcher } from '../evaluation/classify.js';
import type { CorrectionDelta, Corrections } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../scoring/score.js';
import { config } from '../config.js';

// ===========================================================================
// Tool handlers.
//
// Every handler returns an envelope. Nothing throws into a dead end: an
// unreachable backend, a taxonomy miss, a thin result and a bad argument are
// all structured outcomes the loop and the UI can render honestly.
// ===========================================================================

/** Per-query state. The model passes judgements; the server holds the facts. */
export interface QuerySession {
  politicianId: string;
  promiseText: string;
  senator?: Senator;
  uncached: boolean;
  queued: boolean;
  interpretation?: Interpretation;
  embeddingText?: string;
  vector?: number[];
  matches?: MatchedAction[];
  scored?: ScoredResult;
  explanation?: Explanation;
  /** The frozen QueryResult exactly as emitted, for persistence. */
  result?: import('@receipts/shared').QueryResult;
  /** Evidence-gate outcome from search_actions, for the trace. */
  relevance?: import('../evaluation/evidenceGate.js').EvidenceGateResult;
  /**
   * EVERY evaluated candidate, admitted or not.
   *
   * The gate reports rejections as counts by reason, not rows, so without this
   * the non-matches are aggregated away before anything can store them — and
   * "retrieval found nothing" becomes indistinguishable from "the gate rejected
   * everything".
   */
  evaluated?: import('../evaluation/relevance.js').EvaluatedCandidate[];
  /** The orchestrating model's advisory effects, kept as the evaluator cross-check. */
  orchestratorEffects?: Record<string, string>;
  /** Pre-filter retrieval counts, so an empty result set is diagnosable. */
  retrieval?: { returned: number; belowFloor: number; topScore: number | null; topK: number };
  /** Candidates dropped at the WEAK floor, kept so a near-miss set is reviewable. */
  nearMisses?: Array<{ action_uid: string; bill_id: string; title: string; score: number }>;
  /** Fulfillment results keyed by action_uid, from evaluate_effects. */
  fulfillment?: Record<string, import('../evaluation/fulfillment.js').FulfillmentResult>;
  /** Injected in tests/fixtures; live path builds its own. */
  relevanceFetcher?: import('../evaluation/relevance.js').ResponsesFetcher;
  fulfillmentFetcher?: import('../evaluation/fulfillment.js').ResponsesFetcher;
  classifyFetcher?: ClassifyFetcher;
  /** User corrections applied on top of the classifier's output. */
  corrections?: Corrections;
  /** Set when the dedicated classifier disagreed with the orchestrator. */
  classifyDisagreements?: string[];
  /**
   * ISO date the statement was made, when the user supplied one.
   *
   * Load-bearing for scope: `valid_until` on a relative window ("next week") is
   * derived from it, and without it a bounded statement resolves to UNKNOWN and
   * halts the query rather than being tested against an unknown window.
   */
  statementDate?: string;
  /** Statement scope classification — runs before retrieval, can halt. */
  scope?: import('@receipts/shared').ScopeClassification;
  /**
   * Set when scope classification could not run at all.
   *
   * Fails OPEN, loudly. The gates already tolerate absent scope data (fix/03
   * fails open on every missing input), so the query proceeds — but the flag
   * travels with it so a result computed without scope data is never mistaken
   * for one that passed the scope checks.
   */
  scopeUnavailable?: string;
  /** Pre-evaluator gate outcome per action_uid, scorable or not. */
  gates?: Record<string, GateResult>;
  /**
   * Actions a gate closed before the evaluator ran.
   *
   * Kept SEPARATE from scored evidence rather than dropped: fix/08 says a gated
   * row is displayed with its reason. "Not evaluated: leader procedural vote"
   * is useful to a reader, and it is the thing that makes the tool look honest
   * rather than thin.
   */
  gated?: Array<{
    action_uid: string;
    bill_id: string;
    title: string;
    verdict: string;
    reason: string;
  }>;
  /** Which enrichment source the gates ran against, for the degradation notice. */
  enrichmentKind?: 'mirror' | 'null';
  /** The adversarial judge's verdict and disposition, when it ran. */
  judge?: { verdict: JudgeVerdict; disposition: DispositionResult };
  /** Injected in tests; the live path builds its own. */
  judgeFetcher?: JudgeFetcher;
}

export function newSession(
  politicianId: string,
  promiseText: string,
  corrections?: Corrections,
  statementDate?: string,
): QuerySession {
  return {
    politicianId,
    promiseText,
    corrections,
    statementDate,
    uncached: false,
    queued: false,
  };
}

const lower = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------------------

async function interpretPromise(
  session: QuerySession,
  modelInput: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  // ---- CLASSIFICATION LEG ------------------------------------------------
  // The dedicated classifier on config.models.classify decides; the
  // orchestrating model's classification is a CROSS-CHECK. Same shape as the
  // fulfillment leg, and for the same reason in a different place: the stored
  // corpus labels came from one classifier, and a second one drifting to a
  // neighbouring sub-issue silently moves the query vector.
  //
  // Disagreements are recorded and surfaced, never resolved quietly.
  const classifyFetcher = session.classifyFetcher;
  let input = modelInput;
  const disagreements: string[] = [];

  if (classifyFetcher || config.anthropic.apiKey) {
    try {
      const classified = await classifyPromise(session.promiseText, classifyFetcher);

      // Reported, not repaired. Snapping an off-taxonomy pair to the nearest
      // valid one would hide the drift the 12-row check exists to measure.
      if (!classified.inTaxonomy) {
        return fail({
          code: 'INTERNAL',
          message:
            `The classifier (${classified.model}) returned an issue pair outside the approved ` +
            `taxonomy: "${String(classified.input.primary_issue)} / ${String(classified.input.sub_issue)}". ` +
            `Refusing to snap it to a neighbour — an invented pair moves the query vector.`,
          recoverable: true,
          details: { model: classified.model, returned: classified.input },
        });
      }

      for (const field of ['primary_issue', 'sub_issue', 'stance', 'promise_type'] as const) {
        const mine = String(modelInput[field] ?? '').trim();
        const theirs = String(classified.input[field] ?? '').trim();
        if (mine && theirs && mine !== theirs) {
          disagreements.push(`${field}: orchestrator said "${mine}", classifier said "${theirs}" (classifier wins)`);
        }
      }

      input = { ...modelInput, ...classified.input };
    } catch (err) {
      // A classifier failure must NOT silently fall back to the orchestrator's
      // guess — that would quietly run the query on an unrouted model and make
      // any parity measurement meaningless.
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: `Classification failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      });
    }
  }

  session.classifyDisagreements = disagreements;

  // ---- USER CORRECTIONS --------------------------------------------------
  // Applied LAST, on top of the classifier, because the user is correcting what
  // the classifier produced and must win over it.
  //
  // Every field here is inside the embedded text built below, so a correction
  // moves the query vector and the whole query re-runs from embedding. There is
  // no path that reuses the previous candidate set — that is the point.
  const corrections = session.corrections;
  const deltas: CorrectionDelta[] = [];
  let userAssertedPremise = false;

  if (corrections) {
    for (const field of ['primary_issue', 'sub_issue', 'stance', 'promise_type'] as const) {
      const supplied = corrections[field];
      if (supplied === undefined || supplied === null || String(supplied).trim() === '') continue;
      const before = String(input[field] ?? '').trim();
      const after = String(supplied).trim();
      if (before !== after) deltas.push({ field, from: before, to: after });
      input = { ...input, [field]: after };
    }

    if (Array.isArray(corrections.key_policy_terms)) {
      const before = (Array.isArray(input.key_policy_terms) ? input.key_policy_terms : [])
        .map(String)
        .join(', ');
      const after = corrections.key_policy_terms.map(String).join(', ');
      if (before !== after) deltas.push({ field: 'key_policy_terms', from: before, to: after });
      input = { ...input, key_policy_terms: corrections.key_policy_terms };
    }

    if (corrections.assert_campaign_promise) {
      // Gated. Without the flag the assertion is IGNORED rather than partially
      // honoured — a half-applied override would render promise vocabulary with
      // no attribution, which is the exact failure the flag exists to prevent.
      if (!config.features.campaignPromiseOverride) {
        return fail({
          code: 'BAD_INPUT',
          message:
            'The Campaign Promise override is not enabled in this deployment. The ' +
            'result stays in alignment language.',
          recoverable: true,
        });
      }
      userAssertedPremise = true;
      deltas.push({ field: 'statement_type', from: 'Policy Position', to: 'Campaign Promise' });
    }
  }

  const primary_issue = String(input.primary_issue ?? '').trim();
  const sub_issue = String(input.sub_issue ?? '').trim();
  const isEvaluable = input.is_evaluable !== false;

  // A promise judged too vague to check is allowed to arrive without a
  // classification — forcing one would inject that subject's keywords into the
  // query and manufacture confident matches on a topic nobody asked about.
  if (isEvaluable && (!primary_issue || !sub_issue)) {
    return fail({
      code: 'BAD_INPUT',
      message:
        'primary_issue and sub_issue are required unless is_evaluable is false. If the promise is too vague to classify, set is_evaluable to false rather than guessing a category.',
      recoverable: true,
    });
  }

  // Keywords are a taxonomy lookup, never a generation — inventing them would
  // move the query vector away from the stored bill vectors.
  const { keywords, found } = lookupTaxonomyKeywords(primary_issue, sub_issue);
  const validCombination = isValidCombination(primary_issue, sub_issue);

  const interpretation: Interpretation = {
    raw: session.promiseText,
    // Free-typed text until a provenance lookup or a user assertion says
    // otherwise. Never inferred from the wording.
    statement_type: userAssertedPremise ? 'Campaign Promise' : 'Policy Position',
    // 'asserted' — the premise is the USER's, not evidence we hold. This value
    // is what every downstream surface keys the attribution off.
    provenance: userAssertedPremise ? 'asserted' : 'default',
    user_asserted_premise: userAssertedPremise || undefined,
    corrections_applied: deltas.length ? deltas : undefined,
    restated: String(input.restated ?? session.promiseText).trim(),
    primary_issue,
    sub_issue,
    stance: (String(input.stance ?? 'Neutral/Unclear') as Stance) ?? 'Neutral/Unclear',
    promise_type: (String(input.promise_type ?? 'policy') as PromiseType) ?? 'policy',
    is_evaluable: isEvaluable,
    key_policy_terms: Array.isArray(input.key_policy_terms)
      ? input.key_policy_terms.map(String)
      : [],
    taxonomy_keywords: keywords,
    reasoning: String(input.reasoning ?? '').trim(),
  };

  session.interpretation = interpretation;
  session.embeddingText = buildPromiseEmbeddingText({
    statement: interpretation.raw,
    stance: interpretation.stance,
    promise_type: interpretation.promise_type,
    primary_issue,
    sub_issue,
    key_policy_terms: interpretation.key_policy_terms,
    taxonomy_keywords: keywords,
    reasoning: interpretation.reasoning,
  });

  return ok({
    interpretation,
    taxonomy_match: validCombination,
    // The model is told plainly that its own classification was advisory, so
    // it narrates the classification that actually drove retrieval.
    classification_source: session.classifyDisagreements
      ? `dedicated classifier (${config.models.classify})`
      : 'orchestrator (no classifier configured)',
    classification_disagreements: session.classifyDisagreements ?? [],
    // Surfaced to the model so it knows the retrieval will be weaker, without
    // giving it licence to invent keywords to compensate.
    note: found
      ? undefined
      : `No approved-taxonomy row for "${primary_issue} / ${sub_issue}", so no bridging keywords were added. Retrieval may be weaker. Do not invent keywords.`,
  });
}

// ---------------------------------------------------------------------------

async function resolveSenator(
  session: QuerySession,
  input: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  const id = String(input.politician_id ?? session.politicianId).trim();
  const senator = senatorCache.resolve(id);

  if (!senator) {
    return fail({
      code: 'BAD_INPUT',
      message: `Unknown senator id "${id}".`,
      recoverable: false,
    });
  }

  session.senator = senator;
  session.uncached = !senator.cached;

  if (!senator.cached) {
    return ok({
      cached: false,
      senator,
      instruction:
        'This senator has not been analysed. Stop here, call queue_senator, and tell the user honestly. Do not answer from general knowledge.',
    });
  }

  return ok({ cached: true, senator });
}

// ---------------------------------------------------------------------------

async function embedText(session: QuerySession): Promise<Envelope<unknown>> {
  if (!session.embeddingText) {
    return fail({
      code: 'BAD_INPUT',
      message: 'Call interpret_promise before embed_text.',
      recoverable: true,
    });
  }

  const result = await embedder.embed(session.embeddingText);
  if (!result.ok) return result;

  session.vector = result.data;
  return ok({
    dimensions: result.data.length,
    model: config.embeddings.model,
    // Echoed back so the analyst trace can show exactly what was embedded.
    embedded_text: session.embeddingText,
  });
}

// ---------------------------------------------------------------------------
// Candidate builders.
//
// Field names mirror W7a's `Parse and Store Matches` and WF10A's evaluator
// input so the app leg and the pipeline leg stay diff-able. Everything here
// comes from Pinecone vector metadata plus the classified query — no sheet
// reads on the request path.
// ---------------------------------------------------------------------------

const boolStr = (v: unknown): string =>
  v === true ? 'TRUE' : v === false ? 'FALSE' : String(v ?? 'NA');

function toRelevanceCandidate(session: QuerySession, m: MatchedAction): RelevanceCandidate {
  const c = session.interpretation!;
  return {
    promise_uid: 'QUERY',
    promise_text: session.promiseText,
    promise_stance: c.stance,
    promise_type: c.promise_type,
    promise_primary_issue: c.primary_issue,
    promise_sub_issue: c.sub_issue,
    key_policy_terms: Array.isArray(c.key_policy_terms)
      ? c.key_policy_terms.join(', ')
      : String(c.key_policy_terms ?? ''),
    promise_date: '',

    bill_id: m.bill_id ?? '',
    bill_title: m.title ?? '',
    bill_summary: m.summary ?? '',
    bill_intended_effects: m.intended_effects,
    bill_mechanisms: m.mechanisms,
    bill_primary_issue: m.primary_issue ?? '',
    bill_sub_issue: m.sub_issue ?? '',
    action_uid: m.action_uid,

    is_sponsor: boolStr(m.is_sponsor),
    is_cosponsor: boolStr(m.is_cosponsor),
    vote: m.vote ?? 'NA',
    vote_id: '',
    cloture_vote: m.cloture_vote,
    passage_vote: m.passage_vote,

    similarity_score: m.score,
    match_direction: 'promise_to_bill',
    match_rank: 0,
  };
}

function toFulfillmentCandidate(session: QuerySession, m: MatchedAction): FulfillmentCandidate {
  const c = session.interpretation!;
  return {
    // Drives the verdict vocabulary AND the prompt's -0.1 confidence penalty,
    // which the evaluator applies per its system prompt. Never re-applied here.
    statement_type: c.statement_type,
    promise_uid: 'QUERY',
    promise_text: session.promiseText,
    promise_stance: c.stance,
    promise_primary_issue: c.primary_issue,
    promise_sub_issue: c.sub_issue,

    bill_id: m.bill_id ?? '',
    action_uid: m.action_uid,
    bill_title: m.title ?? '',
    bill_summary: m.summary ?? '',
    bill_primary_issue: m.primary_issue ?? '',
    bill_sub_issue: m.sub_issue ?? '',
    bill_intended_effects: m.intended_effects,
    bill_mechanisms: m.mechanisms,
    affected_stakeholders: m.affected_stakeholders
      ? [{ stakeholder_group: 'All', positive_impacts: m.affected_stakeholders }]
      : undefined,

    vote: m.vote ?? 'NA',
    cloture_vote: m.cloture_vote,
    passage_vote: m.passage_vote,
    is_sponsor: boolStr(m.is_sponsor),
    is_cosponsor: boolStr(m.is_cosponsor),

    // ---- v7 context.
    //
    // Scope fields come from the live classifier. Everything below them —
    // vote dates, whip vote, cloture result, senator role, action date — needs
    // the enrichment reader, which needs the Supabase mirror, which is not
    // synced (verified 2026-09-07: every mirror table has zero rows). They are
    // deliberately left undefined so the v7 template renders its explicit
    // UNKNOWN / NA markers. The prompt treats an absent field as "not
    // established", never as the permissive value, so this degrades the
    // evaluator's confidence rather than its correctness.
    promise_date: session.statementDate,
    scope: session.scope?.scope,
    valid_until: session.scope?.valid_until,
    anchor_entity: session.scope?.anchor_entity,
    role_condition: session.scope?.role_condition,
    bill_congress: congressOf(m.bill_id ?? ''),
  };
}

/** '…-119' -> '119'. The Congress is encoded in the bill id and nowhere else. */
function congressOf(billId: string): string {
  return /-(\d{3})$/.exec(String(billId ?? '').trim())?.[1] ?? '';
}

// ---------------------------------------------------------------------------

async function searchActions(session: QuerySession): Promise<Envelope<unknown>> {
  if (!session.vector || !session.senator) {
    return fail({
      code: 'BAD_INPUT',
      message: 'Call embed_text and resolve_senator before search_actions.',
      recoverable: true,
    });
  }

  const result = await actionStore.search({
    politicianId: session.senator.politician_id,
    vector: session.vector,
    queryText: session.embeddingText ?? session.promiseText,
    topK: config.retrieval.topK,
  });
  if (!result.ok) return result;

  const candidatesIn = result.data.matches;
  // Pre-filter counts, kept so an empty result is diagnosable: "the namespace
  // is thin" and "nothing in it was similar enough" are different problems and
  // the survivor count alone cannot tell them apart.
  session.retrieval = {
    returned: result.data.returned,
    belowFloor: result.data.belowFloor,
    topScore: result.data.topScore,
    topK: config.retrieval.topK,
  };
  session.nearMisses = result.data.nearMisses;

  // ---- RELEVANCE LEG ----------------------------------------------------
  // Skipped when there is no evaluator to call. This is NOT a silent bypass:
  // without a key every candidate would come back ERROR, the gate would admit
  // zero, and the tool would report "nothing in his record bears on this" — a
  // finding, produced by a missing credential. Skipping and labelling it is the
  // honest failure mode; the response carries relevance_applied: false so the
  // model and the UI both know the filter did not run.
  const canEvaluateRelevance = Boolean(session.relevanceFetcher) || Boolean(config.embeddings.apiKey);

  if (!canEvaluateRelevance) {
    session.matches = candidatesIn;
    return ok({
      retrieved: candidatesIn.length,
      relevance_applied: false,
      relevance_note:
        'Relevance evaluation did not run (no OpenAI credential). These are raw retrieval ' +
        'matches above the similarity floor, NOT relevance-checked evidence. Say so if you ' +
        'describe them.',
      count: candidatesIn.length,
      matches: candidatesIn.map((m) => ({
        action_uid: m.action_uid,
        title: m.title,
        bill_number: m.bill_number,
        bill_type: m.bill_type,
        summary: m.summary,
        intended_effects: m.intended_effects,
        mechanisms: m.mechanisms,
        affected_stakeholders: m.affected_stakeholders,
        primary_issue: m.primary_issue,
        sub_issue: m.sub_issue,
        missing_fields: m.missing_fields,
      })),
    });
  }

  // Retrieval returns everything above the WEAK floor; cosine similarity alone
  // cannot tell "about this promise" from "shares vocabulary with it". The
  // relevance evaluator is what makes that call, and the evidence gate is what
  // admits TRUE_POSITIVE and PARTIAL/SPECIFICITY only.
  //
  // Runs BEFORE the model sees anything, so the model never judges effect on a
  // bill the gate would have excluded.
  const relevanceFetcher = session.relevanceFetcher ?? liveResponsesFetcher('relevance');
  const evaluated = await evaluateRelevance(
    candidatesIn.map((m) => toRelevanceCandidate(session, m)),
    relevanceFetcher,
  );

  const gate = applyEvidenceGate(evaluated);
  session.evaluated = evaluated;

  // ASSERTION — admitted ≤ candidates.
  // A gate that returns more rows than it was given has duplicated evidence,
  // which inflates the match count the band is computed from. Cheap to check,
  // and the failure it catches is invisible in the output.
  if (gate.admitted.length > candidatesIn.length) {
    return fail({
      code: 'INTERNAL',
      message:
        `Evidence gate admitted ${gate.admitted.length} rows from ${candidatesIn.length} ` +
        `candidates. Admitted can never exceed candidates.`,
      recoverable: false,
    });
  }

  const admittedUids = new Set(gate.admitted.map((c) => String(c.action_uid ?? '')));
  session.matches = candidatesIn.filter((m) => admittedUids.has(m.action_uid));
  session.relevance = gate;

  // The model needs enough to judge effect, and nothing that would let it
  // shortcut to a verdict — so no scores and no vote fields are sent back here.
  //
  // `retrieved` vs `count` is load-bearing copy: "10 retrieved, 0 admitted"
  // is a different claim from "0 retrieved", and an empty admitted set must
  // never be narrated as "no legislative activity".
  return ok({
    retrieved: candidatesIn.length,
    relevance_applied: true,
    excluded: describeExclusions(gate.dropped),
    count: session.matches.length,
    matches: session.matches.map((m) => ({
      action_uid: m.action_uid,
      title: m.title,
      bill_number: m.bill_number,
      bill_type: m.bill_type,
      summary: m.summary,
      intended_effects: m.intended_effects,
      mechanisms: m.mechanisms,
      affected_stakeholders: m.affected_stakeholders,
      primary_issue: m.primary_issue,
      sub_issue: m.sub_issue,
      missing_fields: m.missing_fields,
    })),
  });
}

// ---------------------------------------------------------------------------

async function evaluateEffectsTool(
  session: QuerySession,
  input: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  if (!session.interpretation) {
    return fail({
      code: 'BAD_INPUT',
      message: 'Call interpret_promise before evaluate_effects.',
      recoverable: true,
    });
  }

  // Scoring zero matches is a real branch, not an error state — it is how
  // "we found nothing" becomes an honest NOT_DETERMINABLE rather than a crash.
  const matches = session.matches ?? [];

  const effects = Array.isArray(input.effects) ? input.effects : [];
  const byUid = new Map<string, { bill_effect: string; bill_effect_reasoning: string }>();
  for (const e of effects) {
    const row = e as Record<string, unknown>;
    const uid = String(row.action_uid ?? '');
    if (uid) {
      byUid.set(uid, {
        bill_effect: String(row.bill_effect ?? 'NEUTRAL').toUpperCase(),
        bill_effect_reasoning: String(row.bill_effect_reasoning ?? ''),
      });
    }
  }

  // ---- PRE-EVALUATOR GATES ----------------------------------------------
  //
  // fix/03, run BEFORE the evaluator so a gated row never costs a model call
  // and never produces a verdict. Every rule FAILS OPEN when its inputs are
  // missing, so a thin enrichment layer degrades the gates rather than
  // dropping statements.
  //
  // Gated rows are kept and displayed with their reason, not hidden. They are
  // excluded from scoring because their verdict is terminal and deterministic —
  // routing them through the alignment table would ask "which way does this
  // cut" about an action we have already established cannot cut either way.
  const refs = await enrichmentSource.refs();
  const enrichment = await enrichmentSource.forActions(matches.map((m) => m.action_uid));
  session.enrichmentKind = enrichmentSource.kind;

  const gates: Record<string, GateResult> = {};
  const scorableMatches: MatchedAction[] = [];
  const gatedRows: NonNullable<QuerySession['gated']> = [];

  for (const m of matches) {
    const e: ActionEnrichment = enrichment.get(m.action_uid) ?? {};
    const result = preEvaluatorGates(
      {
        politician_id: session.politicianId,
        bill_id: String(m.bill_id ?? ''),
        promise_text: session.promiseText,
        bill_title: String(m.title ?? ''),
        // Pinecone carries the votes; enrichment carries the context around
        // them. Where both exist the mirror wins — it has the dates.
        cloture_vote: e.cloture_vote ?? m.cloture_vote,
        passage_vote: e.passage_vote ?? m.passage_vote,
        party_whip_vote: e.party_whip_vote,
        cloture_vote_id: e.cloture_vote_id,
        cloture_vote_date: e.cloture_vote_date,
        passage_vote_date: e.passage_vote_date,
        stakeholder_groups: m.affected_stakeholders ? [String(m.affected_stakeholders)] : [],
      },
      {
        date: session.statementDate ? new Date(session.statementDate) : null,
        scope: session.scope?.scope,
        validUntil: session.scope?.valid_until ? new Date(session.scope.valid_until) : null,
        validUntilRaw: session.scope?.valid_until,
        anchor: session.scope?.anchor_entity,
        roleCondition: session.scope?.role_condition,
        speechAct: session.scope?.speech_act,
      },
      refs,
    );
    gates[m.action_uid] = result;
    if (result.scorable) {
      scorableMatches.push(m);
    } else {
      gatedRows.push({
        action_uid: m.action_uid,
        bill_id: String(m.bill_id ?? ''),
        title: String(m.title ?? ''),
        verdict: String(result.hit!.verdict),
        reason: result.hit!.reason,
      });
    }
  }
  session.gates = gates;
  session.gated = gatedRows;

  // ---- FULFILLMENT LEG --------------------------------------------------
  // bill_effect is decided by gpt-5.4-mini running WF10A's 32,507-char prompt,
  // NOT by the orchestrating model. The corpus was scored by that model on that
  // prompt, and this is the axis where disagreement is most damaging: it picks
  // ADVANCE/HINDER, and the verdict follows directly. Two different models
  // judging effect is how the query tool and the trust report end up printing
  // different answers for the same senator on the same bill.
  //
  // The model's own `effects` are still collected — as a CROSS-CHECK, not as
  // the source of truth. A disagreement is recorded and surfaced rather than
  // silently resolved in either direction.
  // Same rule as the relevance leg: no evaluator means the leg is SKIPPED and
  // labelled, never silently turned into ERROR (which would freeze every row)
  // or into NEUTRAL (which would read as "no bill bears on this"). Without a
  // credential the orchestrator's own advisory effects are all we have, and the
  // response says exactly that.
  const canEvaluateFulfillment =
    Boolean(session.fulfillmentFetcher) || Boolean(config.embeddings.apiKey);

  const evaluated =
    scorableMatches.length && canEvaluateFulfillment
      ? await evaluateFulfillment(
          scorableMatches.map((m) => toFulfillmentCandidate(session, m)),
          session.fulfillmentFetcher ?? liveResponsesFetcher('fulfillment'),
        )
      : [];

  const authoritative = new Map(evaluated.map((e) => [e.action_uid, e.result]));
  session.fulfillment = Object.fromEntries(authoritative);
  // WF10A records this as Model Verdict / Model Agreed. Kept so a disagreement
  // between the orchestrator and the evaluator is reviewable later, not just
  // resolved silently in the evaluator's favour at request time.
  session.orchestratorEffects = Object.fromEntries(
    [...byUid.entries()].map(([uid, j]) => [uid, j.bill_effect]),
  );

  const disagreements: string[] = [];

  const scorable: ScorableMatch[] = scorableMatches.map((m) => {
    const judged = byUid.get(m.action_uid);
    const evalResult = authoritative.get(m.action_uid);

    if (judged && evalResult && evalResult.bill_effect !== 'ERROR') {
      if (judged.bill_effect !== evalResult.bill_effect) {
        disagreements.push(
          `${m.action_uid}: orchestrator said ${judged.bill_effect}, ` +
            `fulfillment evaluator said ${evalResult.bill_effect} (evaluator wins)`,
        );
      }
    }

    // An evaluator ERROR stays ERROR — it must NOT collapse to NEUTRAL.
    // NEUTRAL is a finding ("this bill does not bear on the goal"); ERROR is
    // the absence of one. deriveAlignment routes ERROR to the ERROR outcome,
    // which freezes rather than scoring.
    //
    // When the evaluator never ran at all, the orchestrator's advisory effect
    // is used instead — that is a labelled degradation, not a silent one.
    const effect = canEvaluateFulfillment
      ? (evalResult ? evalResult.bill_effect : ('ERROR' as const))
      : ((judged?.bill_effect as ScorableMatch['bill_effect']) ?? 'NEUTRAL');

    return {
      ...m,
      bill_effect: effect as ScorableMatch['bill_effect'],
      bill_effect_reasoning:
        evalResult?.reasoning ||
        judged?.bill_effect_reasoning ||
        'The fulfillment evaluator returned no judgement for this action.',
      // Passed through uncapped. scoreMatches applies the split-vote cap, so
      // the cap is enforced in exactly one place regardless of caller.
      // Null rather than 0 when no evaluator ran: 0 is a confidence, absence
      // is not (handoff v2 §3).
      alignment_confidence: evalResult ? evalResult.confidence : null,
    };
  });

  const scored = scoreMatches({
    promise_type: session.interpretation.promise_type,
    statement_type: session.interpretation.statement_type,
    is_evaluable: session.interpretation.is_evaluable,
    matches: scorable,
  });
  session.scored = scored;

  // ---- THE ADVERSARIAL JUDGE ---------------------------------------------
  //
  // handoff v2 §5, answered for the query path: the deterministic gates run on
  // every query because they are free; the LLM judge runs ONLY when the derived
  // verdict is an accusation. That is the minority of queries and exactly where
  // the risk is — a free-typed statement gets no human review at all, so the
  // one reading that could damage someone gets a second opinion.
  //
  // It runs AFTER scoring because it grades a verdict, which means one has to
  // exist first. scoreMatches is pure by design, so the model call cannot live
  // inside it.
  //
  // Asymmetric, like contract 3: this can only ever withhold an accusation.
  const isAccusation = scored.verdict === 'BROKE';
  const canJudge = Boolean(session.judgeFetcher) || Boolean(config.anthropic.apiKey);

  if (isAccusation && canJudge) {
    // The strongest breaking action is what the accusation rests on, so it is
    // what gets reviewed — the same choice contract 3 makes, and for the same
    // reason: weak corroboration must not decide the fate of a sound reading.
    const breaking = scored.evidence
      .filter((e) => e.direction === 'breaks')
      .sort((a, b) => (b.alignment_confidence ?? 0) - (a.alignment_confidence ?? 0));
    const lead = breaking[0];

    if (lead) {
      const gate = session.gates?.[lead.action_uid];
      const f = session.fulfillment?.[lead.action_uid];
      const enriched = (await enrichmentSource.forActions([lead.action_uid])).get(lead.action_uid) ?? {};

      // The judge's own deterministic layer runs first and is passed in, so the
      // model confirms or disputes those hits rather than re-deriving them.
      const jg = judgeGates({
        promise_alignment: String(lead.outcome),
        bill_effect: String(lead.bill_effect),
        alignment_confidence: lead.alignment_confidence,
        politician_id: session.politicianId,
        bill_id: String(lead.bill_id ?? ''),
        promise_text: session.promiseText,
        bill_title: String(lead.title ?? ''),
        stakeholder_group: lead.affected_stakeholders ?? null,
        cloture_vote: enriched.cloture_vote ?? lead.cloture_vote,
        passage_vote: enriched.passage_vote ?? lead.passage_vote,
        vote: lead.vote,
        party_whip_vote: enriched.party_whip_vote ?? null,
        is_sponsor: lead.is_sponsor,
        is_cosponsor: lead.is_cosponsor,
        cloture_vote_date: enriched.cloture_vote_date ?? null,
        passage_vote_date: enriched.passage_vote_date ?? null,
        action_date: enriched.action_date ?? null,
        alignment_reasoning: f?.reasoning ?? null,
        bill_effect_reasoning: lead.bill_effect_reasoning,
        vote_flags: lead.vote_flags,
        senator_role: gate?.context.senator_role ?? null,
        cloture_result: gate?.context.cloture_result ?? null,
        scope: session.scope?.scope ?? null,
        valid_until: session.scope?.valid_until ?? null,
        statement_date: session.statementDate ?? null,
        promise_primary_issue: session.interpretation.primary_issue,
        promise_sub_issue: session.interpretation.sub_issue,
        bill_primary_issue: lead.primary_issue,
        bill_sub_issue: lead.sub_issue,
      });

      const verdict = await judgeVerdict(
        {
          statement_text: session.promiseText,
          statement_type: session.interpretation.statement_type,
          scope: session.scope?.scope ?? null,
          valid_until: session.scope?.valid_until ?? null,
          anchor_entity: session.scope?.anchor_entity ?? null,
          role_condition: session.scope?.role_condition ?? null,
          promise_date: session.statementDate ?? null,
          bill_id: String(lead.bill_id ?? ''),
          bill_title: String(lead.title ?? ''),
          bill_summary: lead.summary,
          bill_class: gate?.context.bill_class ?? null,
          intended_effects: lead.intended_effects,
          mechanisms: lead.mechanisms,
          stakeholders: lead.affected_stakeholders ?? null,
          cloture_vote: enriched.cloture_vote ?? lead.cloture_vote,
          cloture_vote_date: enriched.cloture_vote_date ?? null,
          cloture_result: gate?.context.cloture_result ?? null,
          passage_vote: enriched.passage_vote ?? lead.passage_vote,
          passage_vote_date: enriched.passage_vote_date ?? null,
          party_whip_vote: enriched.party_whip_vote ?? null,
          senator_role: gate?.context.senator_role ?? null,
          is_sponsor: String(lead.is_sponsor),
          is_cosponsor: String(lead.is_cosponsor),
          action_date: enriched.action_date ?? null,
          vote_flags: lead.vote_flags,
          vote_governing: lead.vote_governing,
          bill_effect: String(lead.bill_effect),
          bill_effect_reasoning: lead.bill_effect_reasoning,
          verdict: String(lead.outcome),
          alignment_reasoning: f?.reasoning ?? null,
          confidence: lead.alignment_confidence,
          gate_results: jg.fired,
        },
        session.judgeFetcher ?? undefined,
      );

      const disposition = applyJudgeVerdict(
        {
          verdict: lead.outcome,
          confidence: lead.alignment_confidence,
          reasoning: f?.reasoning ?? '',
        },
        verdict,
      );
      session.judge = { verdict, disposition };

      const judged = applyDispositionToResult(scored, disposition);
      if (judged.withheld) {
        session.scored = judged.result;
        console.info(`[judge] ${disposition.disposition} — accusation withheld: ${judged.reason}`);
      }
    }
  } else if (isAccusation && !canJudge) {
    // No credential means no second opinion. An unreviewed accusation is not
    // published — the same posture as JUDGE_ERROR, for the same reason.
    const verdict = judgeErrorVerdict('no judge credential configured');
    const disposition = applyJudgeVerdict(
      { verdict: 'BROKE', confidence: null, reasoning: '' },
      verdict,
    );
    session.judge = { verdict, disposition };

    const judged = applyDispositionToResult(scored, disposition);
    if (judged.withheld) {
      session.scored = judged.result;
      console.warn('[judge] no credential — accusation withheld rather than published unreviewed.');
    }
  }

  // Returned to the model as a FROZEN result. It explains this; it cannot
  // change it, and the value the user sees comes from `session.scored`
  // regardless of anything the model says next.
  return ok({
    verdict: scored.verdict,
    band: scored.band,
    mode: scored.mode,
    nd_reason: scored.nd_reason,
    ranked: scored.ranked,
    receipt: scored.receipt,
    evidence: scored.evidence.map((e) => ({
      action_uid: e.action_uid,
      title: e.title,
      bill_number: e.bill_number,
      bill_effect: e.bill_effect,
      outcome: e.outcome,
      direction: e.direction,
      action_tier: e.action_tier,
      vote_pattern: e.vote_pattern,
      vote: e.vote,
      cloture_vote: e.cloture_vote,
      passage_vote: e.passage_vote,
      is_sponsor: e.is_sponsor,
      is_cosponsor: e.is_cosponsor,
      bill_keywords: e.bill_keywords,
      scoring_flags: e.scoring_flags,
      // Disclosure (handoff v2 §4). The model is shown which vote governed and
      // whether the row was split so it cannot narrate "voted NAY" over a
      // cloture YEA it never saw.
      vote_governing: e.vote_governing,
      vote_flags: e.vote_flags,
      alignment_confidence: e.alignment_confidence,
    })),
    // Surfaced, not silently resolved. The evaluator's call is authoritative;
    // the model is told so explicitly so it does not narrate its own effect.
    // Gated rows are REPORTED, not hidden. "10 retrieved, 2 gated, 8 evaluated"
    // is a different claim from "8 retrieved", and the gate reasons are the
    // thing that makes a thin answer legible rather than evasive.
    gated: session.gated?.length ?? 0,
    gated_reasons: session.gated?.map((g) => ({ bill_id: g.bill_id, reason: g.reason })) ?? [],
    // Said plainly so the model never narrates a gate that could not run.
    enrichment: session.enrichmentKind === 'mirror'
      ? 'mirror (vote dates, whip votes and roles available)'
      : 'unavailable — scope and leader gates failed open',
    judge: session.judge
      ? {
          disposition: session.judge.disposition.disposition,
          withheld: session.judge.disposition.withheld,
          counterargument: session.judge.verdict.senator_counterargument || null,
        }
      : null,
    effect_source: canEvaluateFulfillment
      ? `fulfillment evaluator (${config.models.fulfill}, WF10A prompt)`
      : 'orchestrator (advisory only — no fulfillment evaluator configured)',
    effect_disagreements: disagreements,
    instruction:
      'This result is final. Explain it with explain_result; do not restate it differently. ' +
      'Where your own effect judgement differed from the evaluator, the evaluator governs.',
  });
}

// ---------------------------------------------------------------------------

/** Wording checks. Cheap, but they catch the failures that actually happen. */
function explanationProblems(why: string, verdict: string): string[] {
  const problems: string[] = [];
  const text = lower(why);

  for (const term of BANNED_LEVEL1_TERMS) {
    if (text.includes(lower(term))) {
      problems.push(`remove the word "${term}" — Level 1 carries no statistics`);
    }
  }
  for (const term of BANNED_MOTIVE_TERMS) {
    if (text.includes(lower(term))) {
      problems.push(`remove "${term}" — describe the behaviour, not the motive behind it`);
    }
  }

  // Contradiction guard. The rendered verdict always comes from the scoring
  // service, so this protects the prose from disagreeing with the label beside it.
  const saysKept = /\bkept (the|this|their) promise\b/.test(text);
  const saysBroke = /\b(broke|broken|did not keep|failed to keep)\b/.test(text);
  if (verdict === 'KEPT' && saysBroke && !saysKept) {
    problems.push('the verdict is KEPT but the explanation reads as broken');
  }
  if (verdict === 'BROKE' && saysKept && !saysBroke) {
    problems.push('the verdict is BROKE but the explanation reads as kept');
  }
  if (verdict === 'NOT_DETERMINABLE' && (saysKept || saysBroke)) {
    problems.push(
      'the verdict is NOT_DETERMINABLE — do not say the promise was kept or broken',
    );
  }

  return problems;
}

async function explainResult(
  session: QuerySession,
  input: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  if (!session.scored) {
    return fail({
      code: 'BAD_INPUT',
      message: 'Call evaluate_effects before explain_result.',
      recoverable: true,
    });
  }

  const why = String(input.why ?? '').trim();
  if (!why) {
    return fail({ code: 'BAD_INPUT', message: 'why is required.', recoverable: true });
  }

  const problems = explanationProblems(why, session.scored.verdict);
  if (problems.length) {
    return fail({
      code: 'BAD_INPUT',
      message: `The explanation needs a revision: ${problems.join('; ')}. Rewrite and call explain_result again.`,
      recoverable: true,
    });
  }

  const connectors: Record<string, string> = {};
  if (Array.isArray(input.connectors)) {
    for (const c of input.connectors) {
      const row = c as Record<string, unknown>;
      const uid = String(row.action_uid ?? '');
      const line = String(row.line ?? '').trim();
      if (uid && line) connectors[uid] = line;
    }
  }

  const explanation: Explanation = {
    why,
    connectors,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5,
  };
  session.explanation = explanation;

  return ok({ accepted: true });
}

// ---------------------------------------------------------------------------

async function queueSenator(session: QuerySession): Promise<Envelope<unknown>> {
  if (!session.senator) {
    return fail({
      code: 'BAD_INPUT',
      message: 'Call resolve_senator first.',
      recoverable: true,
    });
  }

  await queueStore.record({
    politician_id: session.senator.politician_id,
    senator_name: session.senator.name,
    promise_text: session.promiseText,
    requested_at: new Date().toISOString(),
  });
  session.queued = true;

  return ok({ queued: true });
}

// ---------------------------------------------------------------------------

const HANDLERS: Record<
  string,
  (session: QuerySession, input: Record<string, unknown>) => Promise<Envelope<unknown>>
> = {
  interpret_promise: interpretPromise,
  resolve_senator: resolveSenator,
  embed_text: (s) => embedText(s),
  search_actions: (s) => searchActions(s),
  evaluate_effects: evaluateEffectsTool,
  explain_result: explainResult,
  queue_senator: (s) => queueSenator(s),
};

/**
 * Run a tool. A thrown exception anywhere below becomes a structured envelope —
 * there is no path out of here that isn't reportable.
 */
export async function dispatchTool(
  session: QuerySession,
  name: string,
  input: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  const handler = HANDLERS[name];
  if (!handler) {
    return fail({ code: 'BAD_INPUT', message: `Unknown tool "${name}".`, recoverable: false });
  }

  try {
    return await handler(session, input ?? {});
  } catch (err) {
    console.error(`[tool:${name}]`, err);
    return fail({
      code: 'INTERNAL',
      message: `${name} failed unexpectedly.`,
      recoverable: true,
      details: { cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

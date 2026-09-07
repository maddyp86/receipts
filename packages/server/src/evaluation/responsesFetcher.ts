import { config } from '../config.js';
import type { ResponsesEnvelope, ResponsesRequestBody } from './relevance.js';

// ===========================================================================
// The /v1/responses transport, shared by the relevance and fulfillment legs.
//
// Both legs are dependency-injected on a fetcher so the whole evaluation path
// is testable on fixtures with no network and no key. That is deliberate: the
// build order has items 3–4 landing before OpenAI credentials exist.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a missing credential must read as
// MISSING, never as a result. A stub that returns a plausible-looking evaluation
// instead of signalling "no data" is the exact silent-success failure this
// project keeps guarding against — an empty or absent result must read as empty,
// never as a finding.
// ===========================================================================

export class MissingCredentialError extends Error {
  readonly code = 'MISSING_CREDENTIAL';
  constructor(what: string) {
    super(
      `${what} requires OPENAI_API_KEY, which is not set. Refusing to fabricate ` +
        `a result: run in FIXTURE_MODE for a canned path, or supply the key for a live one.`,
    );
    this.name = 'MissingCredentialError';
  }
}

/**
 * The live transport. Throws rather than returning an empty envelope on any
 * failure — callers turn a throw into a per-candidate ERROR result, which is a
 * distinct outcome from NEUTRAL and is surfaced, not averaged away.
 */
export function liveResponsesFetcher(label: string): (b: ResponsesRequestBody) => Promise<ResponsesEnvelope> {
  return async (body: ResponsesRequestBody): Promise<ResponsesEnvelope> => {
    const key = config.embeddings.apiKey; // same OpenAI credential as embeddings
    if (!key) throw new MissingCredentialError(label);

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `[${label}] /v1/responses returned ${res.status}. ${detail.slice(0, 300)}`,
      );
    }

    return (await res.json()) as ResponsesEnvelope;
  };
}

/**
 * Fixture transport. Looks up a canned envelope by action_uid.
 *
 * An unknown candidate THROWS. It does not return a default envelope — a
 * fixture set that silently answers for rows it has no data on would make a
 * gap in the fixtures look like a real evaluation, which is the same failure
 * as a stubbed live call.
 */
export function fixtureResponsesFetcher(
  envelopes: Record<string, ResponsesEnvelope>,
  label = 'fixture',
): (b: ResponsesRequestBody) => Promise<ResponsesEnvelope> {
  return async (body: ResponsesRequestBody): Promise<ResponsesEnvelope> => {
    const user = body.input.find((m) => m.role === 'user')?.content ?? '';
    // Keyed off the message because that is what the model actually receives —
    // a fixture keyed on the candidate object could pass while the payload was
    // built wrong.
    //
    // Evaluator v7 DROPPED `Action ID` from the user template (v6 carried it),
    // so Bill ID is the identifier now. Production does not depend on either:
    // `evaluateFulfillment` correlates results positionally. The action_uid
    // fallbacks are kept for fixtures written against the v6 shape.
    const uid =
      /- Bill ID: (\S+)/.exec(user)?.[1] ??
      /- Action ID: (\S+)/.exec(user)?.[1] ??
      /"action_uid":\s*"([^"]+)"/.exec(user)?.[1];
    const hit = uid ? envelopes[uid] : undefined;
    if (!hit) {
      throw new Error(
        `[${label}] no fixture envelope for action_uid ${uid ?? '(not found in message)'}. ` +
          `Add one rather than letting the gap answer as a result.`,
      );
    }
    return hit;
  };
}

/** Build a well-formed envelope with the reasoning item FIRST, as the API sends it. */
export function fixtureEnvelope(payload: unknown): ResponsesEnvelope {
  return {
    // Reasoning is on, so index 0 is a reasoning item and the message is at 1.
    // Fixtures reproduce that shape on purpose — a fixture that put the message
    // at index 0 would let an index-0 regression pass the test suite.
    output: [
      { type: 'reasoning' },
      { type: 'message', content: [{ text: JSON.stringify(payload) }] },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  } as ResponsesEnvelope;
}

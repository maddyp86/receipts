import { createHash } from 'node:crypto';
import { fail, ok, type Envelope } from '@receipts/shared';
import { config } from '../config.js';

// ===========================================================================
// Embedding seam.
//
// The live implementation must match the batch pipeline exactly — same model,
// same dimensions, same input string (see promiseEmbeddingText.ts). Anything
// else puts the query vector in a different space from the stored bill vectors
// and degrades matching with no visible error.
// ===========================================================================

export interface Embedder {
  readonly kind: 'openai' | 'fixture';
  embed(text: string): Promise<Envelope<number[]>>;
}

export class OpenAIEmbedder implements Embedder {
  readonly kind = 'openai' as const;

  async embed(text: string): Promise<Envelope<number[]>> {
    if (!config.embeddings.apiKey) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'OpenAI is not configured (OPENAI_API_KEY).',
        recoverable: false,
      });
    }

    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.embeddings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.embeddings.model,
          input: text,
          dimensions: config.embeddings.dimensions,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return fail({
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Embedding request failed (${res.status}).`,
          recoverable: res.status >= 500 || res.status === 429,
          details: { status: res.status, body: detail.slice(0, 400) },
        });
      }

      const payload = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = payload.data?.[0]?.embedding;
      if (!vector?.length) {
        return fail({
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Embedding response contained no vector.',
          recoverable: true,
        });
      }
      return ok(vector);
    } catch (err) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Could not reach the embeddings API.',
        recoverable: true,
        details: { cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/**
 * Deterministic stand-in. The fixture store scores lexically against the query
 * text, so this vector is never actually compared against anything — but it is
 * the right shape and stable for the same input, which keeps the seam honest
 * and the pipeline shape identical in both modes.
 */
export class FixtureEmbedder implements Embedder {
  readonly kind = 'fixture' as const;

  async embed(text: string): Promise<Envelope<number[]>> {
    const dims = config.embeddings.dimensions;
    const seed = createHash('sha256').update(text).digest();
    const vector = Array.from({ length: dims }, (_, i) => {
      const b = seed[i % seed.length]!;
      return (b / 255) * 2 - 1;
    });
    return ok(vector);
  }
}

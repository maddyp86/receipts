import type { TraceUsage } from './Trace.js';

// ===========================================================================
// What a traced model call cost, from its usage and the published rates.
//
// The two vendors count differently, and pricing them with one formula is
// wrong in both directions:
//
//   Anthropic   input_tokens is the UNCACHED remainder only. Cache reads and
//               cache writes are reported separately and are NOT inside it.
//               Total prompt = input + cache_write + cache_read.
//   OpenAI      input_tokens is the WHOLE prompt; cached_tokens is the part
//               of it served from cache. Output includes reasoning tokens.
//
// Rates are USD per million tokens, from each vendor's published pricing page
// as read on 2026-10-06 (Anthropic: platform.claude.com/docs/en/about-claude/
// pricing; OpenAI: developers.openai.com/api/docs/pricing). Cache writes are
// the 5-minute TTL — the only one this code requests. Update the table, not
// the formula, when prices move.
// ===========================================================================

export interface ModelRates {
  vendor: 'anthropic' | 'openai';
  /** Uncached input. */
  input: number;
  /** Anthropic 5-minute cache write; unused for OpenAI (no write premium). */
  cacheWrite: number;
  /** Cache read / cached input. */
  cacheRead: number;
  output: number;
}

export const MODEL_RATES: Record<string, ModelRates> = {
  'claude-sonnet-5': { vendor: 'anthropic', input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-haiku-4-5': { vendor: 'anthropic', input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'gpt-5.4-mini': { vendor: 'openai', input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 4.5 },
};

export interface CostBreakdown {
  /** Uncached input, billed at the full input rate. */
  uncached_input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  usd: number;
}

/** Cost of one call, or null when the model has no rate on file. */
export function costOf(model: string | null | undefined, usage: TraceUsage | null | undefined): CostBreakdown | null {
  const rates = model ? MODEL_RATES[model] : undefined;
  if (!rates || !usage) return null;
  const input = usage.input_tokens ?? 0;
  const read = usage.cached_tokens ?? 0;
  const write = usage.cache_write_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // OpenAI's cached tokens are a subset of its input; Anthropic's are not.
  const uncached = rates.vendor === 'openai' ? Math.max(0, input - read) : input;
  const usd =
    (uncached * rates.input + write * rates.cacheWrite + read * rates.cacheRead + output * rates.output) / 1e6;
  return {
    uncached_input_tokens: uncached,
    cache_write_tokens: write,
    cache_read_tokens: read,
    output_tokens: output,
    usd,
  };
}

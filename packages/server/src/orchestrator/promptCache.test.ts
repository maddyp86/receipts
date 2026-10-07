import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { withMovingBreakpoint } from './loop.js';
import { systemPrompt } from './prompts.js';
import { TOOL_DEFINITIONS } from './toolDefs.js';
import { anthropicUsage } from '../trace/Trace.js';
import { costOf } from '../trace/pricing.js';

// ===========================================================================
// PROMPT CACHING ON THE ORCHESTRATOR LOOP.
//
// Caching is a byte-exact prefix match. These pin the two things that make it
// work and that a later edit could silently break — no error, just a bigger
// bill: the stored history is never edited, and each request's prefix is the
// previous request plus what the turn appended.
// ===========================================================================

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: [{ type: 'text', text }] });
const toolResults = (...ids: string[]): Anthropic.MessageParam => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: `{"ok":true,"id":"${id}"}` })),
});
const assistant = (...ids: string[]): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'Calling tools.' },
    ...ids.map((id) => ({ type: 'tool_use' as const, id, name: 'search_votes', input: { q: id } })),
  ],
});

/** The request body with every cache marker removed: what must match byte for byte. */
const strip = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x));
const markers = (msgs: Anthropic.MessageParam[]) =>
  msgs.flatMap((m, i) =>
    typeof m.content === 'string' ? [] : m.content.flatMap((b, j) => ('cache_control' in b && b.cache_control ? [`${i}.${j}`] : [])),
  );

describe('the moving breakpoint', () => {
  it('marks only the last block of the last message', () => {
    const history = [user('ask'), assistant('a', 'b'), toolResults('a', 'b')];
    expect(markers(withMovingBreakpoint(history))).toEqual(['2.1']);
  });

  // The stored history is append-only. Marking it in place would leave stale
  // markers behind and pile past the four-breakpoint limit by turn five.
  it('never edits the stored history', () => {
    const history = [user('ask'), assistant('a'), toolResults('a')];
    const before = JSON.stringify(history);
    withMovingBreakpoint(history);
    expect(JSON.stringify(history)).toBe(before);
    expect(markers(history)).toEqual([]);
  });

  it('marks a bare-string message by wrapping it, without losing its text', () => {
    const out = withMovingBreakpoint([{ role: 'user', content: 'hello' }]);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
  });

  it('passes an empty history through', () => {
    expect(withMovingBreakpoint([])).toEqual([]);
  });

  // The property the cache depends on: turn N+1's request, markers stripped,
  // starts with turn N's request, markers stripped — so N's marker is a read
  // point for N+1.
  it('each request is the previous request plus what the turn appended', () => {
    const history: Anthropic.MessageParam[] = [user('ask')];
    const sent: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      sent.push(strip(withMovingBreakpoint(history)));
      history.push(assistant(`t${turn}`), toolResults(`t${turn}`));
    }
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.startsWith(sent[i - 1]!.slice(0, -1))).toBe(true);
    }
  });
});

describe('the static prefix', () => {
  // Any per-request value in here — a date, an id, an unsorted map — would
  // make every turn and every query a cache miss.
  it('the system prompt is byte-identical across calls', () => {
    expect(systemPrompt()).toBe(systemPrompt());
    expect(systemPrompt()).not.toMatch(/\d{4}-\d{2}-\d{2}T|\{\{/);
  });

  it('the tool list is a constant', () => {
    expect(JSON.stringify(TOOL_DEFINITIONS)).toBe(JSON.stringify(TOOL_DEFINITIONS));
  });

  // Sonnet 5 caches nothing under 1,024 tokens, silently. ~4 chars a token.
  it('is long enough to cache', () => {
    expect((systemPrompt().length + JSON.stringify(TOOL_DEFINITIONS).length) / 4).toBeGreaterThan(1024);
  });
});

describe('the cost accounting', () => {
  it('records cache writes and reads from the Anthropic usage', () => {
    expect(
      anthropicUsage({ input_tokens: 120, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1500 }),
    ).toEqual({ input_tokens: 120, output_tokens: 300, cached_tokens: 9000, cache_write_tokens: 1500 });
  });

  // Anthropic: input_tokens is the uncached remainder; reads and writes are
  // separate and priced at 0.1x and 1.25x.
  it('prices Sonnet 5 uncached, written, read and output tokens separately', () => {
    const c = costOf('claude-sonnet-5', { input_tokens: 1_000_000, cache_write_tokens: 1_000_000, cached_tokens: 1_000_000, output_tokens: 1_000_000 })!;
    expect(c.usd).toBeCloseTo(2 + 2.5 + 0.2 + 10, 6);
  });

  // OpenAI: cached tokens are inside input_tokens, so they must not be billed twice.
  it('prices gpt-5.4-mini cached input as a subset of input', () => {
    const c = costOf('gpt-5.4-mini', { input_tokens: 1_000_000, cached_tokens: 600_000, output_tokens: 0 })!;
    expect(c.uncached_input_tokens).toBe(400_000);
    expect(c.usd).toBeCloseTo(0.4 * 0.75 + 0.6 * 0.075, 6);
  });

  it('prices nothing it has no rate for', () => {
    expect(costOf('some-other-model', { input_tokens: 1 })).toBeNull();
  });
});

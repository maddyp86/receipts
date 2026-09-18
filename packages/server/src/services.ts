import { config } from './config.js';
import type { ActionStore } from './data/ActionStore.js';
import { FixtureActionStore } from './data/FixtureActionStore.js';
import { PineconeActionStore } from './data/PineconeActionStore.js';
import { FixtureEmbedder, OpenAIEmbedder, type Embedder } from './embeddings/Embedder.js';
import { NullQueryStore, type QueryStore } from './data/QueryStore.js';
import { SupabaseQueryStore } from './data/SupabaseQueryStore.js';
import type { TraceSink } from './trace/Trace.js';
import {
  CompositeTraceReader,
  FileTraceSink,
  SupabaseTraceSink,
  type TraceReader,
} from './trace/TraceStore.js';

// One place where mode selection happens, so nothing downstream branches on it.
export const actionStore: ActionStore = config.fixtureMode
  ? new FixtureActionStore()
  : new PineconeActionStore();

export const embedder: Embedder = config.fixtureMode ? new FixtureEmbedder() : new OpenAIEmbedder();

/**
 * Query/session persistence.
 *
 * Selected on DATABASE_URL alone, like every other capability here. Without it
 * the app runs fully and persists nothing — NullQueryStore is honest about
 * that: getQuery returns null rather than reconstructing something plausible,
 * so a share link reports "not found", which is true.
 */
export const queryStore: QueryStore = config.database.url
  ? new SupabaseQueryStore()
  : new NullQueryStore();

/**
 * Query trace sinks and the reader over them (trace/Trace.ts).
 *
 * The file sink is on whenever TRACE_DIR is not `off`, and is the one that
 * works with DATABASE_URL blank. The Supabase sink is added on the same
 * credential as persistence. Both are best effort; a failure in either is
 * logged and the answer is unaffected.
 *
 * MUTABLE on purpose: tests push a memory sink here so a full demo run can be
 * asserted end to end without touching the filesystem or a database.
 */
const fileTraceSink = config.trace.dir ? new FileTraceSink(config.trace.dir, config.trace.maxFiles) : null;
const supabaseTraceSink = config.database.url ? new SupabaseTraceSink(config.database.url) : null;

export const traceSinks: TraceSink[] = [
  ...(fileTraceSink ? [fileTraceSink] : []),
  ...(supabaseTraceSink ? [supabaseTraceSink] : []),
];

/** Supabase first — it outlives a container restart — then the local files. */
export const traceReader: TraceReader = new CompositeTraceReader([
  ...(supabaseTraceSink ? [supabaseTraceSink] : []),
  ...(fileTraceSink ? [fileTraceSink] : []),
]);

/** For the startup banner. */
export function describeTraceSinks(): string {
  if (!traceSinks.length) return 'trace: OFF (TRACE_DIR=off and no DATABASE_URL) — runs leave no step log.';
  const parts = traceSinks.map((s) => (s.kind === 'file' ? `file ${config.trace.dir}` : 'supabase app.app_query_trace_*'));
  return `trace: ${parts.join(' + ')} · read back at /api/trace/:run_id`;
}

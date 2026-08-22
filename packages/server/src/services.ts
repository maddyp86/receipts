import { config } from './config.js';
import type { ActionStore } from './data/ActionStore.js';
import { FixtureActionStore } from './data/FixtureActionStore.js';
import { PineconeActionStore } from './data/PineconeActionStore.js';
import { FixtureEmbedder, OpenAIEmbedder, type Embedder } from './embeddings/Embedder.js';
import { NullQueryStore, type QueryStore } from './data/QueryStore.js';
import { SupabaseQueryStore } from './data/SupabaseQueryStore.js';

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

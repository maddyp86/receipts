import { config } from './config.js';
import type { ActionStore } from './data/ActionStore.js';
import { FixtureActionStore } from './data/FixtureActionStore.js';
import { PineconeActionStore } from './data/PineconeActionStore.js';
import { FixtureEmbedder, OpenAIEmbedder, type Embedder } from './embeddings/Embedder.js';

// One place where mode selection happens, so nothing downstream branches on it.
export const actionStore: ActionStore = config.fixtureMode
  ? new FixtureActionStore()
  : new PineconeActionStore();

export const embedder: Embedder = config.fixtureMode ? new FixtureEmbedder() : new OpenAIEmbedder();

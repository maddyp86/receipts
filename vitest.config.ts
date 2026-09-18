import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@receipts/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    // -----------------------------------------------------------------------
    // The suite runs with NO credentials, whatever the developer's `.env` says.
    //
    // `config.ts` loads the repo-root `.env`, so once a real key is present for
    // local verification the tests inherit it — and several of them assert the
    // no-credential behaviour ("refuses to classify without a key rather than
    // guessing"). One of those stopped testing the refusal and started making a
    // live Anthropic call instead: 2.3s of real network and real money inside
    // `npm test`, reported as a failure only because the call SUCCEEDED.
    //
    // dotenv never overwrites a variable already present in `process.env`, and
    // an empty string counts as present, so these win over the file.
    //
    // A test that needs a credential belongs behind an explicit fetcher stub —
    // every call site here already takes one.
    // -----------------------------------------------------------------------
    env: {
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      PINECONE_API_KEY: '',
      PINECONE_HOST: '',
      DATABASE_URL: '',
      // No trace files from the suite. Tests that want a trace push a memory
      // sink onto `traceSinks`; see orchestrator/traceRun.test.ts.
      TRACE_DIR: 'off',
    },
  },
});

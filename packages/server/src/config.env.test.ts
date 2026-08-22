import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ===========================================================================
// .env.example is a committed file. Two things must stay true about it, and
// neither survives on discipline alone:
//
//   1. It documents exactly the vars the code reads — no more, no less. A
//      documented knob the code ignores is worse than an undocumented one:
//      someone sets it and believes it took effect. SIMILARITY_STRONG and
//      SIMILARITY_WEAK sat there for weeks doing nothing.
//
//   2. It contains no real infrastructure identifier. Anything committed here
//      is permanent in history the moment the repo goes public.
// ===========================================================================

const ROOT = resolve(import.meta.dirname, '../../..');
const envExample = readFileSync(resolve(ROOT, '.env.example'), 'utf8');
const configSrc = readFileSync(resolve(ROOT, 'packages/server/src/config.ts'), 'utf8');

const documented = new Set(
  [...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
);
const sheetsSrc = readFileSync(resolve(ROOT, 'packages/server/src/data/sheets.ts'), 'utf8');
// config.ts is the seam for everything the running app reads. sheets.ts is the
// one allowed exception (scrubbed, unimported), and its vars are documented
// too, so both files feed the sync check.
const read = new Set(
  [...`${configSrc}\n${sheetsSrc}`.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|env\('([A-Z][A-Z0-9_]*)'\)/g)].map(
    (m) => (m[1] ?? m[2])!,
  ),
);

describe('.env.example stays in sync with config.ts', () => {
  it('documents every var the code reads', () => {
    const missing = [...read].filter((v) => !documented.has(v)).sort();
    expect(missing, `Read by config.ts but absent from .env.example: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('documents no var the code ignores', () => {
    const dead = [...documented].filter((v) => !read.has(v)).sort();
    expect(dead, `In .env.example but never read: ${dead.join(', ')}`).toEqual([]);
  });

  it('reads env in config.ts and nowhere else', async () => {
    // One seam. A stray process.env read elsewhere escapes both checks above,
    // and escapes the credential reporting in the startup banner.
    //
    // sheets.ts is the one allowed exception: its SHEETS_DOC_* ids are scrubbed
    // placeholders in a module nothing imports, kept env-driven so the real ids
    // can never return to the file.
    const { globSync } = await import('node:fs');
    const files = globSync('packages/server/src/**/*.ts', { cwd: ROOT });
    const strays = files.filter((f) => {
      if (f.endsWith('config.ts') || f.endsWith('config.env.test.ts')) return false;
      if (f.endsWith('data/sheets.ts')) return false;
      return /process\.env\./.test(readFileSync(resolve(ROOT, f), 'utf8'));
    });
    expect(strays, `process.env read outside config.ts: ${strays.join(', ')}`).toEqual([]);
  });
});

describe('.env.example carries no real infrastructure identifier', () => {
  it('has no populated secret values', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PINECONE_API_KEY']) {
      const value = new RegExp(`^${key}=(.*)$`, 'm').exec(envExample)?.[1] ?? '';
      expect(value.trim(), `${key} must be empty in the committed example`).toBe('');
    }
  });

  it('has no real Pinecone host or index', () => {
    // The host embeds a project slug and region; both identify the deployment.
    expect(envExample).not.toMatch(/\.svc\.aped-/);
    expect(envExample).toMatch(/PINECONE_HOST=https:\/\/your-index\.svc\.your-region/);
    expect(envExample).not.toMatch(/bills-promises/);
  });

  it('has no Google Sheets document id', () => {
    // A Sheets doc id is an access identifier: if the sheet is link-shared, the
    // id IS the credential. Their shape is a 40+ char base64-ish run.
    expect(envExample).not.toMatch(/\b1[A-Za-z0-9_-]{42,}\b/);
  });

  it('has no secret-shaped value anywhere', () => {
    expect(envExample).not.toMatch(
      /sk-ant-[A-Za-z0-9_-]{10,}|sk-proj-[A-Za-z0-9_-]{10,}|pcsk_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{20,}\./,
    );
  });

  it('has no local filesystem path', () => {
    expect(envExample).not.toMatch(/\/Users\/|\/home\/[a-z]/);
  });
});

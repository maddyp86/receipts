import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ===========================================================================
// Migration 010 — the column lists are a CONTRACT with the n8n Mirror Sync.
//
// The sync declares the same list, introspects the live table before writing,
// drops any declared column the table lacks and reports it as schema drift.
// There is no Postgres in the test suite, so what is pinned here is the one
// thing that can be checked without one: that the file still declares exactly
// the columns and keys brief 3 fixed, in the types it fixed. Rename or add a
// column and this fails before the sync reports drift on a live run.
//
// Source: docs/fix/receipts-brief-3-progress-effort-versions.md, Task 1.
// ===========================================================================

const MIGRATION = fileURLToPath(
  new URL('../../../../docs/supabase-migration-010-bill-progress-and-versions.sql', import.meta.url),
);
const sql = readFileSync(MIGRATION, 'utf8');

/** The column list of one CREATE TABLE, as [name, type-with-constraints] pairs. */
function columnsOf(table: string): Array<[string, string]> {
  const re = new RegExp(
    `CREATE TABLE IF NOT EXISTS mirror\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i',
  );
  const body = re.exec(sql)?.[1];
  if (!body) throw new Error(`no CREATE TABLE for mirror.${table}`);
  return body
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.replace(/,$/, '').split(/\s+/);
      return [name!, rest.join(' ')] as [string, string];
    });
}

describe('migration 010 — fixed column lists', () => {
  it('mirror_bills_master declares exactly the four columns, keyed by bill_id', () => {
    const cols = columnsOf('mirror_bills_master');
    expect(cols.map(([n]) => n)).toEqual(['bill_id', 'row', 'source_row_number', 'synced_at']);
    expect(cols).toEqual([
      ['bill_id', 'text PRIMARY KEY'],
      ['row', 'jsonb NOT NULL'],
      ['source_row_number', 'integer'],
      ['synced_at', 'timestamptz NOT NULL DEFAULT now()'],
    ]);
  });

  it('mirror_impact_statement_versions declares exactly the seven columns, keyed by impact_version_uid', () => {
    const cols = columnsOf('mirror_impact_statement_versions');
    expect(cols.map(([n]) => n)).toEqual([
      'impact_version_uid',
      'bill_id',
      'text_version_code',
      'text_version_date',
      'row',
      'source_row_number',
      'synced_at',
    ]);
    expect(cols).toEqual([
      ['impact_version_uid', 'text PRIMARY KEY'],
      ['bill_id', 'text'],
      ['text_version_code', 'text'],
      // TEXT, not DATE: blank for enrolled versions. A DATE column would
      // reject the blank the sync writes.
      ['text_version_date', 'text'],
      ['row', 'jsonb NOT NULL'],
      ['source_row_number', 'integer'],
      ['synced_at', 'timestamptz NOT NULL DEFAULT now()'],
    ]);
  });

  // Every read of versions is by bill. Without this the reader scans the table
  // per candidate.
  it('indexes versions by bill_id', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+\s+ON mirror\.mirror_impact_statement_versions \(bill_id\)/,
    );
  });
});

describe('migration 010 — follows the mirror grant pattern, not a new one', () => {
  for (const table of ['mirror_bills_master', 'mirror_impact_statement_versions']) {
    it(`${table}: receipts_sync writes, receipts_app and receipts_trust read`, () => {
      expect(sql).toMatch(
        new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON mirror\\.${table}\\s+TO receipts_sync`),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT SELECT ON mirror\\.${table}\\s+TO receipts_app, receipts_trust`),
      );
    });

    it(`${table}: RLS enabled with the _sync / _read policy pair`, () => {
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE mirror\\.${table}\\s+ENABLE ROW LEVEL SECURITY`),
      );
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_sync ON mirror\\.${table}\\s+FOR ALL TO receipts_sync USING \\(true\\) WITH CHECK \\(true\\)`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_read ON mirror\\.${table}\\s+FOR SELECT TO receipts_app, receipts_trust USING \\(true\\)`,
        ),
      );
    });
  }

  // Migration 007's posture: the mirror holds enrichment, never a corpus
  // verdict. Nothing in 010 may reintroduce the dropped tables.
  it('touches neither corpus verdict table', () => {
    expect(sql).not.toMatch(/mirror_promise_alignment_matches/);
    expect(sql).not.toMatch(/mirror_decision_scores/);
  });

  it('is additive: alters no existing table', () => {
    const altered = [...sql.matchAll(/ALTER TABLE mirror\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(
      new Set(['mirror_bills_master', 'mirror_impact_statement_versions']),
    );
  });
});

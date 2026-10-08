import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Interpretation, MatchedAction } from '@receipts/shared';
import { newSession, toFulfillmentCandidate } from '../orchestrator/dispatch.js';
import { buildFulfillmentUserMessage } from './fulfillment.js';
import { MirrorEnrichmentSource, billStatementOf, nullEnrichmentSource } from './enrichment.js';
import { parseVersionRow, type TextVersion } from './textVersions.js';

// ===========================================================================
// THE EVALUATOR'S FALLBACK CARRIES THE BILL'S OWN REVERSAL FIELDS.
//
// When no usable text version applies, the fulfillment candidate is the
// bill-level summary — but it never carried that statement's reversal fields,
// so the v7 prompt printed "Reverses Existing Policy: false" and "Target …:
// N/A" for every such bill, disapproval resolutions included. On a
// disapproval resolution that says the bill changes nothing existing, and a
// NAY's direction then reads backwards. Confirmed 2026-10-07: sjres31-119's
// four version rows are now flagged, so it takes exactly this path.
//
// Fixture: the live mirror_impact_statements row for sjres31-119, verbatim.
// ===========================================================================

const ROW = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sjres31BillStatement.json', import.meta.url)), 'utf8'),
) as { bill_id: string; row: Record<string, unknown> };

const interpretation = {
  raw: 'promised to protect clean air standards from rollback',
  statement_type: 'Policy Position',
  provenance: 'default',
  restated: 'Protect clean air standards from rollback.',
  primary_issue: 'Environment',
  sub_issue: 'Pollution & Clean Air/Water',
  stance: 'In Favor',
  promise_type: 'policy',
  key_policy_terms: ['clean air standards'],
  is_evaluable: true,
} as unknown as Interpretation;

const match = {
  action_uid: 'ACT-sjres31-119-S000148',
  bill_id: 'sjres31-119',
  title: String(ROW.row['Title'] ?? ''),
  summary: String(ROW.row['Summary'] ?? ''),
  intended_effects: String(ROW.row['Intended Effects'] ?? ''),
  mechanisms: String(ROW.row['Mechanisms'] ?? ''),
  action_type: 'voted',
  is_sponsor: false,
  is_cosponsor: false,
  vote: 'Nay',
  cloture_vote: 'NA',
  passage_vote: 'Nay',
  bill_keywords: [],
  primary_issue: 'Environment',
  sub_issue: 'Pollution & Clean Air/Water',
  source_url: '',
  score: 0.6,
  strength: 'STRONG',
  missing_fields: [],
} as MatchedAction;

function session() {
  const s = newSession('S000148', interpretation.raw);
  s.interpretation = interpretation;
  s.scope = { scope: 'STANDING' } as never;
  return s;
}

const statement = billStatementOf(ROW.row);

describe('the bill-level statement', () => {
  it('records sjres31-119 as reversing an existing rule, and names it', () => {
    expect(statement.reverses_existing_policy).toBe('true');
    expect(statement.target_name).toMatch(/Reclassification of Major Sources as Area Sources/);
    expect(statement.target_effect).toBeTruthy();
  });
});

describe('what the evaluator is told when no text version applies', () => {
  const before = buildFulfillmentUserMessage(toFulfillmentCandidate(session(), match, {}, undefined, null));
  const after = buildFulfillmentUserMessage(toFulfillmentCandidate(session(), match, {}, undefined, null, statement));

  it('was told the resolution reverses nothing', () => {
    expect(before).toContain('- Reverses Existing Policy: false');
    expect(before).toContain('- Target Name: N/A');
  });

  it('is now told what the resolution reverses', () => {
    expect(after).toContain('- Reverses Existing Policy: true');
    expect(after).toContain(`- Target Name: ${statement.target_name}`);
    expect(after).toContain(`- Target Effect: ${statement.target_effect}`);
  });

  it('nothing else in the message moves', () => {
    const strip = (m: string) => m.replace(/## REVERSAL TARGET[\s\S]*?(?=\n## |$)/, '');
    expect(strip(after)).toBe(strip(before));
  });
});

describe('a selected text version still supplies its own', () => {
  // Every field from the one version — never a mix of two (textVersions.ts).
  const version: TextVersion = parseVersionRow({
    impact_version_uid: 'V-1', bill_id: 'sjres31-119', text_version_code: 'is', text_version_date: '2025-03-01',
    row: { Summary: 'A version summary.', 'Reverses Existing Policy': false, 'Version Title Source': 'TEXT' },
  } as never);

  it("uses the version's reversal fields, not the bill-level ones", () => {
    const c = toFulfillmentCandidate(session(), match, {}, undefined, version, statement);
    expect(c.reverses_existing_policy).toBe(version.reverses_existing_policy ?? undefined);
    expect(c.target_name).toBe(version.target_name ?? undefined);
  });
});

describe('the read', () => {
  const dead = new MirrorEnrichmentSource('postgresql://nobody:nothing@127.0.0.1:1/none');
  afterAll(() => dead.close());

  it('fails open and reports itself, as a decisive part', async () => {
    const failed: string[] = [];
    expect((await dead.forBillStatements(['sjres31-119'], (p) => failed.push(p))).size).toBe(0);
    expect(failed).toEqual(['bill_statements']);
  });

  it('the null source has nothing to read', async () => {
    expect((await nullEnrichmentSource.forBillStatements(['sjres31-119'])).size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { metadataOf, scoreOf } from './SupabaseActionStore.js';
import { toMatchedAction } from './PineconeActionStore.js';

// ===========================================================================
// THE SUPABASE STORE HANDS THE EVALUATOR WHAT PINECONE DID.
//
// Both stores build a MatchedAction with the same converter, so these tests pin
// the one thing that is new: turning a `core` row into the record WF6 wrote as
// Pinecone metadata. The stakeholder string goes to the model verbatim, so its
// key names and order are part of the prompt.
// ===========================================================================

const row = {
  action_uid: 'ACT-hr5371-119-S000148',
  bill_id: 'hr5371-119',
  similarity: 0.71234,
  vote: 'Nay',
  cloture_vote: null,
  passage_vote: 'Nay',
  is_sponsor: false,
  is_cosponsor: false,
  action_type: 'voted',
  congress: 119,
  bill_type: 'hr',
  bill_number: 5371,
  title: 'Continuing Appropriations Act',
  summary: 'Extends funding.',
  intended_effects: 'Keeps the government open.',
  mechanisms: 'Continuing appropriations.',
  primary_issue: 'Budget',
  sub_issue: 'Appropriations',
  keywords: 'appropriations, shutdown; continuing resolution',
  stakeholders: [
    { stakeholder_uid: 'ABC123-S1', group: 'Federal employees', positive: 'Paid on time', negative: 'none identified' },
    { stakeholder_uid: 'ABC123-S2', group: 'Contractors', positive: null, negative: 'Delays' },
  ],
};

describe('a core row in WF6 metadata shape', () => {
  it('writes stakeholders as WF6 did: sheet key names, sheet order, a JSON string', () => {
    expect(metadataOf(row).affected_stakeholders).toBe(
      JSON.stringify([
        { 'Stakeholder UID': 'ABC123-S1', 'Stakeholder Group': 'Federal employees', 'Positive Impacts': 'Paid on time', 'Negative Impacts': 'none identified' },
        { 'Stakeholder UID': 'ABC123-S2', 'Stakeholder Group': 'Contractors', 'Positive Impacts': '', 'Negative Impacts': 'Delays' },
      ]),
    );
  });

  it('a bill with no stakeholders is "[]", as WF6 wrote it, not absent', () => {
    expect(metadataOf({ ...row, stakeholders: [] }).affected_stakeholders).toBe('[]');
    expect(metadataOf({ ...row, stakeholders: null }).affected_stakeholders).toBe('[]');
  });

  it('upper-cases votes and writes NA for a vote that was not cast, as WF6 did', () => {
    const md = metadataOf(row);
    expect(md.vote).toBe('NAY');
    expect(md.passage_vote).toBe('NAY');
    expect(md.cloture_vote).toBe('NA');
  });
});

describe('the score reads like Pinecone\'s', () => {
  it('is cut to nine significant digits, as Pinecone returns it', () => {
    // The relevance prompt prints the score; a 15-digit double would change it.
    expect(scoreOf(0.559694834028099)).toBe(0.559694834);
    expect(String(scoreOf('0.674757123456789'))).toBe('0.674757123');
  });
});

describe('the converter is the Pinecone one', () => {
  it('gives the fields Pinecone gives for the same record', () => {
    const a = toMatchedAction(row.action_uid, row.similarity, metadataOf(row));
    expect(a).toMatchObject({
      action_uid: 'ACT-hr5371-119-S000148',
      bill_id: 'hr5371-119',
      bill_number: '5371',
      congress: 119,
      vote: 'NAY',
      cloture_vote: 'NA',
      passage_vote: 'NAY',
      bill_keywords: ['appropriations', 'shutdown', 'continuing resolution'],
      source_url: 'https://www.congress.gov/bill/119th-congress/house-bill/5371',
      score: 0.71234,
      missing_fields: [],
    });
  });

  it('records a missing statement field instead of inventing one', () => {
    const a = toMatchedAction(row.action_uid, row.similarity, metadataOf({ ...row, summary: null, keywords: null }));
    expect(a.summary).toBe('');
    expect(a.missing_fields).toEqual(expect.arrayContaining(['summary', 'bill_keywords']));
  });
});

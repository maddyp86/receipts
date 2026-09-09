import type { MatchedAction } from '@receipts/shared';

// ===========================================================================
// Fixture record for the two MVP senators.
//
// These stand in for real Pinecone matches so the whole slice is playable with
// no credentials. They are shaped like real rows — same fields, same 'NA'
// conventions, same vote/cloture/passage split — so code paths exercised here
// are the ones that run live.
//
// The set is chosen to cover every outcome the UI must handle honestly:
//
//   drug pricing        -> clean KEPT, two hard votes            (High band)
//   background checks   -> directional conflict                  (ranked mode)
//   clean air (CRA)     -> HINDER + NAY = KEPT                   (inversion guard)
//   broadband           -> one strong match                      (Medium band)
//   student loans       -> sponsored then voted NAY              (procedural switch)
//   anything else       -> nothing above the floor               (NOT_DETERMINABLE)
// ===========================================================================

export interface FixtureAction extends MatchedAction {
  politician_id: string;
  /**
   * Terms the lexical stand-in scores against. Roughly the role real embeddings
   * play — they are not part of the live schema.
   */
  match_terms: string[];
}

const base = {
  bill_keywords: [] as string[],
  missing_fields: [] as string[],
  score: 0,
  strength: 'STRONG' as const,
};

const FIXTURE_ROWS: FixtureAction[] = [
  // ── Schumer · prescription drug pricing — clean KEPT ──────────────────────
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-hr5376-117-S000148',
    bill_id: 'hr5376-117',
    bill_number: 'H.R.5376',
    bill_type: 'hr',
    title: 'Inflation Reduction Act of 2022',
    summary:
      'Authorizes Medicare to negotiate prices for selected high-cost prescription drugs, caps insulin cost-sharing at $35 per month for Medicare beneficiaries, and caps annual out-of-pocket drug spending.',
    intended_effects:
      'Reduces out-of-pocket prescription drug costs for Medicare beneficiaries; constrains list-price growth through negotiation and inflation rebates.',
    mechanisms:
      'Medicare drug price negotiation program; $35 monthly insulin copay cap; annual out-of-pocket maximum; inflation rebate penalties.',
    affected_stakeholders:
      'Medicare beneficiaries (positive: lower costs); pharmaceutical manufacturers (negative: constrained pricing).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'YEA',
    cloture_vote: 'YEA',
    passage_vote: 'YEA',
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: 'https://www.congress.gov/bill/117th-congress/house-bill/5376',
    match_terms: [
      'prescription',
      'drug',
      'prices',
      'pricing',
      'insulin',
      'copay',
      'medicare',
      'negotiation',
      'healthcare',
      'out-of-pocket',
      'pharmaceutical',
    ],
  },
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-s4-118-S000148',
    bill_id: 's4-118',
    bill_number: 'S.4',
    bill_type: 's',
    title: 'Affordable Insulin Now Act',
    summary:
      'Caps monthly cost-sharing for insulin products at $35 for individuals with private insurance as well as Medicare Part D enrollees.',
    intended_effects: 'Lowers the monthly cost of insulin for insured patients.',
    mechanisms: 'Statutory cap on insulin cost-sharing across private and public plans.',
    affected_stakeholders:
      'Insulin-dependent patients (positive: capped costs); insurers and manufacturers (negative: constrained pricing).',
    action_type: 'cosponsored',
    is_sponsor: false,
    is_cosponsor: true,
    vote: 'YEA',
    cloture_vote: 'NA',
    passage_vote: 'YEA',
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: 'https://www.congress.gov/bill/118th-congress/senate-bill/4',
    match_terms: [
      'insulin',
      'drug',
      'prices',
      'pricing',
      'prescription',
      'copay',
      'cap',
      'healthcare',
      'cost',
    ],
  },

  // ── Schumer · background checks — directional conflict → ranked ───────────
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-hr8-117-S000148',
    bill_id: 'hr8-117',
    bill_number: 'H.R.8',
    bill_type: 'hr',
    title: 'Bipartisan Background Checks Act',
    summary:
      'Requires a background check for every firearm sale or transfer, including private and gun-show transactions.',
    intended_effects: 'Extends background check requirements to currently exempt private transfers.',
    mechanisms: 'Mandatory NICS check routed through a licensed dealer for private transfers.',
    affected_stakeholders:
      'General public (positive: reduced access for prohibited purchasers); private sellers (negative: added process).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: true,
    vote: 'YEA',
    cloture_vote: 'YEA',
    passage_vote: 'YEA',
    primary_issue: 'Crime & Public Safety',
    sub_issue: 'Guns / Gun Control',
    source_url: 'https://www.congress.gov/bill/117th-congress/house-bill/8',
    match_terms: [
      'background',
      'checks',
      'gun',
      'firearm',
      'nics',
      'loophole',
      'transfer',
      'purchase',
    ],
  },
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-sjres28-118-S000148',
    bill_id: 'sjres28-118',
    bill_number: 'S.J.Res.28',
    bill_type: 'sjres',
    title:
      'Joint resolution providing for congressional disapproval of the ATF rule on engaged in the business of dealing in firearms',
    summary:
      'Disapproves and nullifies the Bureau of Alcohol, Tobacco, Firearms and Explosives rule clarifying when a person is engaged in the business of dealing in firearms and therefore required to run background checks.',
    intended_effects:
      'Nullifies a rule that expands the set of sellers required to conduct background checks.',
    mechanisms: 'Congressional Review Act resolution of disapproval nullifying an agency rule.',
    affected_stakeholders:
      'Unlicensed sellers (positive: no new requirement); general public (negative: fewer checks).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    // A YEA here would repeal the rule. This row exists so the conflict case is
    // real rather than synthetic.
    vote: 'YEA',
    cloture_vote: 'NA',
    passage_vote: 'YEA',
    primary_issue: 'Crime & Public Safety',
    sub_issue: 'Guns / Gun Control',
    source_url: 'https://www.congress.gov/bill/118th-congress/senate-joint-resolution/28',
    match_terms: [
      'background',
      'checks',
      'gun',
      'firearm',
      'dealing',
      'disapproval',
      'atf',
      'rule',
    ],
  },

  // ── Schumer · clean air CRA — HINDER + NAY must resolve to KEPT ───────────
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-sjres43-118-S000148',
    bill_id: 'sjres43-118',
    bill_number: 'S.J.Res.43',
    bill_type: 'sjres',
    title:
      'Joint resolution providing for congressional disapproval of the EPA rule on multi-pollutant emissions standards',
    summary:
      'Disapproves and nullifies the Environmental Protection Agency rule setting multi-pollutant emissions standards for light- and medium-duty vehicles.',
    intended_effects:
      'Nullifies emissions standards that would reduce vehicle air pollution, preserving the prior weaker baseline.',
    mechanisms: 'Congressional Review Act resolution of disapproval nullifying an agency rule.',
    affected_stakeholders:
      'Communities near roadways (negative: continued pollution); vehicle manufacturers (positive: no new standards).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    // NAY defeats the disapproval resolution and PRESERVES the clean-air rule.
    // Anyone who reads "NAY" as opposition to clean air gets this backwards.
    vote: 'NAY',
    cloture_vote: 'NA',
    passage_vote: 'NAY',
    primary_issue: 'Environment',
    sub_issue: 'Pollution & Clean Air/Water',
    source_url: 'https://www.congress.gov/bill/118th-congress/senate-joint-resolution/43',
    match_terms: [
      'clean',
      'air',
      'emissions',
      'pollution',
      'epa',
      'standards',
      'environment',
      'vehicle',
      'quality',
    ],
  },

  // ── Schumer · student loans — sponsored then voted NAY (procedural switch) ─
  {
    ...base,
    politician_id: 'S000148',
    action_uid: 'ACT-s2954-118-S000148',
    bill_id: 's2954-118',
    bill_number: 'S.2954',
    bill_type: 's',
    title: 'Student Loan Relief Preservation Act',
    summary:
      'Preserves income-driven repayment protections and blocks rescission of existing borrower relief.',
    intended_effects: 'Maintains existing student loan relief for enrolled borrowers.',
    mechanisms: 'Statutory preservation of income-driven repayment terms.',
    affected_stakeholders: 'Student loan borrowers (positive: preserved relief).',
    action_type: 'sponsored',
    is_sponsor: true,
    is_cosponsor: false,
    vote: 'NAY',
    cloture_vote: 'NA',
    passage_vote: 'NAY',
    primary_issue: 'Education',
    sub_issue: 'Student Loans / College Affordability',
    source_url: 'https://www.congress.gov/bill/118th-congress/senate-bill/2954',
    match_terms: ['student', 'loan', 'relief', 'borrower', 'repayment', 'education', 'forgiveness'],
  },

  // ── Thune · broadband — a single strong match (Medium band) ───────────────
  {
    ...base,
    politician_id: 'T000250',
    action_uid: 'ACT-hr3684-117-T000250',
    bill_id: 'hr3684-117',
    bill_number: 'H.R.3684',
    bill_type: 'hr',
    title: 'Infrastructure Investment and Jobs Act',
    summary:
      'Appropriates $65 billion for broadband deployment, including grants targeted at unserved rural areas.',
    intended_effects: 'Expands high-speed internet availability in rural and unserved communities.',
    mechanisms: 'Broadband Equity, Access, and Deployment formula grants to states.',
    affected_stakeholders:
      'Rural households (positive: new service); rural broadband providers (positive: grant funding).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'YEA',
    cloture_vote: 'YEA',
    passage_vote: 'YEA',
    primary_issue: 'Technology',
    sub_issue: 'Broadband & Infrastructure',
    source_url: 'https://www.congress.gov/bill/117th-congress/house-bill/3684',
    match_terms: [
      'broadband',
      'rural',
      'internet',
      'infrastructure',
      'deployment',
      'grants',
      'high-speed',
      'digital',
    ],
  },

  // ── Thune · drug pricing — opposite direction from Schumer on the same ask ─
  {
    ...base,
    politician_id: 'T000250',
    action_uid: 'ACT-hr5376-117-T000250',
    bill_id: 'hr5376-117',
    bill_number: 'H.R.5376',
    bill_type: 'hr',
    title: 'Inflation Reduction Act of 2022',
    summary:
      'Authorizes Medicare to negotiate prices for selected high-cost prescription drugs, caps insulin cost-sharing at $35 per month for Medicare beneficiaries, and caps annual out-of-pocket drug spending.',
    intended_effects:
      'Reduces out-of-pocket prescription drug costs for Medicare beneficiaries; constrains list-price growth through negotiation and inflation rebates.',
    mechanisms:
      'Medicare drug price negotiation program; $35 monthly insulin copay cap; annual out-of-pocket maximum.',
    affected_stakeholders:
      'Medicare beneficiaries (positive: lower costs); pharmaceutical manufacturers (negative: constrained pricing).',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'NAY',
    cloture_vote: 'NAY',
    passage_vote: 'NAY',
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: 'https://www.congress.gov/bill/117th-congress/house-bill/5376',
    match_terms: [
      'prescription',
      'drug',
      'prices',
      'pricing',
      'insulin',
      'copay',
      'medicare',
      'negotiation',
      'healthcare',
      'out-of-pocket',
    ],
  },
];

/**
 * Live Pinecone rows carry `congress` (PineconeActionStore reads it from vector
 * metadata) and the coverage disclosure is derived from it. Without it here,
 * demo mode reports an UNKNOWN window and shows a weaker sentence than the live
 * path would — exactly the fixture-vs-live divergence this file's header
 * promises not to have.
 *
 * Derived from `bill_id` with the same rule the gates use, rather than typed
 * per row, so it cannot drift from the identifier it describes.
 */
const congressOfBillId = (billId: string): number | undefined => {
  const digits = /-(\d{3})$/.exec(billId)?.[1];
  return digits ? Number(digits) : undefined;
};

export const FIXTURE_ACTIONS: FixtureAction[] = FIXTURE_ROWS.map((row) => ({
  ...row,
  congress: congressOfBillId(row.bill_id),
}));

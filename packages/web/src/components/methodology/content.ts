import { METHODOLOGY as M } from '@receipts/shared';

// ===========================================================================
// The methodology page's words (/methodology).
//
// HONEST TO THE CODE, like PolicyPages.tsx: every sentence describes what the
// app does today. Models and numbers come from METHODOLOGY in
// packages/shared/src/methodology.ts, which packages/server/src/
// methodology.test.ts holds to the running code. Prose that describes a rule
// (the gates, what a reader can do) must change in the same PR as the rule.
// Facts were mapped from the code on 2026-11-01.
//
// Three lines are deliberately cautious until confirmed (see the PR):
//   - REFRESH: "updated regularly", not "daily": the daily run is in the
//     pipeline generator, but the repo can't prove what is deployed;
//   - the bill-reading variability line under LIMITS (docs/specs/post-beta.md);
//   - the named open-source data projects under SOURCES.
// ===========================================================================

const pct = (n: number) => n.toFixed(2);

export interface TechRow {
  label: string;
  value: string;
}

export interface Step {
  id: string;
  /** Short name for the diagram and the jump links. */
  short: string;
  title: string;
  /** One line under the diagram station. */
  caption: string;
  paragraphs: string[];
  tech: TechRow[];
}

export const REFRESH = 'updated regularly';

export const HERO = {
  title: 'How Receipts checks the record',
  lead:
    'Every answer on Receipts comes from the same fixed process: the same steps and the same rules, for every member of Congress. This page shows each step, what it can and can’t do, and how you can check our work.',
};

export const STEPS: Step[] = [
  {
    id: 'record',
    short: 'The record',
    title: 'The record we check against',
    caption: 'Senate votes and bills since January 2023',
    paragraphs: [
      `Receipts checks a member of Congress against what they did in the Senate since ${M.coverage.since} (the ${M.coverage.congresses[0]}th Congress onward): their votes to end debate, their final votes, and the bills they sponsored or cosponsored. Laws passed before 2023 aren’t included. House votes aren’t included yet; House members are listed so you can request them.`,
      'Before anyone asks a question, each bill in that record is read once and summarized: what it would do, how, and who it affects. Those summaries are written by an AI model from the bill’s own text, and they are what the search runs on.',
    ],
    tech: [
      { label: 'Votes counted', value: 'Senate roll calls on final passage and on ending debate (cloture). One of each per member per bill; the latest vote wins.' },
      { label: 'Sponsorships', value: 'Sponsor and cosponsor, from the congress.gov API.' },
      { label: 'Bill summaries', value: `${M.models.billSummary}, written from the bill text, one per text version of the bill.` },
      { label: 'Coverage', value: `Congresses ${M.coverage.congresses.join(' and ')}. Data ${REFRESH}.` },
    ],
  },
  {
    id: 'question',
    short: 'Your question',
    title: 'How we read your question',
    caption: 'What kind of question, which topic, which way',
    paragraphs: [
      'First we work out what you typed. A question about what they did (“Did they vote for…?”) gets a factual answer from the record. A statement or promise (“supports expanding background checks”) gets checked for whether their actions line up with it.',
      `Then we file it under one of ${M.taxonomy.pairs} policy topics (grouped into ${M.taxonomy.issues} issues) and note which way it leans. If what you typed can’t be settled by a vote, such as a slogan, a claim of credit, or a remark about someone’s character, we say so and stop rather than guess. If a promise only applied for a period of time, we may ask when it was made.`,
      'Every answer shows how we read your question, and you can correct that reading and run the whole check again.',
    ],
    tech: [
      { label: 'Model', value: M.models.classify },
      { label: 'Topics', value: `${M.taxonomy.issues} issues, ${M.taxonomy.pairs} issue and sub-issue pairs. A topic outside the list is refused, not guessed.` },
      { label: 'Stance', value: 'In favor, opposed, or unclear. An opening “supports” or “opposes” in your own words sets it, whatever the model says.' },
      { label: 'Promise or position', value: 'A statement is checked as a position (consistent or inconsistent) unless your own words say promised, pledged or vowed; then it’s a promise (kept or broke).' },
    ],
  },
  {
    id: 'search',
    short: 'Search',
    title: 'Finding the bills that matter',
    caption: 'Only this member’s record, closest matches first',
    paragraphs: [
      `We turn your question into a numeric fingerprint of its meaning and compare it with the fingerprint of every summarized bill in that member’s record, and only that member’s. The ${M.retrieval.topK} closest bills go on to the next step; anything not close enough is dropped. If none of them turns out to be about your question, we look again at a few that just missed the cut before saying we found nothing.`,
      'Then a second AI check reads each candidate and decides whether it is really about what you asked. Bills that aren’t go on the “not counted” list on your answer, each with the reason, so you can see what we looked at and set aside.',
    ],
    tech: [
      { label: 'Embedding', value: `${M.models.embedding}, ${M.embeddingDimensions} dimensions; exact cosine search over the member’s bills.` },
      { label: 'Candidates', value: `Top ${M.retrieval.topK}, similarity of at least ${pct(M.retrieval.floor)}.` },
      { label: 'Near-miss review', value: `When nothing counts, up to ${M.retrieval.nearMissLimit} bills between ${pct(M.retrieval.nearMissFloor)} and ${pct(M.retrieval.floor)} get a second look. Anything found this way is marked low confidence.` },
      { label: 'Relevance check', value: `${M.models.relevance}, one call per bill (prompt ${M.prompts.relevance}). Counted: relevant, or relevant with a difference only in how specific it is.` },
    ],
  },
  {
    id: 'reading',
    short: 'Reading each bill',
    title: 'Reading each bill, without knowing who voted',
    caption: 'An AI reads the bill, not told who voted',
    paragraphs: [
      'Each counted bill is read by an AI model that is not told who voted on it or how. It answers one question: would this bill move what you asked about forward, hold it back, or neither? Keeping the model blind to the member is deliberate. It can’t favor or punish anyone, because it doesn’t know who it is reading about.',
      'We read the version of the bill that existed when the vote happened, not a later rewrite. Some bills are set aside by fixed rules before they are read, and shown on your answer as “found, but not evaluated” with the reason: for example, a giant spending package that covers far more than your question, a vote that came after a time-limited promise had run out, or a procedural vote a party leader casts for scheduling reasons.',
    ],
    tech: [
      { label: 'Model', value: `${M.models.fulfill} (prompt ${M.prompts.billEffect}). It sees the statement and the bill, never the member.` },
      { label: 'Reading', value: 'Advances, hinders, neither, or contested, with a confidence. A failed reading is reported as a failure, never as “no effect”.' },
      { label: 'Text version', value: 'The latest version dated on or before the deciding vote; never a version the bill became later.' },
      { label: 'Rules applied first', value: 'Statement window closed; a different administration than the one named; a role the senator didn’t hold; a dated spending vehicle; votes out of order; a party leader’s procedural switch; a broad package; a bill summary under review.' },
    ],
  },
  {
    id: 'answer',
    short: 'The answer',
    title: 'How the answer is decided',
    caption: 'Fixed rules combine the votes and the readings',
    paragraphs: [
      'The member’s own actions are combined with each bill’s reading by fixed code, not by an AI. A vote for a bill that advances what you asked counts toward it; a vote for a bill that holds it back counts against it, and the reverse for a vote against. A vote to end debate counts. “Not voting” never counts as support.',
      'When the evidence points both ways, we show it both ways, ranked, rather than averaging it into one answer.',
    ],
    tech: [
      { label: 'Evidence weights', value: `Vote ${M.weights.vote}, sponsorship ${M.weights.sponsorship}, procedural ${M.weights.procedural}, associative ${M.weights.associative}; each multiplied by how closely the bill matches.` },
      { label: 'Which vote decides', value: 'With both, the vote to end debate. If it and the final vote went different ways, confidence is capped below High.' },
    ],
  },
  {
    id: 'review',
    short: 'Review and write-up',
    title: 'Review and write-up',
    caption: 'A second AI reviews every accusation',
    paragraphs: [
      'Before an answer says a member broke a promise or acted against a position, a second AI, from a different company than the one that read the bills, reviews it. If it doesn’t agree, the answer is withheld and shown as one we can’t make a reliable call on. We never publish the reviewer’s own alternative reading.',
      'Finally, an AI writes the plain-language explanation. It is written after the answer is fixed and cannot change it, and it is checked for invented numbers, guesses about motive, and wording that contradicts the answer. Drafts that fail are sent back.',
    ],
    tech: [
      { label: 'Reviewer', value: `${M.models.judge} (prompt ${M.prompts.judge}), a different model family from the bill reader by rule. Seven automatic checks run first, such as split votes, broad packages, and too much confidence on partial evidence.` },
      { label: 'Write-up', value: `${M.models.explain}. It also answers follow-up questions, from that answer’s own record only.` },
    ],
  },
];

/** The four outcomes of a statement or promise check. */
export const VERDICTS: { label: string; meaning: string }[] = [
  { label: 'Consistent / Kept', meaning: 'Their votes and bills line up with the statement (a position) or the promise.' },
  { label: 'Inconsistent / Broke', meaning: 'Their votes and bills go against it. Shown only after the safeguards below.' },
];

/** Why an answer can be “can’t tell”: our own one-liners for the product’s headlines (ND_HEADLINE). */
export const CANT_TELL_MEANING: Record<string, string> = {
  "The record we found doesn't settle this": 'We found related bills, but they don’t point either way: no vote by them, a mixed sponsorship and vote, a bill that can be read both ways, or rules that set the bills aside.',
  "We can't make a reliable call on this": 'Our reading leaned one way but not clearly enough, the reviewer didn’t back it, or we lacked a reliable summary of the version they acted on. We show the bills so you can judge.',
  'This is too broad to check against specific bills': 'The statement needs to name a policy, program or bill before votes can settle it.',
  "We don't think a vote can settle this": 'What was said isn’t something legislation decides.',
  "We couldn't complete this check": 'A step failed for this answer. That says nothing about the member either way.',
};

export const SAFEGUARDS: { title: string; body: string }[] = [
  { title: 'Accusations need a confident reading', body: `An “Inconsistent” or “Broke” answer needs a confident reading of the deciding bill (at least ${pct(M.accusationFloor)} on our scale). Below that, we say we can’t make a reliable call.` },
  { title: 'A second reviewer from a different company', body: 'Every accusation is reviewed by an AI from a different company than the bill reader. If it doesn’t agree, nothing is published.' },
  { title: 'The bill reader never knows who voted', body: 'It reads the bill and your statement only, so it can’t lean toward or against a person or party.' },
  { title: 'The write-up can’t change the answer', body: 'It is written after the answer is fixed, and checked for invented numbers, guesses about motive, and contradictions.' },
  { title: 'Feedback goes to a person', body: '“Something look wrong?” reports are read by a person and never change an answer automatically.' },
];

export const CHECK_OUR_WORK: string[] = [
  'Every bill links to its page on congress.gov.',
  'The “How we checked” tab on every answer walks through these steps for that answer.',
  'You can correct how we read your question and run the check again.',
  '“Something look wrong?” sits under the answer and under each bill.',
  'The trace link under each answer shows every step and every model call behind it.',
  'Follow-up questions are answered only from that answer’s own record.',
];

export const LIMITS: string[] = [
  'Senate record only, from January 2023. Laws passed before then aren’t included.',
  'House votes aren’t included yet, and only the members listed on the home page are checked today.',
  'Bill summaries and readings are written by AI and can be wrong. The same bill can occasionally be read differently on different runs; a fix is planned.',
  'We don’t judge whether a policy is good, rate members, or guess at motives.',
];

export const SOURCES: TechRow[] = [
  { label: 'Senate votes and bill texts', value: 'Public records, collected with the open-source unitedstates/congress tools.' },
  { label: 'Sponsorships', value: 'The congress.gov API.' },
  { label: 'Members', value: 'The open-source unitedstates/congress-legislators data, checked against congress.gov.' },
  { label: 'Coverage', value: `Congresses ${M.coverage.congresses.join(' and ')} (since ${M.coverage.since}), ${REFRESH}.` },
];

export const MODELS_TABLE: TechRow[] = [
  { label: 'Reading your question', value: M.models.classify },
  { label: 'Summarizing each bill', value: M.models.billSummary },
  { label: 'Search fingerprints', value: M.models.embedding },
  { label: 'Relevance check', value: M.models.relevance },
  { label: 'Reading each bill', value: M.models.fulfill },
  { label: 'Reviewing accusations', value: M.models.judge },
  { label: 'Writing the explanation', value: M.models.explain },
];

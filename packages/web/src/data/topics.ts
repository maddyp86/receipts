// ===========================================================================
// Starting points for people who are not sure how to phrase it.
//
// Every example is a STATEMENT WITH A DIRECTION, because that is what the
// checker can test: a question ("what is his stance on…?") or a bare topic
// gives it nothing to measure a vote against.
//
// Where a topic is contested, the examples point both ways, in the same
// neutral wording, so the list does not presume which side a member is on.
// ===========================================================================

export interface TopicExample {
  text: string;
}

export interface Topic {
  id: string;
  label: string;
  examples: TopicExample[];
}

/**
 * Helper text for the question box: what a checkable statement looks like.
 * Specific on purpose — a broad one ("I support our veterans") is too broad to
 * hold against bills — and naming no senator, since the list grows. The old
 * placeholder, "lower prescription drug prices", pointed at a law from before
 * the record starts.
 */
export const SPECIFIC_EXAMPLES = [
  'promised to protect clean air standards from rollback',
  'promised to require photo ID to vote',
  'promised to classify fentanyl-related drugs as Schedule I',
];

export const topics: Topic[] = [
  {
    id: 'health',
    label: 'Health care',
    examples: [
      { text: 'cap the cost of insulin at $35 a month' },
      { text: 'protect coverage for people with pre-existing conditions' },
    ],
  },
  {
    id: 'abortion',
    label: 'Abortion',
    examples: [
      { text: 'supports protecting access to abortion' },
      { text: 'supports restricting abortion' },
      { text: 'opposes federal funding for abortion' },
    ],
  },
  {
    id: 'guns',
    label: 'Guns',
    examples: [
      { text: 'expand background checks for gun sales' },
      { text: 'protect the right to carry a concealed firearm across state lines' },
      { text: 'ban assault weapons' },
    ],
  },
  {
    id: 'immigration',
    label: 'Immigration',
    examples: [
      { text: 'secure the border and stop illegal immigration' },
      { text: 'create a path to citizenship for Dreamers' },
    ],
  },
  {
    id: 'taxes',
    label: 'Taxes',
    examples: [
      { text: 'extend the 2017 tax cuts' },
      { text: 'make large corporations pay more in taxes' },
      { text: 'expand the child tax credit' },
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs & the economy',
    examples: [
      { text: 'raise the federal minimum wage' },
      { text: 'end tariffs on imported goods' },
      { text: 'pass clear rules for stablecoins and crypto' },
    ],
  },
  {
    id: 'environment',
    label: 'Environment & energy',
    examples: [
      { text: 'protect clean air standards from rollback' },
      { text: 'expand oil and gas production' },
      { text: 'expand clean energy tax credits' },
    ],
  },
  {
    id: 'education',
    label: 'Education',
    examples: [{ text: 'cancel student debt' }, { text: 'expand Pell Grants' }],
  },
  {
    id: 'social-security',
    label: 'Social Security',
    examples: [
      { text: 'protect Social Security benefits from cuts' },
      { text: 'end the penalties that cut Social Security for teachers, firefighters and police' },
    ],
  },
  {
    id: 'voting',
    label: 'Voting',
    examples: [{ text: 'require photo ID to vote' }, { text: 'make Election Day a federal holiday' }],
  },
];

/** What the checker cannot test, shown under the input, each with what to do instead. */
export const phrasingTips: ReadonlyArray<{ text: string; why: string }> = [
  { text: 'What is their stance on abortion?', why: 'a question has no side to check. Say which way: “supports…” or “opposes…”' },
  { text: 'supports our veterans', why: 'too broad. Name the policy, program or bill' },
  { text: 'is a good leader', why: 'can’t be checked against bills' },
];

// ===========================================================================
// Starting points for people who are not sure how to phrase it.
//
// Every example is a QUESTION THE WAY A READER WOULD ASK IT, with a side in it
// ("Did they vote to …?", "Do they support …?"). Input clean-up restates a
// question with a side as the position it asks about and checks that; a
// question with no side ("what is his stance on…?") is asked which way. So
// each example here must name the policy and the direction, or it would stop
// to ask.
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
      { text: 'Do they support capping the cost of insulin at $35 a month?' },
      { text: 'Do they support protecting coverage for people with pre-existing conditions?' },
    ],
  },
  {
    id: 'abortion',
    label: 'Abortion',
    examples: [
      { text: 'Did they vote to protect access to abortion?' },
      { text: 'Do they support restricting abortion?' },
      { text: 'Do they oppose federal funding for abortion?' },
    ],
  },
  {
    id: 'guns',
    label: 'Guns',
    examples: [
      { text: 'Did they vote to expand background checks for gun sales?' },
      { text: 'Do they support the right to carry a concealed firearm across state lines?' },
      { text: 'Did they vote to ban assault weapons?' },
    ],
  },
  {
    id: 'immigration',
    label: 'Immigration',
    examples: [
      { text: 'Did they vote to secure the border and stop illegal immigration?' },
      { text: 'Do they support a path to citizenship for Dreamers?' },
    ],
  },
  {
    id: 'taxes',
    label: 'Taxes',
    examples: [
      { text: 'Did they vote to extend the 2017 tax cuts?' },
      { text: 'Do they support making large corporations pay more in taxes?' },
      { text: 'Did they vote to expand the child tax credit?' },
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs & the economy',
    examples: [
      { text: 'Did they vote to raise the federal minimum wage?' },
      { text: 'Do they support ending tariffs on imported goods?' },
      { text: 'Did they vote for clear rules for stablecoins and crypto?' },
    ],
  },
  {
    id: 'environment',
    label: 'Environment & energy',
    examples: [
      { text: 'Did they vote to protect clean air standards from rollback?' },
      { text: 'Do they support expanding oil and gas production?' },
      { text: 'Did they vote to expand clean energy tax credits?' },
    ],
  },
  {
    id: 'education',
    label: 'Education',
    examples: [
      { text: 'Do they support canceling student debt?' },
      { text: 'Did they vote to expand Pell Grants?' },
    ],
  },
  {
    id: 'social-security',
    label: 'Social Security',
    examples: [
      { text: 'Did they vote to protect Social Security benefits from cuts?' },
      { text: 'Did they vote to end the penalties that cut Social Security for teachers, firefighters and police?' },
    ],
  },
  {
    id: 'voting',
    label: 'Voting',
    examples: [
      { text: 'Do they support requiring photo ID to vote?' },
      { text: 'Do they support making Election Day a federal holiday?' },
    ],
  },
];

/**
 * "How to ask", under the input: a weak way to put it, then better ones to try.
 * The examples replace explanations. Wording is approved as written; change it
 * only with sign-off.
 */
export const askingPairs: ReadonlyArray<{ instead: string; tries: readonly string[] }> = [
  {
    instead: 'What is their stance on abortion?',
    tries: ['Did they vote to protect abortion access?', 'Did they vote to limit abortion after 15 weeks?'],
  },
  {
    instead: 'Do they support our veterans?',
    tries: ['Have they backed expanding VA health care?', "Did they vote to raise veterans' disability pay?"],
  },
];

/** The one thing no rewording fixes. */
export const cantCheck = { text: 'Are they a good leader?', why: "a voting record can't answer that" };

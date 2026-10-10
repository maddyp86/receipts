// Tap-to-define terms. Plain language, one or two sentences each.

export type GlossaryId =
  | 'cloture'
  | 'passage'
  | 'sponsor'
  | 'cosponsor'
  | 'not_voting'
  | 'congress'
  | 'strength'
  | 'counted'
  | 'related'
  | 'senate'
  | 'house'
  | 'district'
  | 'position';

export interface GlossaryEntry {
  id: GlossaryId;
  term: string;
  definition: string;
}

export const glossary: GlossaryEntry[] = [
  {
    id: 'senate',
    term: 'Senate',
    definition: 'One of the two parts of Congress. Every state has 2 senators. They serve 6-year terms.',
  },
  {
    id: 'house',
    term: 'House of Representatives',
    definition:
      'The other part of Congress. Each state is split into districts by population, and each district elects 1 representative for a 2-year term.',
  },
  {
    id: 'district',
    term: 'Congressional district',
    definition: 'The area a representative is elected from. Small states may have just one district — the whole state.',
  },
  {
    id: 'position',
    term: 'Promise or position',
    definition:
      'A promise is something they said they would do. A position is something they say they support or oppose. We check both against their votes and bills.',
  },
  {
    id: 'cloture',
    term: 'Ending debate (cloture)',
    definition:
      'A Senate vote to stop talking about a bill and move to a decision. It takes 60 of the 100 senators to pass.',
  },
  {
    id: 'passage',
    term: 'Final passage',
    definition:
      'The last vote on a bill in the Senate or the House. If it passes, the bill goes on to the other chamber or to the President.',
  },
  {
    id: 'sponsor',
    term: 'Sponsor',
    definition: 'The member of Congress who writes and introduces a bill. Their name goes on it first.',
  },
  {
    id: 'cosponsor',
    term: 'Co-sponsor',
    definition: 'A member who signs on to a bill to show support. They didn’t write it, but they back it.',
  },
  {
    id: 'not_voting',
    term: 'Not voting',
    definition: 'The member did not cast a vote. The record doesn’t say why.',
  },
  {
    id: 'congress',
    term: 'Congress numbers',
    definition: 'Each Congress lasts two years. The 118th Congress was 2023–24. The 119th is 2025–26.',
  },
  {
    id: 'strength',
    term: 'How strong the evidence is',
    definition:
      'Strong means we found several bills that clearly match and agree. Low means we found few, or they were unclear.',
  },
  {
    id: 'counted',
    term: 'How each bill counts',
    definition:
      'We put two facts together: what they did, and what the bill does to the goal. A NO vote on a bill that sets the goal back still lines up with the goal.',
  },
  {
    id: 'related',
    term: 'Closely or loosely related',
    definition:
      'How directly a bill is about what you asked. Closely related bills tell us more than loosely related ones.',
  },
];

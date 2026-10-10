import type { ScopeClassification } from '@receipts/shared';
import { needsCleanUp } from '../cleanup/cleanUpInput.js';

// ===========================================================================
// A reader's question is not the senator's rhetoric.
//
// The scope classifier was written for statements senators make, where a
// question is rhetoric. On this tool the text is the READER's. Input clean-up
// restates most questions before scope classification; when it is off, failed
// open, or passed the text through, a question-shaped text would be refused as
// rhetoric ("doesn't look like something a vote can settle"). Read it as a
// position instead, and let interpretation decide: checked, or too broad.
//
// Only RHETORIC, and only question-shaped text. Rhetoric typed as a statement
// ("He fights for working families") still halts; so do the other speech acts.
// ===========================================================================

export function asReaderQuestion(
  scope: ScopeClassification,
  text: string,
): { scope: ScopeClassification; overridden: boolean } {
  if (scope.speech_act !== 'RHETORIC' || !needsCleanUp(text)) return { scope, overridden: false };
  return {
    scope: {
      ...scope,
      speech_act: 'POSITION',
      reasoning: `${scope.reasoning} [Overridden: a reader's question, not the senator's rhetoric — read as a position.]`,
    },
    overridden: true,
  };
}

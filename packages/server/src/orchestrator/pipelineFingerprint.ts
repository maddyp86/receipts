import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { CLASSIFY_SYSTEM_PROMPT } from '../evaluation/classify.js';
import { EVALUATOR_SYSTEM_PROMPT } from '../evaluation/evaluatorPromptV7.js';
import { RELEVANCE_SYSTEM_PROMPT } from '../evaluation/relevancePrompt.js';
import { JUDGE_SYSTEM_PROMPT } from '../judge/judgePrompt.js';
import { SCOPE_CLASSIFIER_SYSTEM_PROMPT } from '../scope/scopeClassifierPrompt.js';
import { EXPLANATION_CONSTRAINTS, systemPrompt } from './prompts.js';
import { TOOL_DEFINITIONS } from './toolDefs.js';

// ===========================================================================
// What a stored answer was produced BY: every prompt that shapes a verdict
// or its explanation, the tool definitions, the models, and the deployed
// commit (Render sets RENDER_GIT_COMMIT). A change to any of them is a new
// pipeline, and an answer from the old one is not reused (data/AnswerCache).
//
// The commit is there because prompts are not the only thing that decides an
// answer — scoring rules and gates are code. In practice a deploy also empties
// the in-memory cache; the commit makes the rule hold if that ever changes.
// ===========================================================================

let memo: string | null = null;

export function pipelineFingerprint(): string {
  if (memo) return memo;
  const parts = [
    systemPrompt(),
    EXPLANATION_CONSTRAINTS,
    JSON.stringify(TOOL_DEFINITIONS),
    CLASSIFY_SYSTEM_PROMPT,
    SCOPE_CLASSIFIER_SYSTEM_PROMPT,
    RELEVANCE_SYSTEM_PROMPT,
    EVALUATOR_SYSTEM_PROMPT,
    JUDGE_SYSTEM_PROMPT,
    JSON.stringify(config.models),
    config.answerReuse.commit,
  ];
  memo = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
  return memo;
}

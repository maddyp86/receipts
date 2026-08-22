import { primaryIssues } from '../embeddings/taxonomy.js';

// ===========================================================================
// The model-callable tool surface (PRD §10.3).
//
// Note what each tool's INPUT is, because that is where the architecture lives:
//
//   interpret_promise  input = the model's classification      (ADVISORY)
//   evaluate_effects   input = the model's per-bill effects    (ADVISORY)
//   explain_result     input = the model's prose               (its judgement)
//   everything else    input = nothing, or an id
//
// The model never passes in a verdict, a band, or a ranking, because there is
// nowhere to put one. `explain_result` receives a frozen result it cannot alter.
//
// ── ADVISORY, since 2026-08-19 ─────────────────────────────────────────────
// Two of these inputs are no longer authoritative. Classification runs on a
// dedicated call to `models.classify`, and bill effect on a dedicated call to
// `models.fulfill` using WF10A's own prompt — the models and prompts that
// produced the corpus. Where the orchestrating model disagrees, the dedicated
// evaluator governs and the disagreement is returned rather than resolved
// silently.
//
// The inputs are still COLLECTED, deliberately: a disagreement is a signal
// worth seeing, and asking the model to reason about effect keeps its narration
// grounded in the same question the evaluator answered. But the number that
// scores is never the orchestrator's.
// ===========================================================================

export const TOOL_DEFINITIONS = [
  {
    name: 'interpret_promise',
    description:
      "Record your reading of the user's promise: its issue classification, stance, type, and a neutral restatement. The server validates the classification against the approved taxonomy, looks up the bridging keywords, and builds the query text. Call this first.",
    input_schema: {
      type: 'object' as const,
      properties: {
        restated: {
          type: 'string',
          description:
            'One-line neutral paraphrase of the promise, shown to the user so they can catch a misread.',
        },
        primary_issue: {
          type: 'string',
          description: `Exact Primary Issue from the approved taxonomy. Known values include: ${primaryIssues().join(', ')}.`,
        },
        sub_issue: {
          type: 'string',
          description: 'Exact Sub Issue from the approved taxonomy for that Primary Issue.',
        },
        stance: {
          type: 'string',
          enum: ['In Favor', 'Opposed', 'Neutral/Unclear'],
          description: 'What the promise wants.',
        },
        promise_type: {
          type: 'string',
          enum: ['policy', 'process', 'rhetorical', 'non_legislative'],
        },
        is_evaluable: {
          type: 'boolean',
          description:
            'Whether this promise is specific enough to check against legislative action at all.',
        },
        key_policy_terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific vocabulary from the promise itself — named bills, programs, mechanisms. Not generic words like "legislation" or "Americans".',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence on why you classified it this way.',
        },
      },
      required: [
        'restated',
        'primary_issue',
        'sub_issue',
        'stance',
        'promise_type',
        'is_evaluable',
        'key_policy_terms',
        'reasoning',
      ],
      additionalProperties: false,
    },
  },

  {
    name: 'resolve_senator',
    description:
      'Check whether the selected senator has been analysed. If they have not, the query stops here and the user is told honestly — do not attempt to answer from general knowledge.',
    input_schema: {
      type: 'object' as const,
      properties: {
        politician_id: { type: 'string', description: 'The senator id supplied with the query.' },
      },
      required: ['politician_id'],
      additionalProperties: false,
    },
  },

  {
    name: 'embed_text',
    description:
      'Embed the query text produced by your interpretation, using the same model and template as the batch pipeline. Takes no arguments — the server holds the text.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },

  {
    name: 'search_actions',
    description:
      "Search the senator's already-analysed bills and votes with the embedding. Returns matches above the relevance floor with their metadata. Takes no arguments.",
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },

  {
    name: 'evaluate_effects',
    description:
      "Submit your READING of each matched bill's effect, then receive the finished result. Your bill_effect is ADVISORY — a cross-check, not the decision. A dedicated fulfillment evaluator (the same model and prompt that scored the whole corpus) judges each bill independently, and where you disagree the evaluator governs; the disagreement comes back in effect_disagreements. The server then computes the verdict, confidence band, ranking and factor receipt deterministically. Do not contradict what comes back.",
    input_schema: {
      type: 'object' as const,
      properties: {
        effects: {
          type: 'array',
          description:
            'One entry per matched action returned by search_actions. Advisory: recorded and compared against the fulfillment evaluator, which decides.',
          items: {
            type: 'object',
            properties: {
              action_uid: { type: 'string' },
              bill_effect: {
                type: 'string',
                enum: ['ADVANCE', 'HINDER', 'NEUTRAL'],
                description:
                  "Your reading of the bill's direction of travel on the goal stated in the promise. Apply the promise's stance here and only here. Advisory — the fulfillment evaluator's verdict is the one that scores.",
              },
              bill_effect_reasoning: {
                type: 'string',
                description:
                  'One or two sentences on how this bill\'s mechanisms affect the promise goal.',
              },
            },
            required: ['action_uid', 'bill_effect', 'bill_effect_reasoning'],
            additionalProperties: false,
          },
        },
      },
      required: ['effects'],
      additionalProperties: false,
    },
  },

  {
    name: 'explain_result',
    description:
      'Write the plain-language explanation of the frozen result, plus one "why this bill" line per evidence card. The server rejects wording that contradicts the verdict, leaks statistics, or attributes motive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        why: {
          type: 'string',
          description:
            '2–3 sentences a voter can read with no other context: what the senator did, what the bill would do to the goal, and why that produced this outcome.',
        },
        connectors: {
          type: 'array',
          description: 'One short connector line per evidence card.',
          items: {
            type: 'object',
            properties: {
              action_uid: { type: 'string' },
              line: {
                type: 'string',
                description:
                  'One line on how this bill relates to the promise, in the voter\'s vocabulary.',
              },
            },
            required: ['action_uid', 'line'],
            additionalProperties: false,
          },
        },
        confidence: {
          type: 'number',
          description:
            'Your confidence that this explanation accurately describes the record. NOT confidence in the verdict.',
        },
      },
      required: ['why', 'connectors', 'confidence'],
      additionalProperties: false,
    },
  },

  {
    name: 'queue_senator',
    description:
      'Record a request for an unanalysed senator so their coverage can be prioritised. Call this only after resolve_senator reports the senator is not cached.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

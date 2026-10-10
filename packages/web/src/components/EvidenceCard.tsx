import { useId, useState, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  MinusIcon,
  PenLineIcon,
  PlusIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react';
import { FeedbackControl, type FeedbackContext } from './FeedbackControl.js';
import {
  EFFECT_UNREAD,
  STRENGTH_PHRASE,
  VOTE_FLAG_COPY,
  textVersionLines,
  congressLabel,
  congressOfBillId,
  governingVoteSentence,
  HISTORY_UNAVAILABLE_COPY,
  surnameOf,
  type DirectedAction,
} from '@receipts/shared';
import { GlossaryTerm } from './glossary/GlossaryTerm.js';
import type { GlossaryId } from '../data/glossary.js';

// ===========================================================================
// One matched action.
//
// Two rules this component exists to keep:
//   1. Cloture and passage are named separately, never merged into "voted".
//   2. Behaviour is described, motive never is. A senator who sponsored a bill
//      and then didn't vote gets "did not cast a vote", not "avoided the vote"
//      — illness, a family emergency and strategy are indistinguishable here.
//   3. Naming both votes is only HALF of behavioural contract 2. The other half
//      is saying which one GOVERNED. "Voted NAY -> BROKE" beside an unmentioned
//      cloture YEA is the claim a senator's office knocks down (handoff v2 §4),
//      and naming both without saying which decided leaves the reader to guess
//      at the very point the verdict turns on.
//   4. A date is only called the day the senator acted when it is one. The
//      mirror supplies the first day of the Congress when it has no exact date
//      and the gates flag it; that renders as the Congress and "exact date not
//      in our record", never as a date.
//
// The card leads with the two facts a reading is made of — what the member
// did, and what the bill does to the goal — side by side, then how they
// combine. A NO vote on a bill that sets the goal back lines up with the goal,
// and that is far easier to see as two facts than as one sentence.
// ===========================================================================

type ActionKind = 'yes' | 'no' | 'not_voting' | 'sponsored' | 'cosponsored' | 'none';

interface ActionLine {
  kind: ActionKind;
  label: string;
  /** What the vote was on, with the glossary term that explains it. */
  context?: { text: string; glossary: GlossaryId };
  date?: string | null;
}

const ACTION_ICON: Record<ActionKind, typeof CheckIcon> = {
  yes: ThumbsUpIcon,
  no: ThumbsDownIcon,
  not_voting: CircleDashedIcon,
  sponsored: PenLineIcon,
  cosponsored: UserPlusIcon,
  none: MinusIcon,
};

function voteKind(v: string | undefined): { kind: ActionKind; label: string } | null {
  const up = String(v ?? '').toUpperCase();
  if (up === 'YEA') return { kind: 'yes', label: 'Voted YES' };
  if (up === 'NAY') return { kind: 'no', label: 'Voted NO' };
  return null;
}

/**
 * What the member did, one line per act.
 *
 * Cloture and passage are separate lines, never merged into "voted" (rule 1).
 * Behaviour only: a sponsor recorded as not voting "did not cast a vote" —
 * never "avoided" it (rule 2).
 */
function actionLines(e: DirectedAction): ActionLine[] {
  const lines: ActionLine[] = [];
  const cloture = voteKind(e.cloture_vote);
  const passage = voteKind(e.passage_vote);

  if (cloture) {
    lines.push({ ...cloture, context: { text: 'to end debate', glossary: 'cloture' }, date: formatDate(e.cloture_vote_date) });
  }
  if (passage) {
    lines.push({ ...passage, context: { text: 'on final passage', glossary: 'passage' }, date: formatDate(e.passage_vote_date) });
  }
  if (!lines.length) {
    const flat = voteKind(e.vote);
    if (flat) lines.push({ ...flat });
  }

  const role: ActionLine | null = e.is_sponsor
    ? { kind: 'sponsored', label: 'Sponsored', context: { text: 'wrote and introduced it', glossary: 'sponsor' } }
    : e.is_cosponsor
      ? { kind: 'cosponsored', label: 'Co-sponsored', context: { text: 'signed on to support it', glossary: 'cosponsor' } }
      : null;

  // Sponsored but recorded as not voting. Say exactly what happened.
  if (e.action_tier === 'ABSTAIN') {
    return [
      ...(role ? [role] : []),
      { kind: 'not_voting', label: 'Did not cast a vote', context: { text: 'when it came to the floor', glossary: 'not_voting' } },
    ];
  }

  if (role) lines.push(role);
  return lines.length ? lines : [{ kind: 'none', label: 'No recorded action' }];
}

interface EffectReading {
  Icon: typeof CheckIcon;
  label: string;
}

/**
 * The bill's effect on the goal, as the evaluator read it — short form for the
 * card. A reading, so the cell is headed "as we read it". Null when the bill
 * was not read and a disclosure flag below already says so (EFFECT_UNREAD).
 */
function effectReading(e: DirectedAction): EffectReading | null {
  const effect = String(e.bill_effect ?? '').toUpperCase();
  if (effect === 'ADVANCE') return { Icon: ArrowRightIcon, label: 'Moves it forward' };
  if (effect === 'HINDER') return { Icon: ArrowLeftIcon, label: 'Sets it back' };
  if (effect === 'NEUTRAL') return { Icon: MinusIcon, label: 'Doesn’t move it either way' };
  if (effect === 'CONTESTED') return { Icon: ArrowLeftRightIcon, label: 'Could be read either way' };
  if (effect === 'ERROR') return { Icon: CircleHelpIcon, label: 'We couldn’t read this bill' };
  return null;
}

/**
 * A date as a reader says it, or null when there is no real date.
 *
 * The record carries dates in two spellings: ISO (`2024-07-10`) and the
 * sheet's `7/10/2024`. Both are calendar days with no time zone, so both are
 * read as that day in UTC — parsing the second through `new Date()` reads it in
 * the reader's own zone, and east of Greenwich that prints the day before.
 */
function formatDate(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const parts = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : null;
  if (!parts) return null;
  const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const BILL_PREFIX: Record<string, string> = {
  s: 'S.',
  hr: 'H.R.',
  sjres: 'S.J.Res.',
  hjres: 'H.J.Res.',
  sres: 'S.Res.',
  hres: 'H.Res.',
  sconres: 'S.Con.Res.',
  hconres: 'H.Con.Res.',
};

/**
 * The bill as it is cited — "S. 25", "H.J.Res. 45" — from the id, which always
 * carries type and number (`s25-118`). Null when the id is not in that shape;
 * the id itself is shown either way.
 */
function billCitation(billId: string): string | null {
  const m = /^([a-z]+)(\d+)-\d+$/.exec(String(billId ?? '').toLowerCase());
  const prefix = m ? BILL_PREFIX[m[1]!] : undefined;
  return m && prefix ? `${prefix} ${m[2]}` : null;
}

/** "a; b; c" as separate items. One item when there is nothing to split. */
function splitList(text: string): string[] {
  return text
    .split(/;\s+/)
    .map((t) => t.trim().replace(/[.;]$/, ''))
    .filter(Boolean);
}

interface Stakeholder {
  group: string;
  positive: string | null;
  negative: string | null;
}

/**
 * Who the bill affects. The pipeline stores this as a JSON list of
 * {group, positive impacts, negative impacts}; printed as-is it is a wall of
 * brackets and keys. Null when the cell is not that shape, and the caller
 * prints the text unchanged.
 */
function parseStakeholders(raw: string): Stakeholder[] | null {
  const text = raw.trim();
  if (!text.startsWith('[')) return null;
  try {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) return null;
    const said = (v: unknown) => {
      const t = typeof v === 'string' ? v.trim() : '';
      return t && !/^none identified\.?$/i.test(t) ? t : null;
    };
    const out = rows
      .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
      .map((r) => ({
        group: typeof r['Stakeholder Group'] === 'string' ? (r['Stakeholder Group'] as string).trim() : '',
        positive: said(r['Positive Impacts']),
        negative: said(r['Negative Impacts']),
      }))
      .filter((r) => r.group);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * When it happened, honestly.
 *
 * A real roll-call date is already on the vote line. This line covers the
 * rest: a sponsorship, or an action whose only date is the stand-in. The
 * Congress is always known (it is in the bill id), so the reader always gets
 * at least "during the 118th Congress (2023–2024)".
 */
function whenLine(e: DirectedAction, congress: number | null): string | null {
  const proxy = (e.vote_flags ?? []).includes('ACTION_DATE_PROXY');
  const hasRollCall = Boolean(formatDate(e.cloture_vote_date) || formatDate(e.passage_vote_date));
  if (hasRollCall) return null; // the vote line above already carries the date
  const real = !proxy ? formatDate(e.action_date) : null;
  // The record sentence already dates a sponsorship ("… introducing it on
  // March 14, 2025"); saying it again on the next line is noise.
  if (real && e.record?.includes(real)) return null;
  if (real) return `When: ${real}.`;
  if (congress) return `When: during the ${congressLabel(congress)} — the exact date is not in our record.`;
  return null;
}

type Direction = DirectedAction['direction'];

const DIRECTION_STYLE: Record<Direction, { Icon: typeof CheckIcon; cls: string }> = {
  keeps: { Icon: CheckIcon, cls: 'bg-kept-wash text-kept' },
  breaks: { Icon: XIcon, cls: 'bg-broken-wash text-broken' },
  neutral: { Icon: MinusIcon, cls: 'bg-cantsay-wash text-cantsay' },
};

/** How this one action counts, in the same words the count line above the cards uses. */
function directionLabel(direction: Direction, promiseVocabulary: boolean): string {
  if (direction === 'neutral') return 'Not counted either way';
  if (promiseVocabulary) return direction === 'keeps' ? 'Points toward keeping it' : 'Points toward breaking it';
  return direction === 'keeps' ? 'Consistent with it' : 'Runs counter to it';
}

interface Props {
  action: DirectedAction;
  connector?: string;
  senatorName: string;
  /** Present when feedback can be sent; the card then offers it. */
  feedback?: FeedbackContext;
  /**
   * Whether to say how this action counts. False on a result with no verdict:
   * a per-bill "runs counter" there would publish, bill by bill, the reading
   * the result as a whole declined to make.
   */
  showDirection?: boolean;
  /** Kept/broken wording — only where the headline uses it. */
  promiseVocabulary?: boolean;
}

export function EvidenceCard({
  action,
  connector,
  senatorName,
  feedback,
  showDirection = true,
  promiseVocabulary = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const relation = STRENGTH_PHRASE[action.strength];
  const governing = governingVoteSentence(action.vote_governing);
  const congress = action.congress ?? congressOfBillId(action.bill_id);
  const when = whenLine(action, congress);
  const versionLines = textVersionLines(action.text_version);
  const disclosures = (action.vote_flags ?? [])
    .map((flag) => ({ flag, copy: VOTE_FLAG_COPY[flag] }))
    // The proxy-date flag is now said in the "When" line, in context. Keeping
    // it here too would say the same thing twice on every sponsorship card.
    .filter((d): d is { flag: string; copy: string } => Boolean(d.copy) && !(d.flag === 'ACTION_DATE_PROXY' && when));

  const lines = actionLines(action);
  const effect = effectReading(action);
  const unreadSaidBelow = (action.vote_flags ?? []).includes(EFFECT_UNREAD);
  const dir = DIRECTION_STYLE[action.direction];
  const surname = surnameOf(senatorName);
  const citation = billCitation(action.bill_id);
  const effects = action.intended_effects ? splitList(action.intended_effects) : [];
  const stakeholders = action.affected_stakeholders ? parseStakeholders(action.affected_stakeholders) : null;

  return (
    <article
      className="evidence rounded-card border border-rule bg-card shadow-soft"
      data-direction={action.direction}
    >
      <div className="p-5">
        {/* Identity line. Bill id and Congress are what a reader needs to look
            the bill up anywhere else; the policy area is the label retrieval
            and the evaluators worked from. */}
        <p className="evidence-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-soft">
          {citation ? <span className="evidence-bill font-mono text-[13px] text-ink">{citation}</span> : null}
          <span className={`font-mono text-[13px] ${citation ? '' : 'text-ink'}`}>{action.bill_id}</span>
          {congress ? (
            <GlossaryTerm id="congress">{congressLabel(congress)}</GlossaryTerm>
          ) : null}
          {action.primary_issue ? (
            <span>
              {action.primary_issue}
              {action.sub_issue ? ` / ${action.sub_issue}` : ''}
            </span>
          ) : null}
        </p>
        <h3 className="evidence-title mt-1 font-serif text-[21px] leading-snug text-ink">{action.title}</h3>

        {connector ? <p className="connector mt-2 text-[16px] leading-relaxed text-ink-soft">{connector}</p> : null}

        {/* Two facts that combine into the tag. */}
        <div className="mt-4 rounded-lg border border-rule">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr]">
            <div className="behaviour p-3.5">
              <p className="text-[13px] text-ink-soft">What {surname} did</p>
              <ul className="mt-1 space-y-2">
                {lines.map((line) => {
                  const Icon = ACTION_ICON[line.kind];
                  return (
                    <li key={`${line.kind}-${line.context?.text ?? ''}`}>
                      <p className="flex items-center gap-1.5 text-[17px] font-semibold text-ink">
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {line.label}
                      </p>
                      {line.context ? (
                        <p className="text-[14px] text-ink-soft">
                          <GlossaryTerm id={line.context.glossary}>{line.context.text}</GlossaryTerm>
                          {line.date ? ` · ${line.date}` : ''}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="flex items-center justify-center border-y border-rule sm:border-y-0" aria-hidden="true">
              <span className="-my-3 flex h-6 w-6 items-center justify-center rounded-full border border-rule bg-paper text-ink-soft sm:my-0">
                <PlusIcon className="h-3.5 w-3.5" />
              </span>
            </div>
            <div className="p-3.5">
              <p className="text-[13px] text-ink-soft">What the bill does to the goal, as we read it</p>
              {effect ? (
                <p className="mt-1 flex items-center gap-1.5 text-[17px] font-semibold text-ink">
                  <effect.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {effect.label}
                </p>
              ) : (
                <p className="mt-1 text-[15px] text-ink-soft">{unreadSaidBelow ? 'Not read — see below.' : 'Not recorded.'}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-3.5 py-2.5">
            {showDirection ? (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[15px] font-semibold ${dir.cls}`}>
                <dir.Icon className="h-4 w-4" strokeWidth={2.75} aria-hidden="true" />
                <GlossaryTerm id="counted">{directionLabel(action.direction, promiseVocabulary)}</GlossaryTerm>
              </span>
            ) : (
              <span className="text-[14px] text-ink-soft">Shown for you to read — not counted toward an answer.</span>
            )}
            <GlossaryTerm id="related" className="relation text-[14px] text-ink-soft">
              {relation.charAt(0).toUpperCase() + relation.slice(1)}
            </GlossaryTerm>
          </div>
        </div>

        {/* What the reading rests on. Each of these changes how the row should
            be READ, so they sit on the card rather than in the drill-down. */}
        <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-soft">
          {when ? <p className="when">{when}</p> : null}

          {/* The record: how and when the member's name went on the bill, the
              committee path, and what became of it. Built server-side from the
              pipeline's columns, never by a model, so it is rendered as written. */}
          {action.record ? <p className="record">{action.record}</p> : null}
          {/* Said where the history would have been, so a missing "reported by
              committee" is not read as "never reported". */}
          {action.history_unavailable ? <p className="record degraded-note">{HISTORY_UNAVAILABLE_COPY}</p> : null}

          {/* Which version of the bill's text this was judged against, and what
              the bill became. Only bills whose text changed carry text_version;
              for every other bill this renders nothing. */}
          {versionLines.length ? (
            <div className="text-version space-y-1">
              {versionLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}

          {/* Which vote decided, in plain language. The raw `vote_governing`
              string is analyst vocabulary — one of its values contains
              "threshold", a banned Level-1 term — so the reader gets a sentence
              and the trace gets the string. */}
          {governing ? <p className="governing font-medium text-ink">{governing}</p> : null}

          {/* Disclosure flags. Flags with no reader copy are analyst vocabulary
              and stay in the trace. */}
          {disclosures.length ? (
            <ul className="disclosures space-y-1.5 rounded-lg bg-cantsay-wash px-3.5 py-3 text-ink">
              {disclosures.map((d) => (
                <li key={d.flag}>{d.copy}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md text-[16px] font-medium text-ink"
          >
            What this bill does
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
          {action.source_url ? (
            <a
              className="source inline-flex min-h-[44px] items-center gap-1.5 text-[16px] font-medium text-focus underline underline-offset-4"
              href={action.source_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the bill on congress.gov
              <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : (
            <p className="text-[15px] font-medium text-ink">No source link available for this action.</p>
          )}
        </div>
      </div>

      {open ? (
        <dl id={panelId} className="evidence-more animate-fade-in space-y-4 border-t border-rule bg-paper px-5 py-5 text-[16px] leading-relaxed">
          {action.summary ? <DetailRow term="In short">{action.summary}</DetailRow> : null}
          {effects.length ? (
            <DetailRow term="What it’s meant to do">
              {effects.length === 1 ? (
                action.intended_effects
              ) : (
                <ul className="list-disc space-y-0.5 pl-5">
                  {effects.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </DetailRow>
          ) : null}
          {action.mechanisms ? <DetailRow term="How it works">{action.mechanisms}</DetailRow> : null}
          {action.affected_stakeholders ? (
            <DetailRow term="Who it affects">
              {stakeholders ? (
                <ul className="space-y-2">
                  {stakeholders.map((sh) => (
                    <li key={sh.group}>
                      <span className="font-medium">{sh.group}</span>
                      {sh.positive ? <span className="block text-ink-soft">Helped: {sh.positive}</span> : null}
                      {sh.negative ? <span className="block text-ink-soft">Burdened: {sh.negative}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                action.affected_stakeholders
              )}
            </DetailRow>
          ) : null}
          {action.missing_fields.length ? (
            <DetailRow term="Note">
              Some details for this action weren’t available in our record: {action.missing_fields.join(', ')}.
            </DetailRow>
          ) : null}
        </dl>
      ) : null}

      {feedback ? (
        <div className="border-t border-rule px-5 py-1">
          <FeedbackControl level="evidence" context={feedback} actionUid={action.action_uid} billId={action.bill_id} />
        </div>
      ) : null}
    </article>
  );
}

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[14px] font-medium text-ink-soft">{term}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

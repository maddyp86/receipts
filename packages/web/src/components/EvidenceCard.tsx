import { useId, useState, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  InfoIcon,
  ExternalLinkIcon,
  MinusIcon,
  PenLineIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react';
import { FeedbackControl, FeedbackPrompt, type FeedbackContext } from './FeedbackControl.js';
import {
  EFFECT_UNREAD,
  VOTE_FLAG_COPY,
  textVersionLines,
  congressLabel,
  congressOfBillId,
  billCitation,
  governingVoteSentence,
  HISTORY_UNAVAILABLE_COPY,
  surnameOf,
  type DirectedAction,
  type PathStep,
  type RecordRow,
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
  if (congress) return `When: during the ${congressLabel(congress)}. The exact date is not in our record.`;
  return null;
}

type Direction = DirectedAction['direction'];
type Count = 'toward' | 'against' | 'not';

/** The chip in the card's corner: green, red, or yellow. */
const COUNT_CHIP: Record<Count, { label: string; Icon: typeof CheckIcon; cls: string }> = {
  toward: { label: 'Counts toward', Icon: CheckIcon, cls: 'bg-kept-wash text-kept' },
  against: { label: 'Counts against', Icon: XIcon, cls: 'bg-broken-wash text-broken' },
  not: { label: 'Not counted', Icon: MinusIcon, cls: 'bg-pending-wash text-pending' },
};

const countOf = (direction: Direction, showDirection: boolean): Count =>
  !showDirection || direction === 'neutral' ? 'not' : direction === 'keeps' ? 'toward' : 'against';

/** "Thune voted no", "Thune co-sponsored it" — the act the count rests on, for the chip's explanation. */
function actPhrase(e: DirectedAction, surname: string): string {
  const passage = voteKind(e.passage_vote) ?? voteKind(e.vote);
  const cloture = voteKind(e.cloture_vote);
  const v = passage ?? cloture;
  if (v) return `${surname} voted ${v.kind === 'yes' ? 'yes' : 'no'}${!passage && cloture ? ' to end debate' : ''}`;
  if (e.is_sponsor) return `${surname} sponsored it`;
  if (e.is_cosponsor) return `${surname} co-sponsored it`;
  return surname;
}

/**
 * What the chip means for THIS bill, in plain words. Terms like "counts
 * against" mean nothing on their own (2026-10-11), so the chip opens this.
 */
function countMeaning(e: DirectedAction, count: Count, surname: string, showDirection: boolean): string {
  const effect = String(e.bill_effect ?? '').toUpperCase();
  if (count !== 'not') {
    const bill = effect === 'HINDER' ? 'would set the goal in your question back' : 'would move the goal in your question forward';
    return (
      `${actPhrase(e, surname)} on a bill that, as we read it, ${bill}, so this ` +
      `${count === 'toward' ? 'lines up with' : 'goes against'} the statement. ` +
      'It is one piece of evidence; the answer at the top weighs them all together.'
    );
  }
  if (!showDirection) {
    return 'The answer as a whole doesn’t settle your question, so no single bill is counted for or against. It is shown so you can read it and judge for yourself.';
  }
  if (e.action_tier === 'ABSTAIN') return `${surname} didn’t cast a vote, so there is nothing here to count either way.`;
  if (effect === 'CONTESTED') return 'This bill can reasonably be read as pushing either way on your question, so we don’t count it for or against.';
  if (effect === 'ERROR' || (e.vote_flags ?? []).includes(EFFECT_UNREAD)) return 'We couldn’t read this bill against your question, so it isn’t counted either way.';
  if (effect === 'NEUTRAL') return 'We read this bill as not moving the goal in your question either way, so it isn’t counted for or against.';
  return 'This bill isn’t counted for or against the statement.';
}

/**
 * A record question's chip: how this bill's votes read against what was asked,
 * each stage on its own. "Both ways" when one stage is for and another
 * against: the reader is owed the split, not an average.
 */
function recordChip(rows: RecordRow[], surname: string): { count: Count; label: string; meaning: string } {
  const counted = rows.filter((r) => r.reading === 'for' || r.reading === 'against');
  const fors = counted.some((r) => r.reading === 'for');
  const againsts = counted.some((r) => r.reading === 'against');
  const stage = (r: RecordRow) =>
    r.stage === 'cloture' ? 'to end debate' : r.stage === 'passage' ? 'on the final vote' : '';
  const said = rows.map((r) => {
    if (r.stage === 'sponsor' || r.stage === 'cosponsor') {
      return `${surname} ${r.stage === 'sponsor' ? 'sponsored' : 'co-sponsored'} this bill${r.reading === 'for' ? ', which as we read it would do what you asked about' : r.reading === 'against' ? ', which as we read it would do the opposite' : ''}.`;
    }
    const at = stage(r) ? ` ${stage(r)}` : '';
    if (r.vote === 'NOT_VOTING') return `${surname} did not vote${at}.`;
    const vote = r.vote === 'YEA' ? 'Yea' : 'Nay';
    const reading = r.reading === 'for' ? 'a vote for what you asked about' : r.reading === 'against' ? 'a vote against it' : 'not counted, because we did not read the bill as doing what you asked about';
    return `${surname} voted ${vote}${at}: ${reading}.`;
  });
  const broad = rows.some((r) => r.broad)
    ? ' This was a larger package that covered much more than this, so it does not decide the answer on its own.'
    : '';
  const count: Count = fors && !againsts ? 'toward' : againsts && !fors ? 'against' : 'not';
  const label = fors && againsts ? 'Both ways' : fors ? 'For this' : againsts ? 'Against this' : 'Not counted';
  return { count, label, meaning: `${said.join(' ')}${broad}` };
}

/** The chip, and the plain explanation it opens. */
function CountChip({ count, meaning, label }: { count: Count; meaning: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const chip = { ...COUNT_CHIP[count], ...(label ? { label } : {}) };
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={`count-chip inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold ${chip.cls}`}
        data-count={count}
      >
        <chip.Icon className="h-4 w-4" strokeWidth={2.75} aria-hidden="true" />
        {chip.label}
        <InfoIcon className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
        <span className="sr-only">: what this means</span>
      </button>
      {/* Rendered in the page whether open or not, so it is part of the card's text. */}
      <p id={id} hidden={!open} className="count-meaning order-last mt-2 w-full basis-full rounded-lg bg-paper px-3.5 py-2.5 text-[15px] leading-relaxed text-ink-soft">
        <strong className="font-semibold text-ink">What “{chip.label.toLowerCase()}” means here. </strong>
        {meaning}
      </p>
    </>
  );
}

/** A path date: "Jul 23, 2026". */
function shortDate(iso: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * The bill's path, left to right. The senator's own act is the filled dot.
 * Dots are evenly spaced across the full width: the first step sits flush
 * left, the last flush right, and each middle step is centred on its dot.
 * The grid has two columns per gap, so a middle step spans the two columns
 * either side of its dot.
 */
function BillPath({ steps, surname }: { steps: PathStep[]; surname: string }) {
  const gaps = Math.max(steps.length - 1, 1);
  return (
    <section aria-label="The bill’s path" className="bill-path mt-4">
      <h4 className="text-[14px] font-medium text-ink-soft">The bill’s path</h4>
      <div className="mt-2 overflow-x-auto pb-1">
        <ol
          className="relative grid"
          style={{ gridTemplateColumns: `repeat(${gaps * 2}, minmax(0, 1fr))`, minWidth: `${steps.length * 88}px` }}
        >
          {steps.length > 1 ? <span className="absolute left-[7px] right-[7px] top-[9px] h-0.5 bg-rule" aria-hidden="true" /> : null}
          {steps.map((st, i) => {
            const first = i === 0;
            const last = i === steps.length - 1 && !first;
            const place = first ? 'text-left' : last ? 'text-right' : 'px-2 text-center';
            const dot = first ? 'left-0' : last ? 'right-0' : 'left-1/2 -translate-x-1/2';
            const gridColumn = first ? '1 / span 1' : last ? `${gaps * 2} / span 1` : `${i * 2} / span 2`;
            return (
              <li
                key={`${st.label}-${i}`}
                className={`relative pt-5 text-[13px] leading-snug text-ink-soft ${place}`}
                style={{ gridColumn, gridRow: 1 }}
                data-senator={st.senator ? 'true' : undefined}
              >
                <span
                  className={`absolute top-[3px] h-[14px] w-[14px] rounded-full border-2 ${dot} ${
                    st.senator ? 'border-ink bg-ink' : st.outcome ? 'border-ink-soft bg-card' : 'border-rule bg-card'
                  }`}
                  aria-hidden="true"
                />
                <span className="block font-medium text-ink">{st.label}</span>
                {shortDate(st.date) ? <span className="block">{shortDate(st.date)}</span> : null}
                {st.senator ? <span className="block font-semibold text-ink">{surname}: {st.senator.act}</span> : null}
                {st.note ? <span className="block">{st.note}</span> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
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
  /** A record question: this bill's votes read against what was asked. Replaces the statement chip. */
  recordRows?: RecordRow[];
}

export function EvidenceCard({
  action,
  connector,
  senatorName,
  feedback,
  showDirection = true,
  promiseVocabulary = false,
  recordRows,
}: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const governing = governingVoteSentence(action.vote_governing);
  const congress = action.congress ?? congressOfBillId(action.bill_id);
  const when = whenLine(action, congress);
  const versionLines = textVersionLines(action.text_version);
  const disclosures = (action.vote_flags ?? [])
    .map((flag) => ({ flag, copy: VOTE_FLAG_COPY[flag] }))
    // The proxy-date flag is now said in the "When" line, in context. Keeping
    // it here too would say the same thing twice on every sponsorship card.
    .filter((d): d is { flag: string; copy: string } => Boolean(d.copy) && !(d.flag === 'ACTION_DATE_PROXY' && when))
    // Said in plain words, and only where it applies, by `leaderNote` below.
    .filter((d) => d.flag !== 'FLOOR_LEADER');

  const count = countOf(action.direction, showDirection);
  const onPath = Boolean(action.path?.some((st) => st.note === 'the text we read'));
  // The leadership note only where it changes the reading: a floor leader's
  // NO on a vote to end debate can be procedure, not position. Anywhere else
  // it says nothing a reader can use (2026-10-11).
  const leaderNote =
    (action.vote_flags ?? []).includes('FLOOR_LEADER') && String(action.cloture_vote ?? '').toUpperCase() === 'NAY'
      ? `${surnameOf(senatorName)} was a floor leader at the time. Leaders sometimes vote no on ending debate so they can bring the measure back for another vote later, so that no may be procedure rather than their position.`
      : null;
  const lines = actionLines(action);
  const effect = effectReading(action);
  const unreadSaidBelow = (action.vote_flags ?? []).includes(EFFECT_UNREAD);
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
        {/* Identity line, with how the bill counts in the corner. Bill id and
            Congress are what a reader needs to look the bill up anywhere else. */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <p className="evidence-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-soft">
              {citation ? <span className="evidence-bill font-mono text-[13px] text-ink">{citation}</span> : null}
              <span className={`font-mono text-[13px] ${citation ? '' : 'text-ink'}`}>{action.bill_id}</span>
              {congress ? <GlossaryTerm id="congress">{congressLabel(congress)}</GlossaryTerm> : null}
            </p>
            {action.primary_issue ? (
              <p className="mt-0.5 text-[14px] text-ink-soft">
                {action.primary_issue}
                {action.sub_issue ? ` / ${action.sub_issue}` : ''}
              </p>
            ) : null}
          </div>
          {recordRows ? (
            <CountChip {...recordChip(recordRows, surname)} />
          ) : (
            <CountChip count={count} meaning={countMeaning(action, count, surname, showDirection)} />
          )}
        </div>
        <h3 className="evidence-title mt-2 font-serif text-[21px] leading-snug text-ink">{action.title}</h3>

        {connector ? <p className="connector mt-2 text-[16px] leading-relaxed text-ink-soft">{connector}</p> : null}

        {/* The two facts the count in the corner is made of. */}
        <div className="mt-4 rounded-lg border border-rule">
          <div className="grid grid-cols-1 divide-y divide-rule sm:grid-cols-2 sm:divide-x sm:divide-y-0">
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
            <div className="p-3.5">
              <p className="text-[13px] text-ink-soft">What the bill does to your goal, as we read it</p>
              {effect ? (
                <p className="mt-1 flex items-center gap-1.5 text-[17px] font-semibold text-ink">
                  <effect.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {effect.label}
                </p>
              ) : (
                <p className="mt-1 text-[15px] text-ink-soft">{unreadSaidBelow ? 'Not read. See below.' : 'Not recorded.'}</p>
              )}
            </div>
          </div>
        </div>

        {/* The bill's path, from the record. Without one, the record sentence below says what we know. */}
        {action.path?.length ? <BillPath steps={action.path} surname={surname} /> : null}

        {/* What the reading rests on. Each of these changes how the row should
            be READ, so they sit on the card rather than in the drill-down. */}
        <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-soft">
          {when ? <p className="when">{when}</p> : null}

          {/* The record: how and when the member's name went on the bill, the
              committee path, and what became of it. Built server-side from the
              pipeline's columns, never by a model, so it is rendered as written. */}
          {action.path?.length
            ? action.record_detail ? <p className="record">{action.record_detail}</p> : null
            : action.record ? <p className="record">{action.record}</p> : null}
          {/* Said where the history would have been, so a missing "reported by
              committee" is not read as "never reported". */}
          {action.history_unavailable ? <p className="record degraded-note">{HISTORY_UNAVAILABLE_COPY}</p> : null}

          {/* Which version of the bill's text this was judged against, and what
              the bill became. Only bills whose text changed carry text_version;
              for every other bill this renders nothing. */}
          {/* On the path, the version in effect is marked "the text we read";
              the sentence is still said when it is a disclosure (a later or
              missing text was used) or when the bill was rewritten. */}
          {versionLines.length && !(onPath && action.text_version?.status === 'SELECTED' && !action.text_version.rewritten) ? (
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
          {leaderNote ? <p className="leader-note rounded-lg bg-cantsay-wash px-3.5 py-3 text-ink">{leaderNote}</p> : null}

          {disclosures.length ? (
            <ul className="disclosures space-y-1.5 rounded-lg bg-cantsay-wash px-3.5 py-3 text-ink">
              {disclosures.map((d) => (
                <li key={d.flag}>{d.copy}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Link first, then the drop-down: the panel opens from the bottom of the card. */}
        <div className="mt-4 flex flex-col gap-2">
          {action.source_url ? (
            <a
              className="source inline-flex self-start min-h-[44px] items-center gap-1.5 text-[16px] font-medium text-focus underline underline-offset-4"
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
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg border border-rule bg-paper px-3.5 text-[16px] font-medium text-ink transition-colors duration-150 hover:border-ink"
          >
            What this bill does
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
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
          {feedback.prompts ? (
            <FeedbackPrompt level="evidence" context={feedback} actionUid={action.action_uid} billId={action.bill_id} />
          ) : (
            <FeedbackControl level="evidence" context={feedback} actionUid={action.action_uid} billId={action.bill_id} />
          )}
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

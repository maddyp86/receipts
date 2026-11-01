import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  MinusIcon,
  ShieldCheckIcon,
  MessageSquareQuoteIcon,
  XIcon,
} from 'lucide-react';
import {
  answerLabelLine,
  answerReasonLine,
  BAND_LEVEL,
  BAND_REASON_COPY,
  assertedPromiseLine,
  billCitation,
  congressOfBillId,
  confidencePhrase,
  ND_NO_REASON_COPY,
  ND_REASON_COPY,
  RESULT_SCOPE_LINE,
  confidenceTraceLabel,
  evidenceTallySentence,
  judgeDispositionSentence,
  likelyOutcomeHeadline,
  notDeterminableReason,
  recordBoundarySentence,
  notDeterminableHeadline,
  reusedSentence,
  searchFunnel,
  searchSummarySentence,
  verdictWord,
  type DirectedAction,
  type QueryResult,
} from '@receipts/shared';
import { EvidenceCard } from './EvidenceCard.js';
import { FeedbackControl, FeedbackPrompt, type FeedbackContext } from './FeedbackControl.js';
import { GatedActions } from './GatedActions.js';
import { NotCounted } from './NotCounted.js';
import { HowWeGotHere } from './HowWeGotHere.js';
import { CoverageNote, EnrichmentGapNote } from './States.js';
import { GlossaryTerm } from './glossary/GlossaryTerm.js';

// ===========================================================================
// The two-level receipt.
//
// Level 1 is plain language and carries no statistics — the words "similarity",
// "confidence band" and any score are absent by construction, because the copy
// comes from the shared vocabulary table rather than from formatting the
// numbers. The one number it does carry is a count of actions found, which a
// reader can check against the cards below.
//
// Level 2 is "How we got here": the path from the statement to the verdict, in
// plain language, one step per gate, derived from the result's own fields.
//
// Level 3 is the analyst drill-down: the same factors as raw values, the
// gate/dial trace, and the flags. A skeptic can disagree with the weighting and
// still trust the facts. It sits one toggle deeper than the walkthrough because
// it reads as the internal system it is — right for an analyst, wrong as the
// first thing a reader opens.
//
// LAYOUT. The result page puts the verdict card in a narrow column that stays
// in view and the bills in a wide one beside it, so this file exports the two
// halves separately (`VerdictCard`, `EvidenceList`) and `Verdict`, which is
// both in reading order — what the eval harness and the tests render.
// ===========================================================================

const VERDICT_STYLE: Record<string, { Icon: typeof CheckIcon; text: string; bg: string; wash: string }> = {
  KEPT: { Icon: CheckIcon, text: 'text-kept', bg: 'bg-kept', wash: 'bg-kept-wash' },
  BROKE: { Icon: XIcon, text: 'text-broken', bg: 'bg-broken', wash: 'bg-broken-wash' },
  NOT_DETERMINABLE: { Icon: MinusIcon, text: 'text-cantsay', bg: 'bg-cantsay', wash: 'bg-cantsay-wash' },
};

/** Where the bills start, for the phone's "see the bills" link. */
export const EVIDENCE_ANCHOR = 'the-bills';

/** Promise wording only where the headline uses it — the rule `evidenceTallySentence` applies. */
function usesPromiseVocabulary(result: QueryResult): boolean {
  // Any promise, the reader's (asserted) included: the card says whose it is
  // (assertedPromiseLine).
  return result.interpretation.statement_type !== 'Policy Position';
}

/**
 * The headline, in the STATEMENT'S vocabulary.
 *
 * `scored.verdict` is the internal bucket and is KEPT for a consistent policy
 * position as much as for a kept campaign promise. The word a reader sees is
 * chosen by statement type and provenance in `likelyOutcomeHeadline` — this
 * component used to print VERDICT_PHRASE directly, so every free-typed
 * statement was headlined "Kept" while its own evidence cards said CONSISTENT.
 * A position is never kept; nobody promised anything. "Likely" because the
 * verdict is a reading of the record.
 */
/**
 * The headline and its subheadline (15 Oct): a short verdict in display type,
 * then the confidence and its reason in body type. "Their record" is dropped
 * from the verdict because the label above it already says "Their record vs.
 * this position".
 */
function headlineParts(result: QueryResult): [string, string] {
  const { verdict, band, mode, receipt } = result.scored;
  // By reason: a failed check is headlined as a fact about the tool, not as
  // "we couldn't find enough", which reads as a fact about the record.
  if (verdict === 'NOT_DETERMINABLE') return [notDeterminableHeadline(result.scored.nd_reason), ''];
  const { statement_type, provenance } = result.interpretation;
  const full = likelyOutcomeHeadline(verdict, statement_type, provenance);
  const short = full.replace(/^Their record (is )?/, '');
  const lead = `${short.charAt(0).toUpperCase()}${short.slice(1)}${mode === 'ranked' ? ', but it’s mixed' : ''}`;
  if (!band) return [lead, ''];
  const level = BAND_LEVEL[band];
  const why = receipt.band_reason
    ? BAND_REASON_COPY[receipt.band_reason]
    : mode === 'ranked' ? 'the record points both ways' : '';
  return [lead, `${level.charAt(0).toUpperCase()}${level.slice(1)} confidence${why ? `: ${why}` : ''}.`];
}

export function AnalystTrace({ result }: { result: QueryResult }) {
  const { receipt, evidence, mode, band } = result.scored;
  const gated = result.gated ?? [];
  const votes = receipt.evidence_mix.vote;
  const sponsorships = receipt.evidence_mix.sponsorship;

  return (
    <div className="trace">
      <dl>
        <dt>Actions matched</dt>
        <dd>{receipt.match_count}</dd>
        <dt>Carrying a direction</dt>
        <dd>{receipt.directed_count}</dd>
        <dt>Evidence</dt>
        <dd>
          {votes} vote{votes === 1 ? '' : 's'}, {sponsorships} sponsorship
          {sponsorships === 1 ? '' : 's'}
        </dd>
        <dt>Average match strength</dt>
        <dd>{receipt.avg_strength || 'none'}</dd>
        <dt>Direction split</dt>
        <dd>
          {receipt.direction_split.keeps} keeping / {receipt.direction_split.breaks} breaking /{' '}
          {receipt.direction_split.neutral} neutral
        </dd>
        <dt>Weight split</dt>
        <dd>
          {receipt.weight_split.keeps} vs {receipt.weight_split.breaks} (minority share{' '}
          {receipt.minority_share})
        </dd>
        <dt>Mode</dt>
        <dd>
          {mode}
          {band ? ` · band ${band}` : ''}
        </dd>
        {receipt.scoring_flags.length ? (
          <>
            <dt>Flags</dt>
            <dd>{receipt.scoring_flags.join(', ')}</dd>
          </>
        ) : null}
      </dl>

      <strong>Gate and dial trace</strong>
      <ol>
        {receipt.trace.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>

      {evidence.length ? (
        <>
          <p style={{ marginBottom: '0.3rem', marginTop: '0.9rem' }}>
            <strong>Per action</strong>
          </p>
          <ol>
            {evidence.map((e) => (
              <li key={e.action_uid}>
                <code>{e.action_uid}</code> · effect {e.bill_effect} · {e.action_tier} ·{' '}
                {e.vote_pattern} · outcome {e.outcome} · weight {e.weight}
                {/* The raw disclosure fields. Level 1 gets plain-language
                    equivalents on the card; the exact strings live here so an
                    analyst can check the translation rather than trust it. */}
                <br />
                governing <code>{e.vote_governing || 'NA'}</code>
                {e.vote_flags.length ? (
                  <>
                    {' '}· flags <code>{e.vote_flags.join(';')}</code>
                  </>
                ) : null}{' '}
                {/* Absence is written in words, never as 0 — handoff v2 §3, and
                    the split-vote cap (contract 2) is already applied to the
                    number shown, so this is what the accusation floor was
                    actually measured against. */}
                · confidence <code>{confidenceTraceLabel(e.alignment_confidence)}</code>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {result.judge ? (
        <>
          <p style={{ marginBottom: '0.3rem', marginTop: '0.9rem' }}>
            <strong>Adversarial review</strong>
          </p>
          <ul>
            <li>
              disposition <code>{result.judge.disposition}</code>
              {result.judge.withheld ? ' · accusation withheld' : ' · published'}
              {result.judge.unavailable ? ' · review did not run' : ''}
            </li>
            {result.judge.failed_test || result.judge.failure_class ? (
              <li>
                failed test <code>{result.judge.failed_test || 'none'}</code> · class{' '}
                <code>{result.judge.failure_class || 'none'}</code>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {/* Which RULE closed each gated row. The gate id is analyst vocabulary and
          stays at Level 2; the reader-facing card carries the gate's own
          plain-language reason instead. */}
      {gated.length ? (
        <>
          <p style={{ marginBottom: '0.3rem', marginTop: '0.9rem' }}>
            <strong>Gated before evaluation</strong>
          </p>
          <ol>
            {gated.map((g) => (
              <li key={g.action_uid}>
                <code>{g.action_uid}</code> · <code>{g.gate}</code> · outcome {g.outcome} ·
                not evaluated
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

interface VerdictProps {
  result: QueryResult;
  /** The run that produced this answer; feedback is tied to it. */
  traceId?: string | null;
  feedbackAvailable?: boolean;
  /** Ask "Did this answer what you asked?" and, per bill, "Is this bill about what you asked?". */
  feedbackPrompts?: boolean;
  /**
   * What to do next, shown in the answer's first screen right under the
   * search summary, so a reader never has to scroll to find it.
   */
  actions?: ReactNode;
}

/**
 * What the reader saw, for feedback: the run that produced this answer — a
 * replayed answer carries its original trace event, so the stream's trace id
 * is already that run — and the verdict as shown.
 */
function feedbackContext({ result, traceId, feedbackAvailable, feedbackPrompts }: VerdictProps): FeedbackContext | undefined {
  const { scored, senator } = result;
  return feedbackAvailable && traceId
    ? {
        runId: traceId,
        politicianId: senator.politician_id,
        promiseText: result.interpretation.raw,
        verdictShown: [scored.verdict, scored.band, scored.nd_reason].filter(Boolean).join(' · '),
        prompts: Boolean(feedbackPrompts),
      }
    : undefined;
}

/**
 * How the bills about the question count, as a bar with its legend. Not a
 * score: one segment per bill, in the legend's order, so a reader sees the
 * weight of the evidence at a glance and the bar adds up to the "about your
 * question" count beside it. Tapping a segment (or hovering, on a desktop)
 * says which bill it is and how it was read.
 *
 * Two greys, because they are two different things (Matt, 17 Oct): a bill
 * read and found not to be about this ("not about this", solid) and one we
 * closed by a rule before weighing it ("set aside", hatched).
 */
const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255,255,255,.65) 3px 6px)' };

type Segment = { key: string; kind: 'keeps' | 'breaks' | 'neutral' | 'aside'; label: string; title: string };

function whatTheyDid(e: DirectedAction): string {
  if (e.is_sponsor) return 'Sponsored';
  if (e.is_cosponsor) return 'Cosponsored';
  const v = [e.passage_vote, e.cloture_vote, e.vote].find((x) => x && x !== 'NA');
  return v ? `Voted ${v}` : 'Acted on it';
}

function tallySegments(result: QueryResult, promise: boolean): Segment[] {
  const meaning = {
    keeps: promise ? 'Counts toward keeping it' : 'Counts as consistent',
    breaks: promise ? 'Counts toward breaking it' : 'Counts as running counter',
    neutral: 'Not about this, so not counted',
  };
  const cite = (id: string) => billCitation(id) ?? id;
  const ev = result.scored.evidence;
  const of = (d: DirectedAction['direction'], kind: Segment['kind']) =>
    ev
      .filter((e) => e.direction === d)
      .map((e) => ({
        key: e.action_uid,
        kind,
        label: `${cite(e.bill_id)} · ${whatTheyDid(e)} · ${meaning[kind as keyof typeof meaning]}`,
        title: e.title,
      }));
  return [
    ...of('keeps', 'keeps'),
    ...of('breaks', 'breaks'),
    ...of('neutral', 'neutral'),
    ...(result.gated ?? []).map((g) => ({
      key: g.action_uid,
      kind: 'aside' as const,
      label: `${cite(g.bill_id)} · Set aside: ${g.reason.split(/(?<=\.)\s/)[0]}`,
      title: g.title,
    })),
  ];
}

const SEGMENT_STYLE: Record<Segment['kind'], { cls: string; style?: CSSProperties }> = {
  keeps: { cls: 'bg-kept' },
  breaks: { cls: 'bg-broken' },
  neutral: { cls: 'bg-rule' },
  aside: { cls: 'tally-aside bg-rule', style: HATCH },
};

function TallyBar({ result, promise }: { result: QueryResult; promise: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const segments = tallySegments(result, promise);
  const n = (k: Segment['kind']) => segments.filter((x) => x.kind === k).length;
  const words = promise ? { keeps: 'toward keeping it', breaks: 'toward breaking it' } : { keeps: 'consistent', breaks: 'counter' };
  const legend: Array<{ kind: Segment['kind']; text: string }> = [
    { kind: 'keeps', text: `${n('keeps')} ${words.keeps}` },
    { kind: 'breaks', text: `${n('breaks')} ${words.breaks}` },
    ...(n('neutral') ? [{ kind: 'neutral' as const, text: `${n('neutral')} not about this` }] : []),
    ...(n('aside') ? [{ kind: 'aside' as const, text: `${n('aside')} set aside` }] : []),
  ];
  const shown = segments.find((x) => x.key === open);
  return (
    <div className="tally">
      <div className="mt-3 flex gap-1" role="group" aria-label={`${legend.map((l) => l.text).join(', ')}. Choose a segment to see its bill.`}>
        {segments.map((x) => (
          <button
            key={x.key}
            type="button"
            title={`${x.label}. ${x.title}`}
            aria-label={x.label}
            aria-pressed={open === x.key}
            onClick={() => setOpen(open === x.key ? null : x.key)}
            className="group flex h-6 flex-1 items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span
              className={`h-2.5 w-full rounded-full ${SEGMENT_STYLE[x.kind].cls} ${open === x.key ? 'ring-2 ring-ink ring-offset-1' : 'group-hover:opacity-80'}`}
              style={SEGMENT_STYLE[x.kind].style}
            />
          </button>
        ))}
      </div>
      <p className="tally-legend mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-soft" aria-hidden="true">
        {legend.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${SEGMENT_STYLE[l.kind].cls}`} style={SEGMENT_STYLE[l.kind].style} />
            {l.text}
          </span>
        ))}
        <span className="text-ink-faint">Tap a segment to see its bill</span>
      </p>
      {shown ? (
        <p className="tally-detail mt-2 rounded-card border border-rule bg-card px-3 py-2 text-[14px] leading-snug text-ink" aria-live="polite">
          <span className="font-medium">{shown.label}</span>
          <br />
          <span className="text-ink-soft">{shown.title}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The verdict card: headline, the count, the reason, and what the answer rests on. */
/** What the card and the "Why" panel both read from one result. */
function readResult(props: VerdictProps) {
  const { result } = props;
  const { scored, explanation } = result;
  const isND = scored.verdict === 'NOT_DETERMINABLE';
  // A NOT_DETERMINABLE with no recorded reason must NOT borrow NO_MATCHES's
  // copy. "We didn't find any bills or votes in this senator's record" is the
  // strongest absence claim in the vocabulary, and defaulting to it would make
  // the tool assert a searched-and-found-nothing finding on the strength of a
  // missing field.
  // The disposition sentence is strictly more precise than the generic
  // WITHHELD_PENDING_REVIEW copy, and on one path the generic copy is simply
  // WRONG: it reads "a second review didn't back this reading" even when no
  // review ran at all — no credential, or the model returned nothing usable.
  // "A reviewer disagreed" and "nobody looked" are different facts about how
  // much scrutiny this reading got, and claiming the first when the second
  // happened overstates the care taken.
  const judgeSentence = judgeDispositionSentence(result.judge?.disposition);
  // "Doesn't settle it" gets the explainer's paragraph like any other answer
  // (2026-10-11): it was written for this question, names the bills and says
  // what was set aside, and the server holds it to the verdict — no kept,
  // broke, lines up with or runs counter on a not-determinable answer. The
  // specific reason goes under it as a fixed sentence. Without a paragraph,
  // the reason alone is the answer, as before.
  // A record question has an answer label, never a verdict: none of the
  // not-determinable copy applies to it, whatever the scorer said inside.
  const record = Boolean(result.record);
  const reason = isND && !record ? notDeterminableReason(result) : null;
  const written = String(explanation.why ?? '').trim();
  const level1 = record ? written : isND ? written || reason || ND_NO_REASON_COPY : explanation.why;
  const reasonLine = isND && !record && written ? reason : null;
  return { isND: isND && !record, record, judgeSentence, level1, reasonLine, promise: usesPromiseVocabulary(result), feedback: feedbackContext(props) };
}

/**
 * The answer, in one bar: the verdict, what they asked, what the search did
 * (its three numbers), which way the bills count, and what to do next. The
 * explanation, the receipts and how we checked sit in tabs below it.
 */
type RecordRow = NonNullable<QueryResult['record']>['rows'][number];

/**
 * THE RECORD LIST (Matt, 1 Nov, Thune / Laken Riley Act). The card used to
 * carry three search counts ("555 actions in record", "10 read closely",
 * "8 about your question"), a bar with one block per action and a sentence
 * counting actions. Bills and actions were mixed, the numbers did not visibly
 * add up, and the bar added nothing a reader could use. The card now says one
 * thing in words and lists the bills, each with what the senator did on it,
 * counted ones first. The search counts are one plain sentence at the bottom.
 */

/** "Voted Yes to end debate", "Co-sponsored": one action in plain words. */
export function recordActionPhrase(r: RecordRow): string {
  if (r.stage === 'sponsor') return 'Sponsored';
  if (r.stage === 'cosponsor') return 'Co-sponsored';
  const v = String(r.vote ?? '').toUpperCase();
  const how = r.stage === 'cloture' ? ' to end debate' : r.stage === 'passage' ? ' to pass' : '';
  if (v === 'YEA' || v === 'AYE' || v === 'YES') return `Voted Yes${how}`;
  if (v === 'NAY' || v === 'NO') return `Voted No${how}`;
  return v ? `Did not vote${how}` : `Voted${how}`;
}

export interface RecordBill {
  bill_id: string;
  reading: 'for' | 'against' | 'not_counted';
  actions: string[];
  broad: boolean;
}

/** The rows grouped by bill, in order: counted bills first, those with a vote first among them. */
export function recordBills(rows: RecordRow[]): RecordBill[] {
  const by = new Map<string, RecordRow[]>();
  for (const r of rows) by.set(r.bill_id, [...(by.get(r.bill_id) ?? []), r]);
  const order = (s: RecordRow['stage']) => (s === 'sponsor' ? 0 : s === 'cosponsor' ? 1 : s === 'cloture' ? 2 : 3);
  const bills = [...by.entries()].map(([bill_id, rs]) => ({
    bill_id,
    reading: (rs.some((r) => r.reading === 'against') ? 'against' : rs.some((r) => r.reading === 'for') ? 'for' : 'not_counted') as RecordBill['reading'],
    actions: [...rs].sort((x, y) => order(x.stage) - order(y.stage)).map(recordActionPhrase),
    broad: rs.some((r) => r.broad),
    voted: rs.some((r) => r.stage !== 'sponsor' && r.stage !== 'cosponsor'),
  }));
  const rank = (b: (typeof bills)[number]) => (b.reading === 'not_counted' ? 2 : 0) + (b.voted ? 0 : 1);
  return bills.sort((x, y) => rank(x) - rank(y)).map(({ voted: _v, ...b }) => b);
}

/**
 * The card's one line: "Of Thune's 10 actions on these 8 bills, 6 count toward
 * what you asked about and 4 don't count." Every action is accounted for.
 */
export function recordCountLine(rows: RecordRow[], surname = '', setAside = 0): string | null {
  if (!rows.length) return null;
  const fors = rows.filter((r) => r.reading === 'for').length;
  const againsts = rows.filter((r) => r.reading === 'against').length;
  const not = rows.length - fors - againsts;
  const bills = new Set(rows.map((r) => r.bill_id)).size;
  const who = surname.trim() ? `${surname.trim()}’s` : 'their';
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    ...(fors ? [`${fors} ${fors === 1 ? 'counts' : 'count'} toward what you asked about`] : []),
    ...(againsts ? [`${againsts} ${againsts === 1 ? 'counts' : 'count'} against it`] : []),
    ...(not ? [`${not} ${not === 1 ? "doesn't" : "don't"} count either way`] : []),
  ];
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts.join(' and ');
  if (rows.length === 1) {
    const how = fors ? 'counts toward what you asked about' : againsts ? 'counts against it' : "doesn't count either way";
    const actor = surname.trim() || 'They';
    return `${actor} took one action on this bill, and it ${how}.${setAside ? ` ${setAside} more ${setAside === 1 ? 'was' : 'were'} set aside by our rules.` : ''}`;
  }
  const lead = `Of ${who} ${n(rows.length, 'action', 'actions')} on ${bills === 1 ? 'this bill' : `these ${bills} bills`}, `;
  const body = list;
  const aside = setAside ? ` ${setAside} more ${setAside === 1 ? 'was' : 'were'} set aside by our rules.` : '';
  return `${lead}${body}.${aside}`;
}

function RecordList({ result, surname }: { result: QueryResult; surname: string }) {
  const answer = result.record!;
  const bills = recordBills(answer.rows);
  if (!bills.length) return null;
  const titleOf = new Map((result.scored.evidence ?? []).map((e) => [e.bill_id, e.title]));
  const counted = bills.filter((b) => b.reading !== 'not_counted');
  const uncounted = bills.filter((b) => b.reading === 'not_counted');
  const line = recordCountLine(answer.rows, surname, answer.set_aside);
  const name = (b: RecordBill) => billCitation(b.bill_id) ?? b.bill_id;
  const congress = (b: RecordBill) => {
    const c = congressOfBillId(b.bill_id);
    return c ? `${c}th Congress` : null;
  };
  return (
    <div className="record-list mt-4">
      {line ? <p className="record-count text-[16px] leading-snug text-ink">{line}</p> : null}
      {counted.length ? (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule">
          {counted.map((b) => (
            <li key={b.bill_id} className="flex gap-3 px-3.5 py-3" data-reading={b.reading}>
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${b.reading === 'for' ? 'bg-kept-wash text-kept' : 'bg-broken-wash text-broken'}`}
                aria-label={b.reading === 'for' ? 'Counts toward what you asked about' : 'Counts against what you asked about'}
              >
                {b.reading === 'for' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <XIcon className="h-3.5 w-3.5" aria-hidden="true" />}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-ink">
                  {name(b)}
                  {congress(b) ? <span className="font-normal text-ink-soft"> · {congress(b)}</span> : null}
                </p>
                {titleOf.get(b.bill_id) ? <p className="truncate text-[14px] text-ink-soft">{titleOf.get(b.bill_id)}</p> : null}
                <p className="mt-0.5 text-[15px] text-ink">{b.actions.join(' · ')}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {uncounted.length ? (
        <div className="mt-3">
          <p className="text-[14px] font-medium text-ink-soft">Not counted</p>
          <ul className="mt-1 space-y-1">
            {uncounted.map((b) => (
              <li key={b.bill_id} className="text-[14px] leading-snug text-ink-soft" data-reading="not_counted">
                <span className="font-medium text-ink">{name(b)}</span> · {b.actions.join(' · ')}.{' '}
                {b.broad ? 'Too broad to count: it covers far more than this.' : 'About a related issue, not the one you asked about.'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The answer to a record question ("Did they vote to…?"). No verdict badge
 * and no confidence band: the label says what they did, the bar shows each
 * vote, and the summary gives the facts. Neutral colouring throughout, since
 * a vote for or against is not good or bad in itself.
 */
function RecordCard(props: VerdictProps) {
  const { result } = props;
  const answer = result.record!;
  const searched = searchSummarySentence(result);
  const boundary = recordBoundarySentence(result);
  const sub = answerReasonLine(answer, result.gated);
  const summary = result.explanation.card_summary?.trim();
  return (
    <section
      className="verdict overflow-hidden rounded-card border border-rule bg-card shadow-soft"
      data-record={answer.label}
      aria-label="Answer"
    >
      <div className="px-5 pb-5 pt-5 sm:px-6">
        <p className="text-[15px] text-ink-soft">What the record shows</p>
        <h2 className="verdict-label record-label" style={{ color: 'var(--ink, inherit)' }}>
          {answerLabelLine(answer, result.gated).replace(/\.$/, '')}
        </h2>
        {sub ? <p className="verdict-confidence mt-1.5 text-[17px] leading-snug text-ink">{sub}</p> : null}
        <p className="verdict-band mt-2 text-[16px] leading-snug text-ink-soft">
          {result.senator.name} · you asked: <span className="text-ink">“{result.interpretation.raw}”</span>
        </p>
        {summary ? <p className="verdict-tally mt-3 text-[16px] leading-relaxed text-ink">{summary}</p> : null}
        <RecordList result={result} surname={String(result.senator.name ?? '').split(/\s+/).pop() ?? ''} />
        {boundary ? <p className="record-boundary mt-4 text-[16px] leading-relaxed text-ink">{boundary}</p> : null}
        {searched ? <p className="record-search mt-3 text-[14px] leading-snug text-ink-soft">{searched}</p> : null}
        {props.actions ? <div className="result-actions mt-5">{props.actions}</div> : null}
      </div>
    </section>
  );
}

export function VerdictCard(props: VerdictProps) {
  if (props.result.record) return <RecordCard {...props} />;
  const { result } = props;
  const { scored, senator } = result;
  const style = VERDICT_STYLE[scored.verdict] ?? VERDICT_STYLE.NOT_DETERMINABLE!;
  const { isND, promise } = readResult(props);
  const tally = evidenceTallySentence(result);
  const funnel = searchFunnel(result);
  const boundary = recordBoundarySentence(result);

  return (
    <section
      className="verdict overflow-hidden rounded-card border border-rule bg-card shadow-soft"
      data-verdict={scored.verdict}
      aria-label="Verdict"
    >
      <div className={`px-5 pb-5 pt-5 sm:px-6 ${style.wash}`}>
        <div className="flex items-center gap-3">
          <span
            className={`verdict-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${style.bg}`}
            aria-hidden="true"
          >
            <style.Icon className="h-5 w-5" strokeWidth={2.75} />
          </span>
          <p className="text-[15px] text-ink-soft">Their record vs. this {promise ? 'promise' : 'position'}</p>
        </div>
        {/* Styled from styles.css by its class alone: the tests read the
            headline out of the markup by this exact tag. */}
        <h2 className="verdict-label">{headlineParts(result)[0]}</h2>
        {/* The reader's promise, said to be theirs, before anything leans on it. */}
        {assertedPromiseLine(result) ? (
          <p className="asserted-premise mt-1.5 text-[17px] leading-snug text-ink" data-share-include="true">
            {assertedPromiseLine(result)}
          </p>
        ) : null}
        {headlineParts(result)[1] ? (
          <p className="verdict-confidence mt-1.5 text-[17px] leading-snug text-ink">{headlineParts(result)[1]}</p>
        ) : null}
        {/* The reader's OWN words, attributed to the reader. The restatement
            is the classifier's paraphrase; printing it in quotation marks
            beside the senator's name presented model output as something the
            senator said. */}
        <p className="verdict-band mt-2 text-[16px] leading-snug text-ink-soft">
          {senator.name} · you asked about: <span className="text-ink">“{result.interpretation.raw}”</span>
        </p>

        {/* What the search did, as three numbers. The sentence that says it
            in words is under "How we checked". */}
        {funnel ? (
          <dl className="search-funnel mt-4 flex flex-wrap gap-2">
            {[
              { n: funnel.searched, label: 'actions in record' },
              { n: funnel.close, label: funnel.close === 1 ? 'bill read closely' : 'bills read closely' },
              // The bar's legend splits this into consistent, counter and set
              // aside, so the card adds up without repeating those counts.
              { n: funnel.about, label: funnel.about === 1 ? 'bill about your question' : 'bills about your question' },
            ].map((x) =>
              x.n === null ? null : (
                <div key={x.label} className="flex items-baseline gap-1.5 rounded-full border border-rule bg-card/80 px-3 py-1">
                  <dt className="sr-only">{x.label}</dt>
                  <dd className="text-[16px] font-medium text-ink">{x.n.toLocaleString('en-US')}</dd>
                  <dd className="text-[14px] text-ink-soft" aria-hidden="true">
                    {x.label}
                  </dd>
                </div>
              ),
            )}
          </dl>
        ) : null}

        {/* Which way the bills count. Null for NOT_DETERMINABLE, where the
            reason under "Why" says what is true. */}
        {tally ? (
          <div className="mt-4">
            <TallyBar result={result} promise={promise} />
            {/* The explainer's executive summary when one passed its checks;
                otherwise the plain fact sentence. */}
            <p className="verdict-tally mt-3 text-[16px] leading-relaxed text-ink">
              {result.explanation.card_summary?.trim() || tally}
            </p>
          </div>
        ) : null}

        {/* Nothing found: where our records start, on the answer itself, so
            "nothing found" is never read as "did nothing". */}
        {boundary ? <p className="record-boundary mt-4 text-[16px] leading-relaxed text-ink">{boundary}</p> : null}

        {props.actions ? <div className="result-actions mt-5">{props.actions}</div> : null}

        {/* After the actions, so on a phone both buttons stay in the first screen. */}
        {isND ? (
          <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
            This is not a yes or a no. It doesn’t mean their record matches, and it doesn’t mean it goes against it.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The "Why" tab: the explanation, what it rests on, and its limits. */
export function WhyPanel(props: VerdictProps) {
  const { result } = props;
  const { scored } = result;
  const { isND, record, judgeSentence, level1, reasonLine, promise, feedback } = readResult(props);
  const reused = reusedSentence(result.reused_from?.produced_at);

  return (
    <div className="space-y-5">
      <div className="verdict-why">
        <h3 className="verdict-why-label font-serif text-[22px] text-ink">Here’s why.</h3>
        <p className="mt-2 text-[17px] leading-relaxed text-ink">{level1}</p>
        {reasonLine ? (
          <p className="nd-reason mt-3 rounded-lg bg-pending-wash px-3.5 py-3 text-[15px] leading-relaxed text-ink">
            <strong className="font-semibold">Why there’s no verdict. </strong>
            {reasonLine}
          </p>
        ) : null}
      </div>

      {scored.mode === 'ranked' && !record ? (
        <p className="mixed-note rounded-lg bg-cantsay-wash px-3.5 py-3 text-[15px] leading-relaxed text-ink">
          Their record here is mixed. There is real evidence pointing the other way, and it’s
          shown under Receipts rather than averaged out.
        </p>
      ) : null}

      {/* A published accusation that went through review says so, and shows
          the senator's counterargument beside it. Handoff v2 §5 makes a PASS
          invalid without one — so requiring it and then not printing it would
          waste the entire guarantee. Skipped when the reading was withheld:
          the level-1 copy above is already the disposition's own sentence,
          and a counterargument to an unpublished accusation would surface the
          accusation we just declined to make. */}
      {result.judge && !result.judge.withheld && judgeSentence && !record ? (
        <div className="judge-note rounded-lg border border-rule">
          <div className="flex gap-3 p-4">
            <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
            <p className="text-[15px] leading-relaxed text-ink-soft">{judgeSentence}</p>
          </div>
          {result.judge.counterargument ? (
            <div className="counterargument flex gap-3 border-t border-rule p-4">
              <MessageSquareQuoteIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
              <p className="text-[15px] leading-relaxed text-ink">
                <strong className="font-semibold">The senator’s strongest response.</strong>{' '}
                {result.judge.counterargument}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* A stored answer, returned because the same question was asked again. */}
      {reused ? <p className="reused-note text-[14px] leading-snug text-ink-soft">{reused}</p> : null}

      {/* The boundary travels with the verdict, not only with empty results:
          a KEPT drawn from two 118th-Congress bills is scoped by the same
          window as a no-match, and the reader is owed it either way. On the
          tab that opens first, so it is never a click away. */}
      <CoverageNote coverage={result.coverage} />

      {/* Reads that failed for this answer. Beside the coverage boundary
          because it is the same kind of fact — a limit on what this answer
          rests on — but louder, because it is a limit we did not intend. */}
      <EnrichmentGapNote gaps={result.enrichment_gaps} />

      {/* Which standard the wording follows, where it is the default. An
          asserted promise says so in its own headline. */}
      {!isND && !record && !promise && result.interpretation.provenance !== 'asserted' ? (
        <p className="text-[14px] leading-relaxed text-ink-soft">
          We treat this as a <GlossaryTerm id="position">position</GlossaryTerm> they’ve taken unless we can
          confirm they promised it.
        </p>
      ) : null}

      {/* What the beta covers and what to do if this looks wrong. Only with
          the control it points at. */}
      {feedback ? <p className="scope-line text-[14px] leading-relaxed text-ink-soft">{RESULT_SCOPE_LINE}</p> : null}
      {feedback ? (
        feedback.prompts ? (
          <FeedbackPrompt level="result" context={feedback} />
        ) : (
          <FeedbackControl level="result" context={feedback} />
        )
      ) : null}
    </div>
  );
}

/** What the search did, in words: the opening line of "How we checked". */
export function SearchSummary({ result }: { result: QueryResult }) {
  const summary = searchSummarySentence(result);
  return summary ? <p className="search-summary text-[17px] leading-relaxed text-ink">{summary}</p> : null;
}

/** The two drill-downs: the plain-language path, then the raw values one level further. */
export function HowWeGotHereToggle({ result }: { result: QueryResult }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  return (
    <div className="legacy">
      <button
        type="button"
        className="details-toggle"
        aria-expanded={showDetails}
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? 'Hide how we got here' : 'Show how we got here'}
      </button>
      {showDetails ? (
        <>
          <HowWeGotHere result={result} />
          <button
            type="button"
            className="details-toggle analyst-toggle"
            aria-expanded={showTrace}
            onClick={() => setShowTrace((v) => !v)}
          >
            {showTrace ? 'Hide the analyst trace' : 'Show the analyst trace (raw values)'}
          </button>
          {showTrace ? <AnalystTrace result={result} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** A group of bill cards. A collapsible group starts closed but its heading and count never hide. */
function EvidenceSection({
  title,
  description,
  count,
  collapsible = false,
  children,
}: {
  title: ReactNode;
  description?: string;
  count: number;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const heading = (
    <>
      <h3 className="section-heading font-serif text-[22px] leading-snug text-ink">
        {title} <span className="text-ink-soft">({count})</span>
      </h3>
      {description ? <span className="mt-1 block text-[15px] leading-snug text-ink-soft">{description}</span> : null}
    </>
  );

  if (!collapsible) {
    return (
      <section className="border-t border-rule pt-6 first:border-t-0 first:pt-0">
        {heading}
        <div className="mt-4 space-y-4">{children}</div>
      </section>
    );
  }
  // Native <details>: the cards are in the page whether or not it is open.
  return (
    <details className="group border-t border-rule pt-6 first:border-t-0 first:pt-0">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span>{heading}</span>
        <ChevronDownIcon
          className="mt-1 h-5 w-5 shrink-0 text-ink-soft transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-4 space-y-4">{children}</div>
    </details>
  );
}

/** The bills, grouped by how they count. */
export function EvidenceList(props: VerdictProps) {
  const { result } = props;
  const { scored, explanation, senator } = result;
  const feedback = feedbackContext(props);
  const isND = scored.verdict === 'NOT_DETERMINABLE';
  const promise = usesPromiseVocabulary(result);

  const dominant = scored.ranked[0];
  const dissent = scored.ranked[1];
  const evidenceFor = (uids: string[]) => scored.evidence.filter((e) => uids.includes(e.action_uid));
  const directed = scored.evidence.filter((e) => e.direction !== 'neutral');
  const undirected = scored.evidence.filter((e) => e.direction === 'neutral');

  const card = (e: (typeof scored.evidence)[number]) => (
    <EvidenceCard
      key={e.action_uid}
      action={e}
      connector={explanation.connectors[e.action_uid]}
      senatorName={senator.name}
      feedback={feedback}
      showDirection={!isND}
      promiseVocabulary={promise}
      recordRows={result.record ? result.record.rows.filter((r) => r.action_uid === e.action_uid) : undefined}
    />
  );

  // A record question: every bill and vote, each with how it reads against
  // what was asked. No toward/against sections: those are a verdict's.
  if (result.record) {
    return (
      <div id={EVIDENCE_ANCHOR} className="scroll-mt-4 space-y-8">
        {scored.evidence.length ? (
          <EvidenceSection
            title="The bills and votes"
            description="Each vote is read against what you asked about. Tap a chip to see how."
            count={scored.evidence.length}
          >
            {scored.evidence.map(card)}
          </EvidenceSection>
        ) : null}
        <NotCounted rows={result.not_counted} />
        <GatedActions gated={result.gated} />
      </div>
    );
  }

  return (
    <div id={EVIDENCE_ANCHOR} className="scroll-mt-4 space-y-8">
      {scored.mode === 'ranked' && dominant && dissent ? (
        <>
          <EvidenceSection
            title={<>What points toward “{verdictWord(dominant.verdict, result.interpretation.statement_type)}”</>}
            count={evidenceFor(dominant.evidence_uids).length}
          >
            {evidenceFor(dominant.evidence_uids).map(card)}
          </EvidenceSection>
          <EvidenceSection
            title={<>What points the other way: “{verdictWord(dissent.verdict, result.interpretation.statement_type)}”</>}
            count={evidenceFor(dissent.evidence_uids).length}
          >
            {evidenceFor(dissent.evidence_uids).map(card)}
          </EvidenceSection>
        </>
      ) : directed.length ? (
        <EvidenceSection
          title="The evidence"
          description={
            isND
              ? 'We found these, but they are not enough for an answer. You can read them and judge for yourself.'
              : 'The bills behind this answer. Tap a term with a dotted line to see what it means.'
          }
          count={directed.length}
        >
          {directed.map(card)}
        </EvidenceSection>
      ) : null}

      {undirected.length ? (
        <EvidenceSection
          title="Also found, but not counted either way"
          description={
            isND
              ? 'None of these clearly points one way. You can read them and judge for yourself.'
              : 'Related, but they don’t count toward the answer in either direction.'
          }
          count={undirected.length}
          // With no answer, these bills ARE the result, so they start open.
          collapsible={!isND && directed.length > 0}
        >
          {undirected.map(card)}
        </EvidenceSection>
      ) : null}

      {/* The rest of what the search read: same issue first, then other
          subjects. Never weighed, so after everything that was. */}
      <NotCounted rows={result.not_counted} />

      {/* Last, because it is what we set aside rather than what we weighed —
          but never omitted. A gated row is a considered refusal to read a bill,
          and hiding it turns that refusal into an absence of evidence. */}
      <GatedActions gated={result.gated} />
    </div>
  );
}

/** The whole receipt in one flow — the card, every tab's content — for the eval harness and tests. */
export function Verdict(props: VerdictProps) {
  return (
    <>
      <VerdictCard {...props} />
      <WhyPanel {...props} />
      <SearchSummary result={props.result} />
      <HowWeGotHereToggle result={props.result} />
      <EvidenceList {...props} />
    </>
  );
}

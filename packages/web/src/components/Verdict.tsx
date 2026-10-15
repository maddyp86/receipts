import { useState, type ReactNode } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  MinusIcon,
  ShieldCheckIcon,
  MessageSquareQuoteIcon,
  XIcon,
} from 'lucide-react';
import {
  BAND_LEVEL,
  BAND_REASON_COPY,
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
  const { statement_type, provenance } = result.interpretation;
  return statement_type !== 'Policy Position' && provenance !== 'asserted';
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
 * The headline as [lead, confidence]: one sentence (15 Oct), rendered with the
 * confidence clause in body type so a phone shows the answer first, not eight
 * lines of display type.
 */
function headlineParts(result: QueryResult): [string, string] {
  const { verdict, band, mode, receipt } = result.scored;
  // By reason: a failed check is headlined as a fact about the tool, not as
  // "we couldn't find enough", which reads as a fact about the record.
  if (verdict === 'NOT_DETERMINABLE') return [notDeterminableHeadline(result.scored.nd_reason), ''];
  const { statement_type, provenance } = result.interpretation;
  // One sentence, with the reason for the confidence (15 Oct): "low
  // confidence" on its own told the reader nothing.
  const base = likelyOutcomeHeadline(verdict, statement_type, provenance);
  if (!band) return [`${base}${mode === 'ranked' ? ', but it’s mixed' : ''}.`, ''];
  return mode === 'ranked'
    ? [`${base}, but it’s mixed.`, ` We have ${BAND_LEVEL[band]} confidence because ${receipt.band_reason ? BAND_REASON_COPY[receipt.band_reason] : 'the record points both ways'}.`]
    : [`${base},`, ` ${confidencePhrase(band, receipt.band_reason)}.`];
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
 * score: one block per bill, so a reader sees the weight of the evidence at a
 * glance. Bills set aside (read as neither way, or closed by a rule before
 * weighing) are drawn hatched, so the bar adds up to the "about your
 * question" count beside it.
 */
function TallyBar({ result, promise }: { result: QueryResult; promise: boolean }) {
  const { keeps, breaks, setAside } = counts(result);
  const words = promise
    ? { keeps: 'toward keeping it', breaks: 'toward breaking it' }
    : { keeps: 'consistent', breaks: 'counter' };
  const segments = [
    { key: 'keeps', n: keeps, cls: 'bg-kept' },
    { key: 'breaks', n: breaks, cls: 'bg-broken' },
    { key: 'aside', n: setAside, cls: 'tally-aside bg-rule' },
  ].filter((x) => x.n > 0);
  const legend = [
    `${keeps} ${words.keeps}`,
    `${breaks} ${words.breaks}`,
    ...(setAside ? [`${setAside} set aside`] : []),
  ];
  return (
    <div className="tally">
      <div className="mt-3 flex h-2.5 gap-1" role="img" aria-label={legend.join(', ')}>
        {segments.map((x) =>
          Array.from({ length: x.n }).map((_, i) => (
            <span
              key={`${x.key}-${i}`}
              className={`h-full flex-1 rounded-full ${x.cls}`}
              style={x.key === 'aside' ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255,255,255,.65) 3px 6px)' } : undefined}
            />
          )),
        )}
      </div>
      <p className="tally-legend mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-soft" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-kept" />{legend[0]}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-broken" />{legend[1]}</span>
        {setAside ? (
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rule" />{legend[2]}</span>
        ) : null}
      </p>
    </div>
  );
}

/** Counted (a direction), and set aside (read as neither way, or gated before weighing). */
function counts(result: QueryResult) {
  const ev = result.scored.evidence;
  const keeps = ev.filter((e) => e.direction === 'keeps').length;
  const breaks = ev.filter((e) => e.direction === 'breaks').length;
  const setAside = ev.filter((e) => e.direction === 'neutral').length + (result.gated?.length ?? 0);
  return { keeps, breaks, counted: keeps + breaks, setAside };
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
  const reason = isND ? notDeterminableReason(result) : null;
  const written = String(explanation.why ?? '').trim();
  const level1 = isND ? written || reason || ND_NO_REASON_COPY : explanation.why;
  const reasonLine = isND && written ? reason : null;
  return { isND, judgeSentence, level1, reasonLine, promise: usesPromiseVocabulary(result), feedback: feedbackContext(props) };
}

/**
 * The answer, in one bar: the verdict, what they asked, what the search did
 * (its three numbers), which way the bills count, and what to do next. The
 * explanation, the receipts and how we checked sit in tabs below it.
 */
export function VerdictCard(props: VerdictProps) {
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
        <h2 className="verdict-label">
          {headlineParts(result)[0]}
          {headlineParts(result)[1] ? (
            <span className="verdict-confidence mt-1 block font-sans text-[18px] font-normal leading-snug text-ink">
              {headlineParts(result)[1]}
            </span>
          ) : null}
        </h2>
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
              { n: funnel.close, label: 'read closely' },
              // The same two numbers the bar and the sentence use, so the
              // card adds up: counted plus set aside is what was about it.
              { n: isND ? funnel.about : counts(result).counted, label: isND ? 'about your question' : 'counted' },
              { n: !isND && counts(result).setAside ? counts(result).setAside : null, label: 'set aside' },
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
  const { isND, judgeSentence, level1, reasonLine, promise, feedback } = readResult(props);
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

      {scored.mode === 'ranked' ? (
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
      {result.judge && !result.judge.withheld && judgeSentence ? (
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
      {!isND && !promise && result.interpretation.provenance !== 'asserted' ? (
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
    />
  );

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

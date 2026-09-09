import { useState } from 'react';
import {
  BAND_PHRASE,
  ND_NO_REASON_COPY,
  ND_REASON_COPY,
  VERDICT_PHRASE,
  confidenceTraceLabel,
  judgeDispositionSentence,
  type QueryResult,
} from '@receipts/shared';
import { EvidenceCard } from './EvidenceCard.js';
import { GatedActions } from './GatedActions.js';
import { CoverageNote } from './States.js';

// ===========================================================================
// The two-level receipt.
//
// Level 1 is plain language and carries no statistics — the words "similarity",
// "confidence band" and any raw number are absent by construction, because the
// copy comes from the shared vocabulary table rather than from formatting the
// numbers.
//
// Level 2 is the analyst drill-down: the same factors, the gate/dial trace, and
// the flags. A skeptic can disagree with the weighting and still trust the facts.
// ===========================================================================

const ICON: Record<string, string> = {
  KEPT: '✓',
  BROKE: '✕',
  NOT_DETERMINABLE: '—',
};

function headline(result: QueryResult): string {
  const { verdict, band, mode } = result.scored;
  if (verdict === 'NOT_DETERMINABLE') return VERDICT_PHRASE.NOT_DETERMINABLE;
  const suffix = band ? ` — ${BAND_PHRASE[band]}` : '';
  return `${VERDICT_PHRASE[verdict]}${suffix}${mode === 'ranked' ? ', but it’s mixed' : ''}`;
}

function AnalystTrace({ result }: { result: QueryResult }) {
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
        <dd>{receipt.avg_strength || '—'}</dd>
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
                failed test <code>{result.judge.failed_test || '—'}</code> · class{' '}
                <code>{result.judge.failure_class || '—'}</code>
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

export function Verdict({ result }: { result: QueryResult }) {
  const [showTrace, setShowTrace] = useState(false);
  const { scored, explanation, senator } = result;

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

  const level1 =
    scored.verdict === 'NOT_DETERMINABLE'
      ? scored.nd_reason === 'WITHHELD_PENDING_REVIEW' && judgeSentence
        ? judgeSentence
        : scored.nd_reason
          ? ND_REASON_COPY[scored.nd_reason]
          : ND_NO_REASON_COPY
      : explanation.why;

  const dominant = scored.ranked[0];
  const dissent = scored.ranked[1];

  const evidenceFor = (uids: string[]) =>
    scored.evidence.filter((e) => uids.includes(e.action_uid));

  const undirected = scored.evidence.filter((e) => e.direction === 'neutral');

  return (
    <>
      <section className="verdict" data-verdict={scored.verdict} aria-label="Verdict">
        <h2 className="verdict-label">
          <span className="verdict-icon" aria-hidden="true">
            {ICON[scored.verdict]}
          </span>
          {headline(result)}
        </h2>
        <p className="verdict-band">
          {senator.name} · “{result.interpretation.restated}”
        </p>
        <p className="verdict-why">{level1}</p>

        {/* The boundary travels with the verdict, not only with empty results:
            a KEPT drawn from two 118th-Congress bills is scoped by the same
            window as a no-match, and the reader is owed it either way. */}
        <CoverageNote coverage={result.coverage} />

        {/* A published accusation that went through review says so, and shows
            the senator's counterargument beside it. Handoff v2 §5 makes a PASS
            invalid without one — so requiring it and then not printing it would
            waste the entire guarantee. Skipped when the reading was withheld:
            the level-1 copy above is already the disposition's own sentence,
            and a counterargument to an unpublished accusation would surface the
            accusation we just declined to make. */}
        {result.judge && !result.judge.withheld && judgeSentence ? (
          <div className="judge-note">
            <p>{judgeSentence}</p>
            {result.judge.counterargument ? (
              <p className="counterargument">
                <strong>The senator’s strongest response.</strong>{' '}
                {result.judge.counterargument}
              </p>
            ) : null}
          </div>
        ) : null}

        {scored.mode === 'ranked' ? (
          <p className="mixed-note">
            Their record here is mixed — there is real evidence pointing the other way, and it’s
            shown below rather than averaged out.
          </p>
        ) : null}
      </section>

      <button
        type="button"
        className="details-toggle"
        aria-expanded={showTrace}
        onClick={() => setShowTrace((v) => !v)}
      >
        {showTrace ? 'Hide the details' : 'Show the details'}
      </button>
      {showTrace ? <AnalystTrace result={result} /> : null}

      {scored.mode === 'ranked' && dominant && dissent ? (
        <>
          <h3 className="section-heading">
            What points toward “{VERDICT_PHRASE[dominant.verdict]}”
          </h3>
          {evidenceFor(dominant.evidence_uids).map((e) => (
            <EvidenceCard
              key={e.action_uid}
              action={e}
              connector={explanation.connectors[e.action_uid]}
              senatorName={senator.name}
            />
          ))}

          <h3 className="section-heading">
            What points the other way — “{VERDICT_PHRASE[dissent.verdict]}”
          </h3>
          {evidenceFor(dissent.evidence_uids).map((e) => (
            <EvidenceCard
              key={e.action_uid}
              action={e}
              connector={explanation.connectors[e.action_uid]}
              senatorName={senator.name}
            />
          ))}
        </>
      ) : scored.evidence.filter((e) => e.direction !== 'neutral').length ? (
        <>
          <h3 className="section-heading">The evidence</h3>
          {scored.evidence
            .filter((e) => e.direction !== 'neutral')
            .map((e) => (
              <EvidenceCard
                key={e.action_uid}
                action={e}
                connector={explanation.connectors[e.action_uid]}
                senatorName={senator.name}
              />
            ))}
        </>
      ) : null}

      {undirected.length ? (
        <>
          <h3 className="section-heading">Also found, but it doesn’t settle anything</h3>
          {undirected.map((e) => (
            <EvidenceCard
              key={e.action_uid}
              action={e}
              connector={explanation.connectors[e.action_uid]}
              senatorName={senator.name}
            />
          ))}
        </>
      ) : null}

      {/* Last, because it is what we set aside rather than what we weighed —
          but never omitted. A gated row is a considered refusal to read a bill,
          and hiding it turns that refusal into an absence of evidence. */}
      <GatedActions gated={result.gated} />
    </>
  );
}

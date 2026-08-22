import { useState } from 'react';
import {
  BAND_PHRASE,
  ND_REASON_COPY,
  VERDICT_PHRASE,
  type QueryResult,
} from '@receipts/shared';
import { EvidenceCard } from './EvidenceCard.js';

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

  const level1 =
    scored.verdict === 'NOT_DETERMINABLE'
      ? ND_REASON_COPY[scored.nd_reason ?? 'NO_MATCHES']
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
    </>
  );
}

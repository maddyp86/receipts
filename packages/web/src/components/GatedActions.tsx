import type { GatedAction } from '@receipts/shared';

// ===========================================================================
// Actions a gate closed before the evaluator ran.
//
// fix/08: "Gated items are shown with their reason. They are the thing that
// makes the tool look honest."
//
// The failure this prevents is subtle and bad. A gate firing means we RETRIEVED
// a related bill and then deliberately declined to read it — because the
// statement's window had closed, or its precondition no longer held, or the
// vehicle was too broad to say anything specific. Dropping the row silently
// converts that considered refusal into an absence of evidence, which is the
// same false-absence class the coverage sentence exists to prevent.
//
// Deliberately NOT an EvidenceCard. These rows never reached the evaluator, so
// they have no direction, no vote reading, no weight and no confidence. Giving
// them the same card would say they were weighed and found wanting, when the
// truth is we declined to weigh them at all — so they get a plainer card that
// leads with the reason rather than with a behaviour sentence.
// ===========================================================================

export function GatedActions({ gated }: { gated?: GatedAction[] }) {
  if (!gated?.length) return null;

  return (
    <>
      <h3 className="section-heading">Found, but not evaluated</h3>
      <p className="gated-lead">
        We retrieved {gated.length === 1 ? 'this' : 'these'} {gated.length === 1 ? '' : `${gated.length} `}
        {gated.length === 1 ? 'bill' : 'bills'} and then stopped short of reading{' '}
        {gated.length === 1 ? 'it' : 'them'} against the statement. That is a decision, not a gap —
        each one says why below.
      </p>

      {gated.map((g) => (
        <article className="evidence gated" key={g.action_uid} data-gate={g.gate}>
          <div className="evidence-head">
            <h3 className="evidence-title">{g.title || g.bill_id}</h3>
            {g.bill_number ? <span className="evidence-bill">{g.bill_number}</span> : null}
            <span className="relation not-evaluated">Not evaluated</span>
          </div>

          {/* The gate's own words. Written for a reader and rendered verbatim —
              paraphrasing here would put our summary of a deterministic rule in
              front of the rule itself. */}
          <p className="gated-reason">{g.reason}</p>

          {g.source_url ? (
            <a
              className="source"
              href={g.source_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the bill on congress.gov →
            </a>
          ) : null}
        </article>
      ))}
    </>
  );
}

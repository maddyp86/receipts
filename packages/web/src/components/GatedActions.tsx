import { ChevronDownIcon, ExternalLinkIcon, FileQuestionIcon } from 'lucide-react';
import { congressLabel, congressOfBillId, type GatedAction } from '@receipts/shared';

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
    <details open className="group border-t border-rule pt-6">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span>
          <h3 className="section-heading font-serif text-[21px] text-ink">
            Found, but not evaluated <span className="text-ink-soft">({gated.length})</span>
          </h3>
          <span className="gated-lead mt-1 block text-[15px] leading-snug text-ink-soft">
            We retrieved {gated.length === 1 ? 'this' : 'these'} {gated.length === 1 ? '' : `${gated.length} `}
            {gated.length === 1 ? 'bill' : 'bills'} and then stopped short of reading{' '}
            {gated.length === 1 ? 'it' : 'them'} against the statement. That is a decision, not a gap —
            each one says why below.
          </span>
        </span>
        <ChevronDownIcon
          className="mt-1 h-5 w-5 shrink-0 text-ink-soft transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-4 space-y-4">
        {gated.map((g) => (
          <article
            className="evidence gated flex gap-3 rounded-card border border-dashed border-rule bg-card p-4"
            key={g.action_uid}
            data-gate={g.gate}
          >
            <FileQuestionIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
            <div className="min-w-0">
              <p className="evidence-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-soft">
                <span className="font-mono text-[13px] text-ink">{g.bill_id}</span>
                {congressOfBillId(g.bill_id) ? <span>{congressLabel(congressOfBillId(g.bill_id)!)}</span> : null}
                <span className="relation not-evaluated rounded-full bg-cantsay-wash px-2.5 py-0.5 text-[13px] font-medium text-cantsay">
                  Not evaluated
                </span>
              </p>
              <h3 className="evidence-title mt-1 text-[17px] font-semibold leading-snug text-ink">
                {g.title || g.bill_id}
              </h3>

              {/* The gate's own words. Written for a reader and rendered verbatim —
                  paraphrasing here would put our summary of a deterministic rule in
                  front of the rule itself. */}
              <p className="gated-reason mt-1 text-[16px] leading-relaxed text-ink-soft">{g.reason}</p>

              {g.source_url ? (
                <a
                  className="source mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-[15px] font-medium text-focus underline underline-offset-4"
                  href={g.source_url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Read the bill on congress.gov
                  <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

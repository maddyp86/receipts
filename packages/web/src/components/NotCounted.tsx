import { ChevronDownIcon, ExternalLinkIcon, FileMinusIcon } from 'lucide-react';
import { congressLabel, congressOfBillId, type NotCountedAction } from '@receipts/shared';

// ===========================================================================
// Bills the relevance check read and did not count.
//
// The answer rests on the bills directly about the statement. These are the
// rest of what the search found: first the ones on the same issue, then the
// ones about something else. Each carries the check's reason, so a reader can
// see why it was set aside and decide for themselves where the check was too
// strict. None of them moves the answer, and the copy says so.
//
// A plain card, like the gated one, and for the same reason: these rows were
// never weighed, so the evidence card's direction and vote reading would claim
// a judgement that was never made.
// ===========================================================================

function Card({ row }: { row: NotCountedAction }) {
  const congress = congressOfBillId(row.bill_id);
  return (
    <article
      className="evidence not-counted flex gap-3 rounded-card border border-dashed border-rule bg-card p-4"
      data-tier={row.tier}
    >
      <FileMinusIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
      <div className="min-w-0">
        <p className="evidence-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-soft">
          <span className="font-mono text-[13px] text-ink">{row.bill_id}</span>
          {congress ? <span>{congressLabel(congress)}</span> : null}
          <span className="not-counted-action">{row.action}</span>
        </p>
        <h3 className="evidence-title mt-1 text-[17px] font-semibold leading-snug text-ink">{row.title}</h3>
        {row.reason ? (
          <p className="not-counted-reason mt-1 text-[16px] leading-relaxed text-ink-soft">
            <span className="font-medium text-ink">Why it’s not counted: </span>
            {row.reason}
          </p>
        ) : null}
        {row.source_url ? (
          <a
            className="source mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-[15px] font-medium text-focus underline underline-offset-4"
            href={row.source_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Read the bill on congress.gov
            <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function Group({
  rows,
  title,
  lead,
  open,
  tier,
}: {
  rows: NotCountedAction[];
  title: string;
  lead: string;
  open: boolean;
  tier: NotCountedAction['tier'];
}) {
  if (!rows.length) return null;
  return (
    <details open={open} className="group border-t border-rule pt-6" data-not-counted={tier}>
      <summary className="flex min-h-[44px] cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span>
          <h3 className="section-heading font-serif text-[21px] text-ink">
            {title} <span className="text-ink-soft">({rows.length})</span>
          </h3>
          <span className="mt-1 block text-[15px] leading-snug text-ink-soft">{lead}</span>
        </span>
        <ChevronDownIcon
          className="mt-1 h-5 w-5 shrink-0 text-ink-soft transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-4 space-y-4">
        {rows.map((row) => (
          <Card row={row} key={row.action_uid} />
        ))}
      </div>
    </details>
  );
}

export function NotCounted({ rows }: { rows?: NotCountedAction[] }) {
  if (!rows?.length) return null;
  const related = rows.filter((r) => r.tier === 'related');
  const unrelated = rows.filter((r) => r.tier === 'unrelated');
  return (
    <>
      <Group
        rows={related}
        tier="related"
        open
        title="Related bills we didn’t count"
        lead="These are on the same issue but aren’t directly about this statement, so they don’t affect the answer. You can read them and decide for yourself."
      />
      <Group
        rows={unrelated}
        tier="unrelated"
        open={false}
        title="Also looked at, not about this"
        lead="Our search turned these up, but they’re about something else. They’re listed so you can check our work."
      />
    </>
  );
}

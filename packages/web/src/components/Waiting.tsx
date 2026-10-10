import { useEffect, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, LightbulbIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import type { Interpretation, StepEvent, StepId } from '@receipts/shared';
import type { Member } from '../data/roster.js';
import { SelectedMember } from './members/SelectedMember.js';

// ===========================================================================
// The waiting screen.
//
// Driven by the REAL progress stream, not a timer: a stage is ticked when the
// server says its steps finished, and the server's own detail ("found 4
// related actions") is printed under it. The visible progress is the
// traceability, so nothing here is simulated.
//
// It also shows the reader how their words were read, as soon as that is
// known — the earliest point at which a misread can be caught.
// ===========================================================================

interface Stage {
  label: (name: string) => string;
  steps: StepId[];
}

/** The server's seven steps, grouped into the four a reader needs to follow. */
const STAGES: Stage[] = [
  { label: () => 'Reading what you wrote', steps: ['classify_scope', 'interpret'] },
  { label: (name) => `Searching ${name}’s votes and bills`, steps: ['resolve_senator', 'embed', 'search'] },
  { label: () => 'Reading each bill', steps: ['score'] },
  { label: () => 'Writing up the answer', steps: ['explain'] },
];

const EXPLAINERS = [
  'A senator can vote yes to end debate and no on the final bill. We look at both.',
  'A NO vote can line up with a goal — if the bill would have set the goal back.',
  'The sponsor writes a bill. Co-sponsors sign on to support it.',
  'Senators serve 6-year terms. Representatives in the House serve 2-year terms.',
  'Each Congress lasts two years. The 118th was 2023–24. The 119th is 2025–26.',
];

type StageStatus = 'done' | 'working' | 'waiting' | 'error';

export function stageStatuses(steps: StepEvent[]): StageStatus[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  // The furthest stage any step has reached. A stage before it is finished
  // even if one of its steps never reported (some are skipped on purpose).
  let furthest = -1;
  STAGES.forEach((stage, i) => {
    if (stage.steps.some((id) => byId.has(id))) furthest = i;
  });

  const statuses = STAGES.map<StageStatus>((stage, i) => {
    const seen = stage.steps.map((id) => byId.get(id)).filter((s): s is StepEvent => Boolean(s));
    if (seen.some((s) => s.status === 'error')) return 'error';
    if (i < furthest) return 'done';
    if (i > furthest) return 'waiting';
    return seen.every((s) => s.status === 'done') && stageIsComplete(stage, byId) ? 'done' : 'working';
  });

  // Between one stage finishing and the next reporting in, the next one is
  // what is happening. Without this the list would briefly show nothing in
  // progress, which reads as a stall.
  if (!statuses.includes('working') && !statuses.includes('error')) {
    const next = statuses.indexOf('waiting');
    if (next !== -1) statuses[next] = 'working';
  }
  return statuses;
}

/** The last step of a stage reporting done is what finishes it. */
function stageIsComplete(stage: Stage, byId: Map<StepId, StepEvent>): boolean {
  const last = stage.steps[stage.steps.length - 1]!;
  return byId.get(last)?.status === 'done';
}

const STANCE_CHIP: Record<string, string> = {
  'In Favor': 'Wants this to happen',
  Opposed: 'Wants to stop this',
};

interface Props {
  member: Member;
  promise: string;
  steps: StepEvent[];
  interpretation: Interpretation | null;
  /** Set when the reader typed a question and a statement is being checked in its place. */
  rewritten?: { original: string; statement: string } | null;
  onCancel: () => void;
}

export function Waiting({ member, promise, steps, interpretation, rewritten = null, onCancel }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [tip, setTip] = useState(0);
  const statuses = stageStatuses(steps);

  useEffect(() => {
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setTip((i) => (i + 1) % EXPLAINERS.length), 6000);
    return () => window.clearInterval(t);
  }, []);

  // Only the search reports something a reader can use ("found 4 related
  // actions"). The other steps' details are for whoever is debugging the
  // pipeline — embedding sizes, classifier labels — and stay in the trace.
  const detailFor = (stage: Stage): string | null => {
    if (!stage.steps.includes('search')) return null;
    const search = steps.find((s) => s.id === 'search');
    return search?.status === 'done' && search.detail ? search.detail : null;
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="font-serif text-[24px] text-ink">Receipts</p>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-[16px] font-medium text-focus"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Go back
        </button>
      </div>

      <div className="mt-6">
        <SelectedMember member={member} compact />
      </div>

      <section aria-live="polite" className="mt-8">
        <h1 className="font-serif text-[28px] leading-tight text-ink sm:text-[32px]">
          Checking {member.name}’s record
        </h1>
        {rewritten ? (
          <div className="mt-3 animate-rise-in rounded-card border border-rule bg-card p-4 shadow-soft">
            <p className="text-[14px] font-medium text-ink-soft">You typed</p>
            <p className="mt-0.5 text-[16px] leading-snug text-ink-soft">“{rewritten.original}”</p>
            <p className="mt-3 text-[14px] font-medium text-ink-soft">We’re checking it as</p>
            <p className="mt-0.5 font-serif text-[20px] leading-snug text-ink">“{rewritten.statement}”</p>
            <p className="mt-3 text-[14px] text-ink-soft">
              A question has no side to check, so we check the statement it asks about. Not what you meant? Go back
              and reword it.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[17px] text-ink-soft">
            You asked about: <span className="text-ink">“{promise}”</span>
          </p>
        )}
        <p className="mt-2 text-[15px] text-ink-soft">
          This usually takes about a minute. <span className="tabular-nums">{elapsed}s</span> so far.
        </p>
      </section>

      {/* How the statement was read — shown the moment it is known. */}
      {interpretation ? (
        <section
          aria-label="How we read your statement"
          className="mt-6 animate-rise-in rounded-card border border-rule bg-card p-4 shadow-soft"
        >
          <p className="text-[14px] font-medium text-ink-soft">How we read it</p>
          <p className="mt-1 font-serif text-[20px] leading-snug text-ink">“{interpretation.restated}”</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[14px] text-ink-soft">
            {interpretation.primary_issue ? (
              <span className="rounded-full border border-rule bg-paper px-3 py-1">{interpretation.primary_issue}</span>
            ) : null}
            {interpretation.sub_issue ? (
              <span className="rounded-full border border-rule bg-paper px-3 py-1">{interpretation.sub_issue}</span>
            ) : null}
            <span className="rounded-full border border-rule bg-paper px-3 py-1">
              {STANCE_CHIP[interpretation.stance] ?? 'Unclear which way'}
            </span>
          </div>
          <p className="mt-3 text-[14px] text-ink-soft">Not what you meant? Go back and reword it.</p>
        </section>
      ) : null}

      <ol className="mt-6 space-y-1 rounded-card border border-rule bg-card p-2 shadow-soft">
        {STAGES.map((stage, i) => {
          const status = statuses[i]!;
          const detail = detailFor(stage);
          return (
            <li key={i} className="flex min-h-[56px] items-center gap-4 rounded-lg px-3 py-2" data-status={status}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true">
                {status === 'done' ? (
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-paper">
                    <CheckIcon className="h-4 w-4" strokeWidth={3} />
                  </span>
                ) : status === 'working' ? (
                  <Loader2Icon className="h-6 w-6 animate-spin text-ink motion-reduce:animate-none" />
                ) : status === 'error' ? (
                  <TriangleAlertIcon className="h-6 w-6 text-broken" />
                ) : (
                  <span className="h-6 w-6 rounded-full border-2 border-rule" />
                )}
              </span>
              <span>
                <span
                  className={`block text-[17px] ${
                    status === 'working' ? 'font-semibold text-ink' : status === 'waiting' ? 'text-ink-soft' : 'text-ink'
                  }`}
                >
                  {stage.label(member.name)}
                </span>
                {detail && status !== 'waiting' ? (
                  <span className="block text-[14px] text-ink-soft">{detail}</span>
                ) : null}
                <span className="sr-only">
                  {status === 'done'
                    ? '— done'
                    : status === 'working'
                      ? '— working now'
                      : status === 'error'
                        ? '— failed'
                        : '— up next'}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <aside className="mt-6 rounded-card bg-cantsay-wash p-5" aria-label="Good to know">
        <p className="flex items-center gap-2 text-[15px] font-medium text-ink-soft">
          <LightbulbIcon className="h-4 w-4" aria-hidden="true" />
          Good to know
        </p>
        <p key={tip} className="mt-2 min-h-[56px] animate-fade-in text-[17px] leading-relaxed text-ink">
          {EXPLAINERS[tip]}
        </p>
      </aside>
    </>
  );
}

import { useEffect, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, LightbulbIcon, Loader2Icon, MinusIcon, TriangleAlertIcon } from 'lucide-react';
import { surnameOf, type Interpretation, type NoteEvent, type StepEvent, type StepId } from '@receipts/shared';
import type { Member } from '../data/roster.js';
import { SelectedMember } from './members/SelectedMember.js';

// ===========================================================================
// The waiting screen.
//
// Driven by the REAL progress stream, not a timer: a stage is ticked when the
// server says its steps finished, and the server's own detail ("looked at
// 10 bills · 2 directly about this") is printed under it — and under that, the
// server's narration as it works: each bill checked, kept or set aside, read,
// and which way it pushes. The visible progress is the traceability, so
// nothing here is simulated.
//
// Above it, one card says what the reader asked and what we are checking to
// answer it, as soon as that is known, with one way to change it. The check
// keeps running meanwhile: most readings are right, and waiting on a "yes"
// would slow every one of them.
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

/** The notes that belong under a stage, in arrival order. */
export function notesFor(stage: { steps: StepId[] }, notes: NoteEvent[]): NoteEvent[] {
  return notes.filter((n) => stage.steps.includes(n.step));
}

/** "3 of 8 read", from the bill-reading notes. Null before any bill is being read. */
export function readProgress(notes: NoteEvent[]): string | null {
  const read = notes.filter((n) => n.group === 'read');
  if (!read.length) return null;
  const finished = read.filter((n) => n.status !== 'running').length;
  return `${finished} of ${read.length} read`;
}

function NoteLine({ note }: { note: NoteEvent }) {
  return (
    <li className="flex animate-fade-in items-start gap-2 text-[14px] leading-snug" data-status={note.status}>
      <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {note.status === 'running' ? (
          <Loader2Icon className="h-3.5 w-3.5 animate-spin text-ink-soft motion-reduce:animate-none" />
        ) : note.status === 'done' ? (
          <CheckIcon className="h-3.5 w-3.5 text-ink" strokeWidth={3} />
        ) : (
          <MinusIcon className="h-3.5 w-3.5 text-ink-soft" strokeWidth={3} />
        )}
      </span>
      <span className={note.status === 'skipped' ? 'text-ink-soft' : 'text-ink'}>{note.text}</span>
    </li>
  );
}

/**
 * What we look for in the record, said plainly. The check is never whether
 * the member said or promised something — it is whether their votes and
 * bills line up with it. "promised to lower drug prices" is checked as
 * "whether Schumer's votes and bills follow through on a promise to lower
 * drug prices", not "whether Schumer promised to". Clean-up writes every
 * restated question as "supports …", "opposes …" or "promised to …";
 * anything else is quoted as it stands.
 */
export function checkingLine(statement: string, memberName: string, done = false): string {
  const s = statement.trim().replace(/[.。]\s*$/, '');
  const lead = done ? 'We checked' : 'We’re checking';
  const record = `${surnameOf(memberName)}’s votes and bills`;
  const m = /^(supports|opposes|promised not to|promised to)\s+(.+)$/i.exec(s);
  if (!m) return `${lead} ${record} against “${s}”.`;
  const rest = m[2]!;
  switch (m[1]!.toLowerCase()) {
    case 'promised not to':
      return `${lead} whether ${record} ${done ? 'kept' : 'keep'} a promise not to ${rest}.`;
    case 'supports':
      return `${lead} whether ${record} back ${rest}.`;
    case 'opposes':
      return `${lead} whether ${record} work against ${rest}.`;
    default:
      return `${lead} whether ${record} ${done ? 'followed' : 'follow'} through on a promise to ${rest}.`;
  }
}

/**
 * What they asked, what we are checking to answer it, the topic we filed it
 * under, and one way to change it. The same card on the waiting screen and
 * under "How we checked".
 */
export function QuestionCard({
  asked,
  statement,
  memberName,
  interpretation,
  done = false,
  onChange,
  className = '',
}: {
  asked: string;
  /** What is being checked; null until it is known. */
  statement: string | null;
  memberName: string;
  interpretation: Interpretation | null;
  done?: boolean;
  onChange: () => void;
  className?: string;
}) {
  const topics = interpretation
    ? [interpretation.primary_issue, interpretation.sub_issue].filter((t, i, all): t is string => Boolean(t) && all.indexOf(t) === i)
    : [];
  return (
    <section aria-label="Your question" className={`rounded-card border border-rule bg-card p-4 ${className}`}>
      <p className="text-[14px] font-medium text-ink-soft">You asked</p>
      <p className="mt-0.5 text-[16px] leading-snug text-ink-soft">“{asked}”</p>
      {statement ? (
        <p className={`mt-3 leading-snug text-ink ${done ? 'text-[17px] font-medium' : 'font-serif text-[20px]'}`}>
          {checkingLine(statement, memberName, done)}
        </p>
      ) : null}
      {topics.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[14px] text-ink-soft">
          <span>Filed under</span>
          {topics.map((t) => (
            <span key={t} className="rounded-full border border-rule bg-paper px-3 py-1">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {statement ? (
        <button
          type="button"
          onClick={onChange}
          className="mt-2 inline-flex min-h-[44px] items-center text-[15px] font-medium text-focus underline underline-offset-4"
        >
          Not quite right? Change it
        </button>
      ) : null}
    </section>
  );
}

interface Props {
  member: Member;
  promise: string;
  steps: StepEvent[];
  /** The server's line-by-line narration; see NoteEvent. */
  notes?: NoteEvent[];
  interpretation: Interpretation | null;
  /** Set when the reader typed a question and a statement is being checked in its place. */
  rewritten?: { original: string; statement: string } | null;
  /** What the reader typed, when they picked one of our options and `promise` is that option. */
  asked?: string | null;
  onCancel: () => void;
  /** Stop, and put the statement we were checking in the box to edit. */
  onChange: (statement: string) => void;
}

export function Waiting({ member, promise, steps, notes = [], interpretation, rewritten = null, asked = null, onCancel, onChange }: Props) {
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

  // Only the search reports something a reader can use ("looked at 10
  // bills · 2 directly about this"). The other steps' details are for whoever is debugging the
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

        {/* One card: what they asked, and what we are checking to answer it.
            Shown as soon as each is known — the earliest point at which a
            misread can be caught — with one way to fix it. */}
        <QuestionCard
          className="mt-4 animate-rise-in shadow-soft"
          asked={rewritten ? rewritten.original : (asked ?? promise)}
          statement={rewritten ? rewritten.statement : asked ? promise : (interpretation?.restated ?? null)}
          memberName={member.name}
          interpretation={interpretation}
          onChange={() => onChange(rewritten ? rewritten.statement : promise)}
        />

        <p className="mt-4 text-[15px] text-ink-soft">
          This usually takes about a minute. <span className="tabular-nums">{elapsed}s</span> so far.
        </p>
      </section>

      <ol className="mt-3 space-y-1 rounded-card border border-rule bg-card p-2 shadow-soft">
        {STAGES.map((stage, i) => {
          const status = statuses[i]!;
          const detail = detailFor(stage);
          const lines = status === 'waiting' ? [] : notesFor(stage, notes);
          const progress = stage.steps.includes('score') && status !== 'waiting' ? readProgress(lines) : null;
          return (
            <li key={i} className="flex min-h-[56px] items-start gap-4 rounded-lg px-3 py-3" data-status={status}>
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
              <div className="min-w-0 flex-1 pt-1">
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
                {progress ? <span className="block text-[14px] tabular-nums text-ink-soft">{progress}</span> : null}
                {/* The narration. Open while the stage is working; once it is
                    done it folds away, a tap from being read again. */}
                {lines.length && status === 'done' ? (
                  <details className="mt-1">
                    <summary className="min-h-[32px] cursor-pointer text-[14px] font-medium text-focus">
                      What we checked ({lines.length})
                    </summary>
                    <ul className="mt-1 space-y-1.5">
                      {lines.map((n) => <NoteLine key={n.key} note={n} />)}
                    </ul>
                  </details>
                ) : lines.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {lines.map((n) => <NoteLine key={n.key} note={n} />)}
                  </ul>
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
              </div>
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

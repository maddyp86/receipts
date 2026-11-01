import { useEffect, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, LightbulbIcon, Loader2Icon, MinusIcon, TriangleAlertIcon } from 'lucide-react';
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
  'A NO vote can line up with a goal, if the bill would have set the goal back.',
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

/**
 * One line under a stage: what part of it is happening, said once. A group of
 * notes ("each bill checked", "each bill read") becomes one summary line, and
 * its notes are kept behind it for the reader who wants to see each one. A
 * note with no group is its own line.
 */
export interface Subtask {
  key: string;
  status: NoteEvent['status'];
  text: string;
  /** The individual notes behind the summary. Empty for a single note. */
  items: NoteEvent[];
}

/** Which summary line a group's notes sit under. A version note is about a bill being read. */
const BUCKET: Record<NonNullable<NoteEvent['group']>, string> = {
  relevance: 'relevance',
  read: 'read',
  version: 'read',
  gated: 'gated',
};

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`;

function summarize(bucket: string, items: NoteEvent[]): Pick<Subtask, 'status' | 'text'> {
  switch (bucket) {
    case 'relevance': {
      const decided = items.filter((n) => n.outcome);
      if (decided.length === items.length) {
        const kept = decided.filter((n) => n.outcome === 'kept').length;
        return { status: 'done', text: `${kept} about this · ${decided.length - kept} set aside` };
      }
      const checked = items.filter((n) => n.status !== 'running').length;
      return { status: 'running', text: `Checking which are about this · ${checked} of ${items.length}` };
    }
    case 'read': {
      const reads = items.filter((n) => n.group === 'read');
      const finished = reads.filter((n) => n.status !== 'running').length;
      return finished < reads.length
        ? { status: 'running', text: `Reading ${finished} of ${bills(reads.length)}` }
        : { status: 'done', text: `Read ${bills(reads.length)}` };
    }
    case 'gated':
      return { status: 'skipped', text: `${bills(items.length)} not counted, by rule` };
    default:
      return { status: 'done', text: '' };
  }
}

export function subtasksFor(lines: NoteEvent[]): Subtask[] {
  const out: Subtask[] = [];
  const grouped = new Map<string, NoteEvent[]>();
  for (const n of lines) {
    if (!n.group) {
      out.push({ key: n.key, status: n.status, text: n.text, items: [] });
      continue;
    }
    const bucket = BUCKET[n.group];
    const items = grouped.get(bucket);
    if (items) items.push(n);
    else {
      grouped.set(bucket, [n]);
      // Placed where the group first appeared, filled in below.
      out.push({ key: `group:${bucket}`, status: 'running', text: '', items: [] });
    }
  }
  return out.map((t) => {
    if (!t.key.startsWith('group:')) return t;
    const bucket = t.key.slice('group:'.length);
    const items = grouped.get(bucket)!;
    return { ...t, ...summarize(bucket, items), items };
  });
}

function StatusMark({ status, size = 'h-3.5 w-3.5' }: { status: NoteEvent['status']; size?: string }) {
  return status === 'running' ? (
    <Loader2Icon className={`${size} animate-spin text-ink-soft motion-reduce:animate-none`} />
  ) : status === 'done' ? (
    <CheckIcon className={`${size} text-ink`} strokeWidth={3} />
  ) : (
    <MinusIcon className={`${size} text-ink-soft`} strokeWidth={3} />
  );
}

/** A subtask's line, and — folded until the reader opens it — each thing behind it. */
function SubtaskLine({ task }: { task: Subtask }) {
  return (
    <li className="animate-fade-in text-[14px] leading-snug" data-status={task.status}>
      <div className="flex items-start gap-2">
        <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          <StatusMark status={task.status} />
        </span>
        <span className={`tabular-nums ${task.status === 'skipped' ? 'text-ink-soft' : 'text-ink'}`}>{task.text}</span>
      </div>
      {task.items.length ? (
        <details className="group ml-[22px]">
          <summary className="flex min-h-[32px] cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-focus [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
            <span className="group-open:hidden">See each bill ({task.items.length})</span>
            <span className="hidden group-open:inline">Hide</span>
          </summary>
          <ul className="mb-1 space-y-1.5 border-l border-rule pl-3">
            {task.items.map((n) => <NoteLine key={n.key} note={n} />)}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function NoteLine({ note }: { note: NoteEvent }) {
  return (
    <li className="flex items-start gap-2 text-[13px] leading-snug" data-status={note.status}>
      <span className="mt-[2px] flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
        <StatusMark status={note.status} size="h-3 w-3" />
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
  compact = false,
}: {
  asked: string;
  /** What is being checked; null until it is known. */
  statement: string | null;
  memberName: string;
  interpretation: Interpretation | null;
  done?: boolean;
  onChange: () => void;
  className?: string;
  /** Tighter, for the landing page's progress pop-up. */
  compact?: boolean;
}) {
  const topics = interpretation
    ? [interpretation.primary_issue, interpretation.sub_issue].filter((t, i, all): t is string => Boolean(t) && all.indexOf(t) === i)
    : [];
  return (
    <section aria-label="Your question" className={`rounded-card border border-rule bg-card ${compact ? 'px-4 py-3' : 'p-4'} ${className}`}>
      <p className={`font-medium text-ink-soft ${compact ? 'text-[13px]' : 'text-[14px]'}`}>You asked</p>
      <p className={`mt-0.5 leading-snug text-ink-soft ${compact ? 'text-[15px]' : 'text-[16px]'}`}>“{asked}”</p>
      {statement ? (
        <p
          className={`leading-snug text-ink ${compact ? 'mt-2' : 'mt-3'} ${
            done ? 'text-[17px] font-medium' : compact ? 'font-serif text-[17px]' : 'font-serif text-[20px]'
          }`}
        >
          {checkingLine(statement, memberName, done)}
        </p>
      ) : null}
      {topics.length && !compact ? (
        <div className={`flex flex-wrap items-center gap-2 text-ink-soft ${compact ? 'mt-2 text-[13px]' : 'mt-3 text-[14px]'}`}>
          <span>Filed under</span>
          {topics.map((t) => (
            <span key={t} className={`rounded-full border border-rule bg-paper ${compact ? 'px-2.5 py-0.5' : 'px-3 py-1'}`}>
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {statement ? (
        <button
          type="button"
          onClick={onChange}
          className={`inline-flex items-center font-medium text-focus underline underline-offset-4 ${
            compact ? 'mt-1 min-h-[36px] text-[14px]' : 'mt-2 min-h-[44px] text-[15px]'
          }`}
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
  /**
   * Inside the landing page's progress pop-up: no top bar of its own (the
   * pop-up has its own header and Cancel).
   */
  framed?: boolean;
}

export function Waiting({
  member,
  promise,
  steps,
  notes = [],
  interpretation,
  rewritten = null,
  asked = null,
  onCancel,
  onChange,
  framed = false,
}: Props) {
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
      {framed ? null : (
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
      )}

      {/* In the pop-up its header names the member: no strip, no heading. */}
      {framed ? null : (
        <div className="mt-6">
          <SelectedMember member={member} compact />
        </div>
      )}

      <section aria-live="polite" className={framed ? '' : 'mt-8'}>
        {framed ? null : (
          <h1 className="font-serif text-[28px] leading-tight text-ink sm:text-[32px]">
            Checking {member.name}’s record
          </h1>
        )}

        {/* One card: what they asked, and what we are checking to answer it.
            Shown as soon as each is known — the earliest point at which a
            misread can be caught — with one way to fix it. */}
        <QuestionCard
          compact={framed}
          className={`${framed ? '' : 'mt-4'} animate-rise-in shadow-soft`}
          asked={rewritten ? rewritten.original : (asked ?? promise)}
          statement={rewritten ? rewritten.statement : asked ? promise : (interpretation?.restated ?? null)}
          memberName={member.name}
          interpretation={interpretation}
          onChange={() => onChange(rewritten ? rewritten.statement : promise)}
        />

        <p className={framed ? 'mt-2 text-[13px] text-ink-soft' : 'mt-4 text-[15px] text-ink-soft'}>
          This usually takes about a minute. <span className="tabular-nums">{elapsed}s</span> so far.
        </p>
      </section>

      <ol className={`rounded-card border border-rule bg-card shadow-soft ${framed ? 'mt-2 p-1' : 'mt-3 space-y-1 p-2'}`}>
        {STAGES.map((stage, i) => {
          const status = statuses[i]!;
          // In the pop-up, only the four big steps: no detail line, no
          // subtasks, no "See each bill". The full breakdown is the tool's
          // waiting page; here the pop-up should not grow as the run goes on.
          const detail = framed ? null : detailFor(stage);
          const tasks = framed || status === 'waiting' ? [] : subtasksFor(notesFor(stage, notes));
          return (
            <li
              key={i}
              className={`flex items-start rounded-lg ${framed ? 'min-h-[40px] gap-3 px-2.5 py-2' : 'min-h-[56px] gap-4 px-3 py-3'}`}
              data-status={status}
            >
              <span className={`flex shrink-0 items-center justify-center ${framed ? 'h-6 w-6' : 'h-8 w-8'}`} aria-hidden="true">
                {status === 'done' ? (
                  <span
                    className={`flex items-center justify-center rounded-full text-paper ${
                      framed ? 'h-5 w-5 bg-lp-brand' : 'h-7 w-7 bg-ink'
                    }`}
                  >
                    <CheckIcon className={framed ? 'h-3 w-3' : 'h-4 w-4'} strokeWidth={3} />
                  </span>
                ) : status === 'working' ? (
                  <Loader2Icon
                    className={`${framed ? 'h-5 w-5 text-lp-brand' : 'h-6 w-6 text-ink'} animate-spin motion-reduce:animate-none`}
                  />
                ) : status === 'error' ? (
                  <TriangleAlertIcon className="h-6 w-6 text-broken" />
                ) : (
                  <span className={`${framed ? 'h-5 w-5' : 'h-6 w-6'} rounded-full border-2 border-rule`} />
                )}
              </span>
              <div className={`min-w-0 flex-1 ${framed ? 'pt-0.5' : 'pt-1'}`}>
                <span
                  className={`block ${framed ? 'text-[15px]' : 'text-[17px]'} ${
                    status === 'working' ? 'font-semibold text-ink' : status === 'waiting' ? 'text-ink-soft' : 'text-ink'
                  }`}
                >
                  {stage.label(member.name)}
                </span>
                {/* The subtasks say what the detail line says, and more. */}
                {detail && status !== 'waiting' && !tasks.length ? (
                  <span className="block text-[14px] text-ink-soft">{detail}</span>
                ) : null}
                {/* Three levels: the stage, one line per part of it, and —
                    a tap away — each bill behind that line. */}
                {tasks.length ? (
                  <ul className={framed ? 'mt-1 space-y-1' : 'mt-2 space-y-1.5'}>
                    {tasks.map((t) => <SubtaskLine key={t.key} task={t} />)}
                  </ul>
                ) : null}
                <span className="sr-only">
                  {status === 'done'
                    ? '(done)'
                    : status === 'working'
                      ? '(working now)'
                      : status === 'error'
                        ? '(failed)'
                        : '(up next)'}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {framed ? null : (
      <aside className="mt-6 rounded-card bg-cantsay-wash p-5" aria-label="Good to know">
        <p className="flex items-center gap-2 text-[15px] font-medium text-ink-soft">
          <LightbulbIcon className="h-4 w-4" aria-hidden="true" />
          Good to know
        </p>
        <p key={tip} className="mt-2 min-h-[56px] animate-fade-in text-[17px] leading-relaxed text-ink">
          {EXPLAINERS[tip]}
        </p>
      </aside>
      )}
    </>
  );
}

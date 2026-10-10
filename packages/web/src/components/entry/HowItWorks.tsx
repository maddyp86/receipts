import { CheckIcon } from 'lucide-react';

const STEPS = ['Pick who to check', 'Say what they promised or stand for', 'See what they actually did'];

/** The three steps, with the ones already finished on this screen ticked. */
export function HowItWorks({ done }: { done: number }) {
  return (
    <nav aria-label="How it works">
      <ol className="flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:gap-4">
        {STEPS.map((label, i) => {
          const isDone = i < done;
          const isCurrent = i === done;
          return (
            <li key={label} className="flex items-center gap-3 sm:flex-col sm:items-start sm:gap-2">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[14px] font-semibold ${
                  isDone
                    ? 'border-ink bg-ink text-paper'
                    : isCurrent
                      ? 'border-ink bg-card text-ink'
                      : 'border-rule bg-card text-ink-soft'
                }`}
                aria-hidden="true"
              >
                {isDone ? <CheckIcon className="h-4 w-4" strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={`text-[16px] leading-snug sm:text-[15px] ${isCurrent ? 'font-semibold text-ink' : 'text-ink-soft'}`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {label}
                {isDone ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

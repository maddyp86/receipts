import { useState } from 'react';
import { CheckIcon, ChevronDownIcon, CornerDownLeftIcon, XIcon } from 'lucide-react';
import { askingPairs, cantCheck, topics } from '../../data/topics.js';

// ===========================================================================
// "Need help phrasing it?" — topic starters and "How to ask", in one toggle.
//
// Closed by default, one tap away, and in the page either way (a native
// <details>, the same pattern as "About this beta"). Shared by the tool's
// question box (light) and the landing page's composer (dark), so the help a
// first-time visitor sees is the help a returning one sees.
//
// Every example fills the question box and focuses it; nothing here submits.
// ===========================================================================

type Tone = 'light' | 'dark';

const TONE: Record<Tone, Record<string, string>> = {
  light: {
    summary: 'text-focus',
    hint: 'text-ink-soft',
    chip: 'border-rule bg-card text-ink hover:border-ink-faint',
    chipOn: 'border-ink bg-ink text-paper',
    panel: 'rounded-card border border-rule bg-card',
    panelHint: 'text-ink-soft',
    divide: 'divide-rule',
    row: 'text-ink hover:bg-paper',
    use: 'text-ink-soft',
    tips: 'border-rule text-ink-soft',
    strong: 'text-ink',
    no: 'text-broken',
    yes: 'text-kept',
    tryRow: 'hover:bg-card hover:text-ink',
  },
  dark: {
    summary: 'text-lp-signal',
    hint: 'text-white/60',
    chip: 'border-white/15 bg-lp-navy text-white/85 hover:border-white/40',
    chipOn: 'border-lp-signal bg-lp-signal text-lp-navy',
    panel: 'rounded-xl border border-white/10 bg-lp-navy',
    panelHint: 'text-white/60',
    divide: 'divide-white/10',
    row: 'text-white hover:bg-white/5',
    use: 'text-white/55',
    tips: 'border-white/10 text-white/70',
    strong: 'text-white',
    no: 'text-[#F97066]',
    yes: 'text-lp-verified-bright',
    tryRow: 'hover:bg-white/5 hover:text-white',
  },
};

interface Props {
  /** Put this text in the question box. */
  onPick: (text: string) => void;
  tone?: Tone;
  /** Classes on the <details> (spacing). */
  className?: string;
}

export function PhrasingHelp({ onPick, tone = 'light', className = 'group mt-6' }: Props) {
  const [topicId, setTopicId] = useState<string | null>(null);
  const topic = topics.find((t) => t.id === topicId);
  const c = TONE[tone];

  return (
    <details className={className}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={`inline-flex min-h-[44px] items-center gap-1 text-[16px] font-medium underline underline-offset-4 ${c.summary}`}>
          Need help phrasing it?
          <ChevronDownIcon className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="mt-3">
        <p className={`text-[16px] ${c.hint}`}>Start with a topic:</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {topics.map((t) => {
            const active = t.id === topicId;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                onClick={() => setTopicId(active ? null : t.id)}
                className={`min-h-[44px] whitespace-nowrap rounded-full border px-4 text-[16px] transition-colors duration-150 ${
                  active ? c.chipOn : c.chip
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {topic ? (
          <div key={topic.id} className={`mt-4 animate-rise-in ${c.panel}`}>
            <p className={`px-4 pt-4 text-[15px] ${c.panelHint}`}>Tap one to use it. You can change the words after.</p>
            <ul className={`mt-2 divide-y ${c.divide}`}>
              {topic.examples.map((ex) => (
                <li key={ex.text}>
                  <button
                    type="button"
                    onClick={() => onPick(ex.text)}
                    className={`flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left text-[17px] transition-colors duration-150 ${c.row}`}
                  >
                    <span>“{ex.text}”</span>
                    <span className={`flex shrink-0 items-center gap-1 text-[14px] ${c.use}`}>
                      Use
                      <CornerDownLeftIcon className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div id="promise-tips" className={`mt-6 border-t pt-4 text-[15px] ${c.tips}`}>
        <p className={`font-medium ${c.strong}`}>How to ask</p>
        <ul className="mt-2 space-y-4">
          {askingPairs.map((pair) => (
            <li key={pair.instead}>
              <p className="flex items-start gap-2">
                <XIcon className={`mt-0.5 h-4 w-4 shrink-0 ${c.no}`} aria-hidden="true" />
                <span>
                  <span className={`font-medium ${c.strong}`}>Instead of</span> "{pair.instead}"
                </span>
              </p>
              <p className={`mt-1.5 pl-6 font-medium ${c.strong}`}>Try</p>
              <ul className="mt-0.5 space-y-0.5 pl-6">
                {pair.tries.map((t) => (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => onPick(t)}
                      className={`-ml-1 flex min-h-[36px] items-start gap-2 rounded px-1 py-1 text-left transition-colors duration-150 ${c.tryRow}`}
                    >
                      <CheckIcon className={`mt-0.5 h-4 w-4 shrink-0 ${c.yes}`} aria-hidden="true" />
                      <span>"{t}"</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          <li className="flex items-start gap-2">
            <XIcon className={`mt-0.5 h-4 w-4 shrink-0 ${c.no}`} aria-hidden="true" />
            <span>
              <span className={`font-medium ${c.strong}`}>Can't check</span> "{cantCheck.text}": {cantCheck.why}.
            </span>
          </li>
        </ul>
      </div>
    </details>
  );
}

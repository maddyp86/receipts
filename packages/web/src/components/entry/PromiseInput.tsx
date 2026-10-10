import { useState } from 'react';
import { CheckIcon, CornerDownLeftIcon, XIcon } from 'lucide-react';
import { SPECIFIC_EXAMPLES, askingPairs, cantCheck, topics } from '../../data/topics.js';
import { GlossaryTerm } from '../glossary/GlossaryTerm.js';

export type StatementKind = 'position' | 'promise';

const KINDS: ReadonlyArray<{ kind: StatementKind; label: string; hint: string }> = [
  { kind: 'position', label: 'A position they hold', hint: 'Something they say they support or oppose' },
  { kind: 'promise', label: 'A promise they made', hint: 'Something they said they would do' },
];

interface Props {
  memberName: string | null;
  value: string;
  onChange: (value: string) => void;
  /**
   * Whether the reader may assert "this was a campaign promise". The server
   * gates that path behind a flag; a choice it would ignore is not offered.
   */
  kindEnabled: boolean;
  kind: StatementKind;
  onKindChange: (kind: StatementKind) => void;
}

export function PromiseInput({ memberName, value, onChange, kindEnabled, kind, onKindChange }: Props) {
  const [topicId, setTopicId] = useState<string | null>(null);
  const topic = topics.find((t) => t.id === topicId);

  function pick(text: string) {
    onChange(text);
    requestAnimationFrame(() => {
      const el = document.getElementById('promise') as HTMLTextAreaElement | null;
      if (el) {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  }

  return (
    <div>
      <label htmlFor="promise" className="block font-serif text-[26px] leading-tight text-ink sm:text-[30px]">
        What does {memberName ?? 'your lawmaker'} stand for, or what did they promise?
      </label>
      <p id="promise-help" className="mt-2 text-[17px] text-ink-soft">
        Use your own words, and say it as a statement — one idea at a time works best. We’ll check it against how they
        voted and what bills they backed.
      </p>

      {kindEnabled ? (
        <fieldset className="mt-5">
          <legend className="text-[16px] text-ink">
            Is this a <GlossaryTerm id="position">promise or a position</GlossaryTerm>?
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {KINDS.map((k) => {
              const active = kind === k.kind;
              return (
                <label
                  key={k.kind}
                  className={`flex min-h-[60px] cursor-pointer items-start gap-3 rounded-card border bg-card px-4 py-3 transition-colors duration-150 ${
                    active ? 'border-ink ring-1 ring-ink' : 'border-rule hover:border-ink-faint'
                  }`}
                >
                  <input
                    type="radio"
                    name="statement-kind"
                    value={k.kind}
                    checked={active}
                    onChange={() => onKindChange(k.kind)}
                    className="mt-1 h-5 w-5 shrink-0 accent-[#1C1B19]"
                  />
                  <span>
                    <span className="block text-[17px] font-medium text-ink">{k.label}</span>
                    <span className="block text-[14px] leading-snug text-ink-soft">{k.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[14px] text-ink-soft">Not sure? Leave it on “position.”</p>
        </fieldset>
      ) : null}

      <textarea
        id="promise"
        aria-describedby="promise-help promise-examples promise-tips"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={600}
        placeholder={`e.g., ${SPECIFIC_EXAMPLES[0]}`}
        className="mt-5 w-full resize-none rounded-card border border-rule bg-card px-4 py-3.5 text-[18px] leading-relaxed text-ink shadow-soft placeholder:text-ink-faint focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
      />
      <p id="promise-examples" className="mt-2 text-[15px] leading-relaxed text-ink-soft">
        Be specific: name the policy, program or bill. For example,{' '}
        {SPECIFIC_EXAMPLES.map((ex, i) => (
          <span key={ex}>
            “{ex}”{i < SPECIFIC_EXAMPLES.length - 2 ? ', ' : i === SPECIFIC_EXAMPLES.length - 2 ? ' or ' : '.'}
          </span>
        ))}
      </p>

      <div className="mt-6">
        <p className="text-[16px] text-ink-soft">Not sure how to say it? Start with a topic:</p>
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
                  active ? 'border-ink bg-ink text-paper' : 'border-rule bg-card text-ink hover:border-ink-faint'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {topic ? (
          <div key={topic.id} className="mt-4 animate-rise-in rounded-card border border-rule bg-card">
            <p className="px-4 pt-4 text-[15px] text-ink-soft">Tap one to use it. You can change the words after.</p>
            <ul className="mt-2 divide-y divide-rule">
              {topic.examples.map((ex) => (
                <li key={ex.text}>
                  <button
                    type="button"
                    onClick={() => pick(ex.text)}
                    className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left text-[17px] text-ink transition-colors duration-150 hover:bg-paper"
                  >
                    <span>“{ex.text}”</span>
                    <span className="flex shrink-0 items-center gap-1 text-[14px] text-ink-soft">
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

      <div id="promise-tips" className="mt-6 border-t border-rule pt-4 text-[15px] text-ink-soft">
        <p className="font-medium text-ink">How to ask</p>
        <ul className="mt-2 space-y-4">
          {askingPairs.map((pair) => (
            <li key={pair.instead}>
              <p className="flex items-start gap-2">
                <XIcon className="mt-0.5 h-4 w-4 shrink-0 text-broken" aria-hidden="true" />
                <span>
                  <span className="font-medium text-ink">Instead of</span> "{pair.instead}"
                </span>
              </p>
              <p className="mt-1.5 pl-6 font-medium text-ink">Try</p>
              <ul className="mt-0.5 space-y-0.5 pl-6">
                {pair.tries.map((t) => (
                  <li key={t}>
                    {/* Fills the box and focuses it; never submits. */}
                    <button
                      type="button"
                      onClick={() => pick(t)}
                      className="-ml-1 flex min-h-[36px] items-start gap-2 rounded px-1 py-1 text-left transition-colors duration-150 hover:bg-card hover:text-ink"
                    >
                      <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-kept" aria-hidden="true" />
                      <span>"{t}"</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          <li className="flex items-start gap-2">
            <XIcon className="mt-0.5 h-4 w-4 shrink-0 text-broken" aria-hidden="true" />
            <span>
              <span className="font-medium text-ink">Can't check</span> "{cantCheck.text}" — {cantCheck.why}.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

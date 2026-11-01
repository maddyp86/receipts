import { SPECIFIC_EXAMPLES } from '../../data/topics.js';
import { PhrasingHelp } from './PhrasingHelp.js';
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
  /**
   * Inside the landing page's query card: a short label, no paragraph of
   * help above the box (the placeholder and the examples line carry it).
   */
  compact?: boolean;
}

export function PromiseInput({ memberName, value, onChange, kindEnabled, kind, onKindChange, compact = false }: Props) {

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
      <label
        htmlFor="promise"
        className={compact ? 'block text-[16px] font-semibold text-ink' : 'block font-serif text-[26px] leading-tight text-ink sm:text-[30px]'}
      >
        {compact
          ? `What do you want to check${memberName ? ` about ${memberName}` : ''}?`
          : `What do you want to check about ${memberName ?? 'your lawmaker'}?`}
      </label>
      <p id="promise-help" className={compact ? 'sr-only' : 'mt-2 text-[17px] text-ink-soft'}>
        Ask what they did, like “Did they vote to extend the ACA tax credits?”, or check something they said, like
        “promised to protect clean air standards”. One idea at a time works best. We’ll check it against how they
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
        rows={compact ? 2 : 3}
        maxLength={600}
        placeholder={`e.g., ${SPECIFIC_EXAMPLES[0]}`}
        className={`${compact ? 'mt-2 text-[17px]' : 'mt-5 text-[18px] shadow-soft'} w-full resize-none rounded-card border border-rule bg-card px-4 py-3.5 leading-relaxed text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus`}
      />
      <p id="promise-examples" className={`mt-2 leading-relaxed text-ink-soft ${compact ? 'hidden text-[14px] sm:block' : 'text-[15px]'}`}>
        Be specific: name the policy, program or bill. For example,{' '}
        {SPECIFIC_EXAMPLES.map((ex, i) => (
          <span key={ex}>
            “{ex}”{i < SPECIFIC_EXAMPLES.length - 2 ? ', ' : i === SPECIFIC_EXAMPLES.length - 2 ? ' or ' : '.'}
          </span>
        ))}
      </p>

      {/* Help for phrasing: topic starters and "How to ask" (shared with the landing page). */}
      <PhrasingHelp onPick={pick} className={`group ${compact ? 'mt-1' : 'mt-6'}`} />
    </div>
  );
}

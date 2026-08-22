import { useMemo } from 'react';
import type { Senator } from '@receipts/shared';

// ===========================================================================
// The entry screen.
//
// Deliberately minimal. The senator picker is not clutter — it is how a user
// learns what they can ask, so coverage is labelled honestly rather than hidden
// behind a search box that quietly fails.
// ===========================================================================

export interface ExamplePromise {
  label: string;
  senatorId: string;
  text: string;
}

/**
 * Three examples, chosen to show three different shapes of answer rather than
 * three wins: a clean kept promise, a genuinely mixed record, and one where the
 * intuitive reading of the vote is backwards.
 */
export const EXAMPLES: ExamplePromise[] = [
  {
    label: 'Drug pricing',
    senatorId: 'S000148',
    text: 'promised to lower prescription drug prices',
  },
  {
    label: 'Background checks',
    senatorId: 'S000148',
    text: 'promised to require universal background checks and close the gun show loophole',
  },
  {
    label: 'Clean air',
    senatorId: 'S000148',
    text: 'promised to protect clean air standards from rollback',
  },
];

interface Props {
  senators: Senator[];
  selected: string;
  promise: string;
  busy: boolean;
  onSelect: (politicianId: string) => void;
  onPromiseChange: (text: string) => void;
  onSubmit: () => void;
  onExample: (example: ExamplePromise) => void;
}

export function Entry({
  senators,
  selected,
  promise,
  busy,
  onSelect,
  onPromiseChange,
  onSubmit,
  onExample,
}: Props) {
  // Analysed senators first — the picker should lead with what works.
  const ordered = useMemo(
    () => [...senators].sort((a, b) => Number(b.cached) - Number(a.cached)),
    [senators],
  );

  const canSubmit = Boolean(selected) && promise.trim().length > 2 && !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div className="field">
        <span className="field-label" id="senator-label">
          Senator
        </span>
        <div className="senators" role="group" aria-labelledby="senator-label">
          {ordered.map((s) => (
            <button
              key={s.politician_id}
              type="button"
              className="senator"
              aria-pressed={selected === s.politician_id}
              onClick={() => onSelect(s.politician_id)}
            >
              <span>
                <span className="senator-name">{s.name}</span>
                <span className="senator-meta">
                  {s.party}
                  {s.state ? `–${s.state}` : ''}
                </span>
              </span>
              <span className={s.cached ? 'coverage available' : 'coverage'}>
                {s.cached ? 'Available now' : 'Not analyzed yet'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="promise">The promise</label>
        <textarea
          id="promise"
          className="promise"
          value={promise}
          placeholder="e.g., promised to lower prescription drug prices."
          onChange={(e) => onPromiseChange(e.target.value)}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              className="example"
              onClick={() => onExample(ex)}
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      <div className="submit-row">
        <button type="submit" className="submit" disabled={!canSubmit}>
          {busy ? 'Checking…' : 'Check this promise'}
        </button>
        <p className="trust-cue">Every answer links back to real bills.</p>
      </div>
    </form>
  );
}

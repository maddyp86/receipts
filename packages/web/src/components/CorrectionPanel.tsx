import { useMemo, useState } from 'react';
import type { Corrections, Interpretation } from '@receipts/shared';

// ===========================================================================
// The correctable-classification surface.
//
// THE CENTRAL CONSTRAINT: every field here is inside the embedded query text,
// so changing one moves the query vector and therefore the candidate set. A
// correction is a FULL RE-RUN from embedding — not a re-evaluation of the
// matches already on screen, and not a filter over them.
//
// That is why these are staged edits behind an explicit "Re-run with these
// corrections" button rather than live controls. Live controls would imply the
// result reshapes in place, which is precisely what it cannot do. The pending
// state is visible and labelled so the user can see the difference between
// "what I typed" and "what has actually been checked".
// ===========================================================================

export interface TaxonomyEntry {
  primary_issue: string;
  sub_issues: string[];
}

interface Props {
  interpretation: Interpretation;
  taxonomy: TaxonomyEntry[];
  /** Whether the deployment enables the Campaign Promise override. */
  overrideEnabled: boolean;
  busy: boolean;
  onRerun: (corrections: Corrections) => void;
}

const STANCES = ['In Favor', 'Opposed', 'Neutral/Unclear'] as const;
const PROMISE_TYPES = ['policy', 'process', 'rhetorical', 'non_legislative'] as const;

export function CorrectionPanel({
  interpretation,
  taxonomy,
  overrideEnabled,
  busy,
  onRerun,
}: Props) {
  const [open, setOpen] = useState(false);
  const [primary, setPrimary] = useState(interpretation.primary_issue);
  const [sub, setSub] = useState(interpretation.sub_issue);
  const [stance, setStance] = useState<string>(interpretation.stance);
  const [promiseType, setPromiseType] = useState<string>(interpretation.promise_type);
  const [terms, setTerms] = useState(interpretation.key_policy_terms.join(', '));
  const [assertPromise, setAssertPromise] = useState(false);

  const subOptions = useMemo(
    () => taxonomy.find((t) => t.primary_issue === primary)?.sub_issues ?? [],
    [taxonomy, primary],
  );

  // Changing the primary issue invalidates the sub-issue: the pair is the key
  // the keyword lookup uses, so a stale sub-issue would produce a combination
  // that is not in the taxonomy at all.
  const onPrimaryChange = (next: string) => {
    setPrimary(next);
    const options = taxonomy.find((t) => t.primary_issue === next)?.sub_issues ?? [];
    setSub(options.includes(sub) ? sub : (options[0] ?? ''));
  };

  const currentTerms = interpretation.key_policy_terms.join(', ');
  const pending = [
    primary !== interpretation.primary_issue && { field: 'Primary issue', from: interpretation.primary_issue, to: primary },
    sub !== interpretation.sub_issue && { field: 'Sub issue', from: interpretation.sub_issue, to: sub },
    stance !== interpretation.stance && { field: 'Stance', from: interpretation.stance, to: stance },
    promiseType !== interpretation.promise_type && { field: 'Promise type', from: interpretation.promise_type, to: promiseType },
    terms.trim() !== currentTerms && { field: 'Key policy terms', from: currentTerms || '(none)', to: terms.trim() || '(none)' },
    assertPromise && { field: 'Statement type', from: 'Policy Position', to: 'Campaign Promise' },
  ].filter(Boolean) as Array<{ field: string; from: string; to: string }>;

  const rerun = () => {
    const corrections: Corrections = {};
    if (primary !== interpretation.primary_issue) corrections.primary_issue = primary;
    if (sub !== interpretation.sub_issue) corrections.sub_issue = sub;
    if (stance !== interpretation.stance) corrections.stance = stance as Corrections['stance'];
    if (promiseType !== interpretation.promise_type) {
      corrections.promise_type = promiseType as Corrections['promise_type'];
    }
    if (terms.trim() !== currentTerms) {
      corrections.key_policy_terms = terms
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (assertPromise) corrections.assert_campaign_promise = true;
    onRerun(corrections);
  };

  if (!open) {
    return (
      <button type="button" className="correction-toggle" onClick={() => setOpen(true)}>
        Something misread? Correct the classification
      </button>
    );
  }

  return (
    <section className="correction-panel" aria-label="Correct the classification">
      <h3>Correct the classification</h3>
      <p className="correction-note">
        These values are part of the search itself — changing one changes which bills are
        found. Corrections are applied by re-running the whole check, not by re-filtering
        what is on screen.
      </p>

      <div className="correction-grid">
        <label>
          Primary issue
          <select value={primary} onChange={(e) => onPrimaryChange(e.target.value)} disabled={busy}>
            {taxonomy.map((t) => (
              <option key={t.primary_issue} value={t.primary_issue}>
                {t.primary_issue}
              </option>
            ))}
          </select>
        </label>

        <label>
          Sub issue
          <select value={sub} onChange={(e) => setSub(e.target.value)} disabled={busy}>
            {subOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label>
          Stance
          <select value={stance} onChange={(e) => setStance(e.target.value)} disabled={busy}>
            {STANCES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label>
          Promise type
          <select value={promiseType} onChange={(e) => setPromiseType(e.target.value)} disabled={busy}>
            {PROMISE_TYPES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label className="correction-wide">
          Key policy terms
          <input
            type="text"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            disabled={busy}
            placeholder="comma-separated"
          />
        </label>
      </div>

      {overrideEnabled ? (
        <label className="correction-assert">
          <input
            type="checkbox"
            checked={assertPromise}
            onChange={(e) => setAssertPromise(e.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>He actually promised this.</strong> Switches the wording from
            &ldquo;consistent with his record&rdquo; to &ldquo;kept / broke&rdquo;.{' '}
            <em>
              This is your claim, not ours — we have no record of the commitment. It will be
              labelled as yours wherever the result is shown or shared.
            </em>
          </span>
        </label>
      ) : null}

      {pending.length ? (
        <div className="correction-delta">
          <h4>What will change</h4>
          <ul>
            {pending.map((d) => (
              <li key={d.field}>
                <span className="delta-field">{d.field}</span>
                <span className="delta-from">{d.from}</span>
                <span className="delta-arrow" aria-label="becomes">
                  →
                </span>
                <span className="delta-to">{d.to}</span>
              </li>
            ))}
          </ul>
          {/* Said plainly, because the button does more than it looks like. */}
          <p className="correction-warning">
            The current result will be cleared and the check re-run from scratch.
          </p>
        </div>
      ) : (
        <p className="correction-note">No changes staged yet.</p>
      )}

      <div className="correction-actions">
        <button type="button" onClick={rerun} disabled={busy || pending.length === 0}>
          Re-run with these corrections
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * The attribution badge.
 *
 * Rendered wherever the verdict is — and it must survive into share/export,
 * because promise vocabulary without the attribution silently converts the
 * user's premise into our claim.
 */
export function AssertedPremiseBadge({ interpretation }: { interpretation: Interpretation }) {
  if (!interpretation.user_asserted_premise) return null;
  return (
    <p className="asserted-premise" data-share-include="true">
      <strong>You told us he promised this.</strong> We have no record of the commitment, so
      &ldquo;kept&rdquo; and &ldquo;broke&rdquo; here are measured against your premise, not
      ours.
    </p>
  );
}

/** The delta actually applied on this run, shown with the new result. */
export function AppliedCorrections({ interpretation }: { interpretation: Interpretation }) {
  const applied = interpretation.corrections_applied;
  if (!applied?.length) return null;
  return (
    <div className="applied-corrections">
      <h4>Re-run with your corrections</h4>
      <ul>
        {applied.map((d) => (
          <li key={d.field}>
            <span className="delta-field">{d.field.replace(/_/g, ' ')}</span>
            <span className="delta-from">{d.from || '(none)'}</span>
            <span className="delta-arrow">→</span>
            <span className="delta-to">{d.to || '(none)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

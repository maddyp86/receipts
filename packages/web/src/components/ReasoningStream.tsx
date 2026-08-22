import type { Interpretation, StepEvent } from '@receipts/shared';

// ===========================================================================
// The streamed reasoning panel.
//
// Narration only — nothing here computes anything. It exists because the
// visible thought process IS the traceability, so it is a first-class element
// rather than a spinner substitute.
//
// Each step is announced to screen readers as it resolves (aria-live), and the
// running marker respects prefers-reduced-motion.
// ===========================================================================

const MARK: Record<StepEvent['status'], string> = {
  running: '·',
  done: '✓',
  error: '!',
};

interface Props {
  steps: StepEvent[];
  interpretation: Interpretation | null;
}

export function ReasoningStream({ steps, interpretation }: Props) {
  if (!steps.length) return null;

  return (
    <>
      <section className="panel" aria-label="What we're doing">
        <h2 className="panel-title">Working</h2>
        <ol className="steps" aria-live="polite" aria-atomic="false">
          {steps.map((step) => (
            <li key={step.id} className="step" data-status={step.status}>
              <span className="step-mark" aria-hidden="true">
                {MARK[step.status]}
              </span>
              <span>
                {step.label}
                {step.detail ? <span className="step-detail"> — {step.detail}</span> : null}
                <span className="visually-hidden">
                  {step.status === 'done'
                    ? ', complete'
                    : step.status === 'error'
                      ? ', failed'
                      : ', in progress'}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {interpretation ? (
        <section className="panel" aria-label="How we read your promise">
          <h2 className="panel-title">What we think you asked</h2>
          <p className="restated">“{interpretation.restated}”</p>
          <div className="chips">
            {interpretation.primary_issue ? (
              <span className="chip">{interpretation.primary_issue}</span>
            ) : null}
            {interpretation.sub_issue ? (
              <span className="chip">{interpretation.sub_issue}</span>
            ) : null}
            <span className="chip">
              {interpretation.stance === 'In Favor'
                ? 'Wants this to happen'
                : interpretation.stance === 'Opposed'
                  ? 'Wants to stop this'
                  : 'Unclear which way'}
            </span>
          </div>
        </section>
      ) : null}
    </>
  );
}

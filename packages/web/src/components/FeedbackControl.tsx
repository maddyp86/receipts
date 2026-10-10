import { useState } from 'react';
import { FlagIcon } from 'lucide-react';
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_CONTROL_LABEL,
  FEEDBACK_THANKS,
  type FeedbackKind,
  type FeedbackLevel,
  type FeedbackRequest,
} from '@receipts/shared';
import { apiUrl } from '../lib/api.js';

// ===========================================================================
// "Something look wrong?" — on the result and on every evidence card.
//
// The reader says what it is about (the kinds for this level), optionally
// why, and sends it. It is stored for a person to review and never read back
// by the app, so it cannot change the answer — and the thanks says exactly
// that, so nobody waits for the page to update.
// ===========================================================================

export interface FeedbackContext {
  runId: string;
  politicianId: string;
  promiseText: string;
  verdictShown: string;
}

interface Props {
  level: FeedbackLevel;
  context: FeedbackContext;
  /** The bill, for an evidence card. */
  actionUid?: string;
  billId?: string;
}

const COMMENT_MAX = 1000;

export function FeedbackControl({ level, context, actionUid, billId }: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'sent') {
    return (
      <p className="feedback-thanks flex min-h-[44px] items-center text-[15px] text-ink-soft" role="status">
        {FEEDBACK_THANKS}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="feedback-toggle inline-flex min-h-[44px] items-center gap-2 rounded-md text-[15px] text-ink-soft underline-offset-4 transition-colors duration-150 hover:text-ink hover:underline"
        onClick={() => setOpen(true)}
      >
        <FlagIcon className="h-4 w-4" aria-hidden="true" />
        {FEEDBACK_CONTROL_LABEL}
      </button>
    );
  }

  async function send() {
    if (!kind) return;
    setState('sending');
    setError(null);
    const body: FeedbackRequest = {
      run_id: context.runId,
      kind,
      politician_id: context.politicianId,
      promise_text: context.promiseText,
      verdict_shown: context.verdictShown,
      ...(level === 'evidence' ? { action_uid: actionUid, bill_id: billId } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    try {
      const res = await fetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(j.error?.message ?? "Your feedback couldn't be saved just now.");
        setState('error');
        return;
      }
      setState('sent');
    } catch {
      setError('Could not reach the server.');
      setState('error');
    }
  }

  const name = `feedback-${level}-${actionUid ?? 'result'}`;
  return (
    <fieldset className="feedback-form my-2 rounded-card border border-rule bg-paper p-4">
      <legend className="float-left mb-2 w-full text-[16px] font-medium text-ink">What looks wrong?</legend>
      <div className="clear-both space-y-1">
        {FEEDBACK_KINDS[level].map((k) => (
          <label key={k} className="feedback-choice flex min-h-[44px] cursor-pointer items-center gap-3 text-[16px] text-ink">
            <input
              type="radio"
              name={name}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="h-5 w-5 accent-[#1C1B19]"
            />
            {FEEDBACK_KIND_LABEL[k]}
          </label>
        ))}
      </div>
      <label className="feedback-comment mt-3 block text-[15px] text-ink-soft">
        <span>Anything else? (optional)</span>
        <textarea
          value={comment}
          maxLength={COMMENT_MAX}
          rows={2}
          onChange={(e) => setComment(e.target.value)}
          className="mt-1 w-full resize-none rounded-lg border border-rule bg-card px-3 py-2 text-[16px] text-ink focus:border-focus focus:outline-none"
        />
      </label>
      {error ? (
        <p className="feedback-error mt-2 text-[15px] text-broken" role="alert">
          {error}
        </p>
      ) : null}
      <div className="feedback-actions mt-3 flex gap-2">
        <button
          type="button"
          onClick={send}
          disabled={!kind || state === 'sending'}
          className="min-h-[44px] rounded-card bg-ink px-4 text-[15px] font-medium text-paper transition-colors duration-150 disabled:bg-rule disabled:text-ink-soft"
        >
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={state === 'sending'}
          className="min-h-[44px] rounded-card px-4 text-[15px] text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

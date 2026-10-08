import { useState } from 'react';
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABEL,
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

  if (state === 'sent') return <p className="feedback-thanks">{FEEDBACK_THANKS}</p>;

  if (!open) {
    return (
      <button type="button" className="feedback-toggle" onClick={() => setOpen(true)}>
        Something look wrong?
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
    <fieldset className="feedback-form">
      <legend>What looks wrong?</legend>
      {FEEDBACK_KINDS[level].map((k) => (
        <label key={k} className="feedback-choice">
          <input type="radio" name={name} value={k} checked={kind === k} onChange={() => setKind(k)} />
          {FEEDBACK_KIND_LABEL[k]}
        </label>
      ))}
      <label className="feedback-comment">
        <span>Anything else? (optional)</span>
        <textarea
          value={comment}
          maxLength={COMMENT_MAX}
          rows={2}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <div className="feedback-actions">
        <button type="button" onClick={send} disabled={!kind || state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={state === 'sending'}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

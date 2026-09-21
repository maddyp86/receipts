import { useState } from 'react';
import { apiUrl } from '../lib/api.js';

// ===========================================================================
// Follow-up questions about THIS result.
//
// Explain-only, by design. The server answers from the run's own trace and
// is barred from producing a new verdict or reaching outside this run; a
// question that needs a new search is told so. The exchange lives here, in
// component state — it is never persisted, and a page reload clears it.
//
// Hidden when the server says follow-ups are unavailable (demo mode: no
// model to answer with). Offering a box the server would refuse is worse than
// not offering it.
// ===========================================================================

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  refused?: boolean;
}

interface Props {
  traceId: string;
  available: boolean;
  senatorName: string;
}

export function FollowUp({ traceId, available, senatorName }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!available) return null;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    const history = turns.map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: 'user', text: q }]);
    setQuestion('');
    try {
      const res = await fetch(apiUrl('/api/followup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: traceId, question: q, history }),
      });
      const body = (await res.json()) as { answer?: string; refused?: boolean; error?: { message: string } };
      if (!res.ok || !body.answer) {
        setError(body.error?.message ?? 'Could not get an answer.');
        return;
      }
      setTurns((t) => [...t, { role: 'assistant', text: body.answer!, refused: Boolean(body.refused) }]);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="followup" aria-label="Ask about this result">
      <h3 className="section-heading">Ask about this result</h3>
      <p className="followup-lead">
        Questions about what you see here — why a bill counted or didn’t, which vote decided,
        what a term means. Answers come from this result’s own record and can’t change it. A
        different statement or senator is a new query.
      </p>

      {turns.length ? (
        <ol className="followup-turns">
          {turns.map((t, i) => (
            <li key={i} className={`followup-turn ${t.role}`} data-refused={t.refused ? 'true' : undefined}>
              <span className="followup-who">{t.role === 'user' ? 'You' : 'Receipts'}</span>
              <p>{t.text}</p>
            </li>
          ))}
        </ol>
      ) : null}

      <form
        className="followup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label className="visually-hidden" htmlFor="followup-question">
          Your question
        </label>
        <textarea
          id="followup-question"
          className="promise followup-input"
          rows={2}
          maxLength={500}
          placeholder={`e.g., why didn’t the safe-storage bill count against ${senatorName}?`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <div className="followup-row">
          <button type="submit" className="submit followup-submit" disabled={busy || !question.trim()}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
          <span className="trust-cue">Not saved. Clears when you leave the page.</span>
        </div>
      </form>

      {error ? <p className="followup-error">{error}</p> : null}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestionIcon, XIcon } from 'lucide-react';
import { apiUrl } from '../lib/api.js';
import { sessionId } from '../lib/session.js';

// ===========================================================================
// Follow-up questions about THIS result.
//
// Explain-only, by design. The server answers from the run's own trace and
// is barred from producing a new verdict or reaching outside this run; a
// question that needs a new search is told so. The exchange lives here, in
// component state — it is never persisted, and a page reload clears it.
//
// A chat beside the answer: pinned in the right-hand column on a wide screen,
// where it grows its own history without pushing the answer down; on a phone,
// a sheet opened from a button pinned to the bottom of the screen. One
// instance either way, so closing the sheet keeps the conversation.
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
  /** Tappable first questions, built from this result (lib/followupSuggestions.ts). */
  suggestions?: readonly string[];
  /** Bumped by the page to open the chat and put the cursor in it ("Ask a question" under the answer). */
  openRequest?: number;
}

export function FollowUp({ traceId, available, senatorName, suggestions = [], openRequest = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Asked from outside: open the sheet on a phone, and on any screen put the
  // cursor in the box. The value at mount is not a request — it may be left
  // over from the previous answer.
  const openAtMount = useRef(openRequest);
  useEffect(() => {
    if (openRequest === openAtMount.current) return;
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [openRequest]);

  // The phone button draws the eye once, for a few seconds after the answer lands.
  const [nudge, setNudge] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setNudge(false), 4000);
    return () => window.clearTimeout(t);
  }, []);

  // The newest answer in view, inside the panel's own scroll.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, busy]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!available) return null;

  const ask = async (text?: string) => {
    const q = (text ?? question).trim();
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
        // The session id lets the server count that a follow-up was asked in
        // this visit. The question itself is not counted or kept.
        body: JSON.stringify({ run_id: traceId, question: q, history, session: sessionId() || undefined }),
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
    <>
      {/* Wide screens: always shown, in the column. Phones: a sheet, when open. */}
      <div className={open ? 'fixed inset-0 z-40 flex items-end lg:static lg:z-auto lg:block' : 'hidden lg:block'}>
        {open ? (
          <div className="absolute inset-0 animate-fade-in bg-ink/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
        ) : null}
        <section
          aria-label="Ask about this result"
          className={`followup-panel relative flex w-full flex-col rounded-t-2xl border border-rule bg-card shadow-soft lg:max-h-[calc(100vh-2rem)] lg:rounded-card ${
            open ? 'max-h-[85vh] animate-sheet-in lg:animate-none' : ''
          }`}
        >
          <div className="flex items-start justify-between gap-3 border-b border-rule px-4 pb-3 pt-4">
            <div>
              <h2 className="font-serif text-[20px] leading-snug text-ink">Ask about this result</h2>
              <p className="mt-1 text-[14px] leading-snug text-ink-soft">
                Why a bill counted or didn’t, which vote decided, what a term means. Answers come from this result and
                can’t change it.
              </p>
            </div>
            {open ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="-mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft lg:hidden"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="min-h-[120px] flex-1 overflow-y-auto px-4 py-3">
            {turns.length ? (
              <ol className="space-y-3">
                {turns.map((t, i) => (
                  <li
                    key={i}
                    className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    data-role={t.role}
                    data-refused={t.refused ? 'true' : undefined}
                  >
                    <p
                      className={`max-w-[90%] rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed ${
                        t.role === 'user'
                          ? 'rounded-br-md bg-focus text-paper'
                          : `rounded-bl-md bg-paper text-ink ${t.refused ? 'border border-dashed border-rule' : ''}`
                      }`}
                    >
                      <span className="sr-only">{t.role === 'user' ? 'You: ' : 'Receipts: '}</span>
                      {t.text}
                    </p>
                  </li>
                ))}
              </ol>
            ) : suggestions.length ? (
              <div>
                <p className="text-[14px] leading-relaxed text-ink-soft">Tap a question to ask it:</p>
                <ul className="mt-2 space-y-2">
                  {suggestions.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void ask(s)}
                        className="w-full rounded-2xl border border-brand/30 bg-paper px-3.5 py-2.5 text-left text-[15px] leading-snug text-brand transition-colors duration-150 hover:border-brand hover:bg-brand/5 disabled:opacity-50"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[14px] leading-relaxed text-ink-faint">
                For example: why didn’t one of these bills count for {senatorName}?
              </p>
            )}
            {busy ? <p className="mt-3 text-[14px] text-ink-soft">Thinking…</p> : null}
            {error ? <p className="mt-3 text-[14px] text-broken">{error}</p> : null}
            <div ref={endRef} />
          </div>

          <form
            className="border-t border-rule p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <label className="sr-only" htmlFor="followup-question">
              Your question
            </label>
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                id="followup-question"
                rows={2}
                maxLength={500}
                placeholder="Ask a question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a new line.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask();
                  }
                }}
                disabled={busy}
                className="min-h-[48px] flex-1 resize-none rounded-lg border border-rule bg-paper px-3 py-2 text-[16px] text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !question.trim()}
                className="min-h-[48px] rounded-lg bg-ink px-4 text-[16px] font-medium text-paper disabled:opacity-40"
              >
                Ask
              </button>
            </div>
            <p className="mt-1.5 text-[13px] text-ink-faint">Not saved. Clears when you leave the page.</p>
          </form>
        </section>
      </div>

      {/* Phones: the way in, pinned to the bottom of the screen. */}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`fixed bottom-4 inset-x-4 z-30 mx-auto inline-flex ${nudge ? 'animate-pulse ring-4 ring-brand/30' : ''} min-h-[52px] max-w-md items-center justify-center gap-2 whitespace-nowrap rounded-full bg-brand px-6 text-[16px] font-semibold text-white shadow-soft transition-colors duration-150 hover:bg-brand-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:hidden`}
        >
          <MessageCircleQuestionIcon className="h-5 w-5" aria-hidden="true" />
          Ask about this result
        </button>
      ) : null}
    </>
  );
}

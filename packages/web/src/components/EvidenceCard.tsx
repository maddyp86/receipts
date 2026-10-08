import { useState } from 'react';
import { FeedbackControl, type FeedbackContext } from './FeedbackControl.js';
import {
  EFFECT_UNREAD,
  STRENGTH_PHRASE,
  VOTE_FLAG_COPY,
  textVersionLines,
  congressLabel,
  congressOfBillId,
  governingVoteSentence,
  HISTORY_UNAVAILABLE_COPY,
  type DirectedAction,
} from '@receipts/shared';

// ===========================================================================
// One matched action.
//
// Two rules this component exists to keep:
//   1. Cloture and passage are named separately, never merged into "voted".
//   2. Behaviour is described, motive never is. A senator who sponsored a bill
//      and then didn't vote gets "did not cast a vote", not "avoided the vote"
//      — illness, a family emergency and strategy are indistinguishable here.
//   3. Naming both votes is only HALF of behavioural contract 2. The other half
//      is saying which one GOVERNED. "Voted NAY -> BROKE" beside an unmentioned
//      cloture YEA is the claim a senator's office knocks down (handoff v2 §4),
//      and naming both without saying which decided leaves the reader to guess
//      at the very point the verdict turns on.
//   4. A date is only called the day the senator acted when it is one. The
//      mirror supplies the first day of the Congress when it has no exact date
//      and the gates flag it; that renders as the Congress and "exact date not
//      in our record", never as a date.
// ===========================================================================

const VOTE_WORD: Record<string, string> = { YEA: 'voted yes', NAY: 'voted no' };

function describeBehaviour(e: DirectedAction): string {
  const named = (v: string | undefined) => VOTE_WORD[String(v ?? '').toUpperCase()];

  const parts: string[] = [];
  const cloture = named(e.cloture_vote);
  const passage = named(e.passage_vote);

  if (cloture) parts.push(`${cloture} on ending debate${onDate(e.cloture_vote_date)}`);
  if (passage) parts.push(`${passage} on final passage${onDate(e.passage_vote_date)}`);
  if (!parts.length) {
    const flat = named(e.vote);
    if (flat) parts.push(`${flat} on this bill`);
  }

  // Sponsored but recorded as not voting. Say exactly what happened.
  if (e.action_tier === 'ABSTAIN') {
    const role = e.is_sponsor ? 'sponsored' : e.is_cosponsor ? 'co-sponsored' : null;
    return role
      ? `${role} this bill but did not cast a vote when it came to the floor`
      : 'did not cast a vote when this came to the floor';
  }

  if (e.is_sponsor) parts.push('sponsored the bill');
  else if (e.is_cosponsor) parts.push('co-sponsored the bill');

  return parts.length ? parts.join(' and ') : 'took no recorded action on this bill';
}

/**
 * The bill's effect on the goal, as the evaluator read it. A reading, so it is
 * said as one. An unread bill is said only when no disclosure flag already
 * says it (EFFECT_UNREAD).
 */
function describeEffect(e: DirectedAction): string | null {
  const effect = String(e.bill_effect ?? '').toUpperCase();
  if (effect === 'ADVANCE') return 'As we read it, this bill moves that goal forward.';
  if (effect === 'HINDER') return 'As we read it, this bill sets that goal back.';
  if (effect === 'NEUTRAL') return 'As we read it, this bill doesn’t move that goal either way.';
  if (effect === 'CONTESTED') {
    return 'This bill can reasonably be read as moving that goal either way, so it isn’t counted in either direction.';
  }
  if (effect === 'ERROR' && !(e.vote_flags ?? []).includes(EFFECT_UNREAD)) {
    return 'We couldn’t read this bill against the statement, so it isn’t counted either way.';
  }
  return null;
}

/** " on 12 March 2024", or "" when there is no real roll-call date. */
function onDate(iso: string | null | undefined): string {
  const d = formatDate(iso);
  return d ? ` on ${d}` : '';
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * When it happened, honestly.
 *
 * A real roll-call date is already in the behaviour sentence. This line covers
 * the rest: a sponsorship, or an action whose only date is the stand-in. The
 * Congress is always known (it is in the bill id), so the reader always gets
 * at least "during the 118th Congress (2023–2024)".
 */
function whenLine(e: DirectedAction, congress: number | null): string | null {
  const proxy = (e.vote_flags ?? []).includes('ACTION_DATE_PROXY');
  const hasRollCall = Boolean(formatDate(e.cloture_vote_date) || formatDate(e.passage_vote_date));
  if (hasRollCall) return null; // the sentence above already carries the date
  const real = !proxy ? formatDate(e.action_date) : null;
  // The record sentence already dates a sponsorship ("… introducing it on
  // March 14, 2025"); saying it again on the next line is noise.
  if (real && e.record?.includes(real)) return null;
  if (real) return `When: ${real}.`;
  if (congress) return `When: during the ${congressLabel(congress)} — the exact date is not in our record.`;
  return null;
}

interface Props {
  action: DirectedAction;
  connector?: string;
  senatorName: string;
  /** Present when feedback can be sent; the card then offers it. */
  feedback?: FeedbackContext;
}

export function EvidenceCard({ action, connector, senatorName, feedback }: Props) {
  const [open, setOpen] = useState(false);
  const relation = STRENGTH_PHRASE[action.strength];
  const governing = governingVoteSentence(action.vote_governing);
  const congress = action.congress ?? congressOfBillId(action.bill_id);
  const when = whenLine(action, congress);
  const versionLines = textVersionLines(action.text_version);
  const disclosures = (action.vote_flags ?? [])
    .map((flag) => ({ flag, copy: VOTE_FLAG_COPY[flag] }))
    // The proxy-date flag is now said in the "When" line, in context. Keeping
    // it here too would say the same thing twice on every sponsorship card.
    .filter((d): d is { flag: string; copy: string } => Boolean(d.copy) && !(d.flag === 'ACTION_DATE_PROXY' && when));

  return (
    <article className="evidence" data-direction={action.direction}>
      <div className="evidence-head">
        <h3 className="evidence-title">{action.title}</h3>
        {action.bill_number ? (
          <span className="evidence-bill">{action.bill_number}</span>
        ) : null}
        <span className="relation">{relation}</span>
      </div>

      {/* Identity line. Bill id and Congress are what a reader needs to look
          the bill up anywhere else; the policy area is the label retrieval
          and the evaluators worked from. */}
      <p className="evidence-meta">
        <span>{action.bill_id}</span>
        {congress ? <span>{congressLabel(congress)}</span> : null}
        {action.primary_issue ? (
          <span>
            {action.primary_issue}
            {action.sub_issue ? ` / ${action.sub_issue}` : ''}
          </span>
        ) : null}
      </p>

      {connector ? <p className="connector">{connector}</p> : null}

      <p className="behaviour">
        <strong>{senatorName}</strong> {describeBehaviour(action)}.{' '}
        {describeEffect(action)}
      </p>

      {when ? <p className="when">{when}</p> : null}

      {/* The record: how and when the senator's name went on the bill, the
          committee path, and what became of it. Built server-side from the
          pipeline's columns, never by a model, so it is rendered as written. */}
      {action.record ? <p className="record">{action.record}</p> : null}
      {/* Said where the history would have been, so a missing "reported by
          committee" is not read as "never reported". */}
      {action.history_unavailable ? <p className="record degraded-note">{HISTORY_UNAVAILABLE_COPY}</p> : null}

      {/* Which version of the bill's text this was judged against, and what
          the bill became. Only bills whose text changed carry text_version;
          for every other bill this renders nothing. */}
      {versionLines.length ? (
        <div className="text-version">
          {versionLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      {/* Which vote decided, in plain language. The raw `vote_governing` string
          is analyst vocabulary — one of its values contains "threshold", a
          banned Level-1 term — so the reader gets a sentence and the trace gets
          the string. */}
      {governing ? <p className="governing">{governing}</p> : null}

      {/* Disclosure flags. A separate channel from scoring flags: these change
          how the row should be READ, so they sit at Level 1 rather than in the
          drill-down. Flags with no reader copy are analyst vocabulary and stay
          in the trace. */}
      {disclosures.length ? (
        <ul className="disclosures">
          {disclosures.map((d) => (
            <li key={d.flag}>{d.copy}</li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        className="details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide the bill' : 'What the bill does'}
      </button>

      {open ? (
        <div className="evidence-more">
          {action.summary ? <p>{action.summary}</p> : null}
          {action.intended_effects ? (
            <p>
              <strong>Intended effects.</strong> {action.intended_effects}
            </p>
          ) : null}
          {action.mechanisms ? (
            <p>
              <strong>How it works.</strong> {action.mechanisms}
            </p>
          ) : null}
          {action.affected_stakeholders ? (
            <p>
              <strong>Who it affects.</strong> {action.affected_stakeholders}
            </p>
          ) : null}
          {action.missing_fields.length ? (
            <p>
              <strong>Note.</strong> Some details for this action weren’t available in our
              record: {action.missing_fields.join(', ')}.
            </p>
          ) : null}
        </div>
      ) : null}

      {action.source_url ? (
        <a
          className="source"
          href={action.source_url}
          target="_blank"
          rel="noreferrer noopener"
        >
          Read the bill on congress.gov →
        </a>
      ) : (
        <p className="evidence-more">
          <strong>No source link available for this action.</strong>
        </p>
      )}
      {feedback ? (
        <FeedbackControl level="evidence" context={feedback} actionUid={action.action_uid} billId={action.bill_id} />
      ) : null}
    </article>
  );
}

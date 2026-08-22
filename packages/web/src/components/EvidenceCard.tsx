import { useState } from 'react';
import { STRENGTH_PHRASE, type DirectedAction } from '@receipts/shared';

// ===========================================================================
// One matched action.
//
// Two rules this component exists to keep:
//   1. Cloture and passage are named separately, never merged into "voted".
//   2. Behaviour is described, motive never is. A senator who sponsored a bill
//      and then didn't vote gets "did not cast a vote", not "avoided the vote"
//      — illness, a family emergency and strategy are indistinguishable here.
// ===========================================================================

const VOTE_WORD: Record<string, string> = { YEA: 'voted yes', NAY: 'voted no' };

function describeBehaviour(e: DirectedAction): string {
  const named = (v: string | undefined) => VOTE_WORD[String(v ?? '').toUpperCase()];

  const parts: string[] = [];
  const cloture = named(e.cloture_vote);
  const passage = named(e.passage_vote);

  if (cloture) parts.push(`${cloture} on ending debate`);
  if (passage) parts.push(`${passage} on final passage`);
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

function describeEffect(e: DirectedAction): string | null {
  if (e.bill_effect === 'ADVANCE') return 'This bill moves that goal forward.';
  if (e.bill_effect === 'HINDER') return 'This bill sets that goal back.';
  return null;
}

interface Props {
  action: DirectedAction;
  connector?: string;
  senatorName: string;
}

export function EvidenceCard({ action, connector, senatorName }: Props) {
  const [open, setOpen] = useState(false);
  const relation = STRENGTH_PHRASE[action.strength];

  return (
    <article className="evidence" data-direction={action.direction}>
      <div className="evidence-head">
        <h3 className="evidence-title">{action.title}</h3>
        {action.bill_number ? (
          <span className="evidence-bill">{action.bill_number}</span>
        ) : null}
        <span className="relation">{relation}</span>
      </div>

      {connector ? <p className="connector">{connector}</p> : null}

      <p className="behaviour">
        <strong>{senatorName}</strong> {describeBehaviour(action)}.{' '}
        {describeEffect(action)}
      </p>

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
    </article>
  );
}

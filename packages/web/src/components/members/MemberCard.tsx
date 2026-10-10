import { CheckIcon } from 'lucide-react';
import type { Member } from '../../data/roster.js';
import { memberArea, memberTitle, partyName } from '../../lib/members.js';
import { MemberPortrait } from './MemberPortrait.js';

interface Props {
  member: Member;
  selected: boolean;
  onSelect: (id: string) => void;
  /** A covered member from the same state, offered when this one is not covered. */
  coveredAlternative?: Member | null;
}

export function MemberCard({ member, selected, onSelect, coveredAlternative }: Props) {
  const area = memberArea(member);
  const party = partyName(member.party);

  const details = (
    <>
      <span className="block text-[15px] leading-snug text-ink-soft">{memberTitle(member)}</span>
      {area ? <span className="block text-[14px] leading-snug text-ink-soft">{area}</span> : null}
      {party ? <span className="mt-0.5 block text-[15px] text-ink-soft">{party}</span> : null}
    </>
  );

  // Not analysed: shown, never selectable. Coverage is the pipeline's to grant.
  if (!member.cached) {
    return (
      <div className="rounded-card border border-dashed border-rule bg-paper p-4" data-covered="false">
        <div className="flex gap-4">
          <MemberPortrait politicianId={member.politician_id} name={member.name} muted />
          <div className="min-w-0">
            <p className="text-[17px] font-semibold leading-snug text-ink">{member.name}</p>
            {details}
          </div>
        </div>
        <p className="mt-3 text-[15px] leading-snug text-ink-soft">
          Not checked yet — we’re still going through {member.name}’s record.
          {coveredAlternative ? ` You can check ${coveredAlternative.name} now.` : ''}
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(member.politician_id)}
      aria-pressed={selected}
      data-covered="true"
      className={`flex w-full items-center gap-4 rounded-card border bg-card p-4 text-left shadow-soft transition-colors duration-150 ${
        selected ? 'border-ink ring-1 ring-ink' : 'border-rule hover:border-ink-faint'
      }`}
    >
      <MemberPortrait politicianId={member.politician_id} name={member.name} />
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] font-semibold leading-snug text-ink">{member.name}</span>
        {details}
      </span>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-ink bg-ink text-paper' : 'border-rule bg-card'
        }`}
        aria-hidden="true"
      >
        {selected ? <CheckIcon className="h-4 w-4" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

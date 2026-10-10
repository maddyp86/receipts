import { CheckIcon } from 'lucide-react';
import type { Member } from '../../data/roster.js';
import { memberTitle, partyName } from '../../lib/members.js';
import { MemberPortrait } from './MemberPortrait.js';

interface Props {
  member: Member;
  /** Omit to show the summary without a way to change it (mid-check). */
  onChange?: () => void;
  compact?: boolean;
}

/** The persistent “Checking: Name · Change” summary. */
export function SelectedMember({ member, onChange, compact = false }: Props) {
  const party = partyName(member.party);

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-card border border-rule bg-card py-2 pl-2 pr-1">
        <MemberPortrait politicianId={member.politician_id} name={member.name} size="sm" />
        <p className="min-w-0 flex-1 text-[16px] leading-snug text-ink">
          <span className="block truncate">
            <span className="text-ink-soft">Checking:</span> <span className="font-semibold">{member.name}</span>
          </span>
          <span className="block truncate text-[14px] text-ink-soft">{memberTitle(member)}</span>
        </p>
        {onChange ? (
          <button
            type="button"
            onClick={onChange}
            className="min-h-[44px] shrink-0 rounded-md px-3 text-[15px] font-medium text-focus underline underline-offset-4"
          >
            Change
          </button>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-card border-2 border-ink bg-card p-4 shadow-soft" role="status">
      <MemberPortrait politicianId={member.politician_id} name={member.name} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[15px] text-ink-soft">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper" aria-hidden="true">
            <CheckIcon className="h-3 w-3" strokeWidth={3} />
          </span>
          Checking
        </p>
        <p className="mt-0.5 text-[19px] font-semibold leading-snug text-ink">{member.name}</p>
        <p className="text-[15px] leading-snug text-ink-soft">
          {memberTitle(member)}
          {party ? ` · ${party}` : ''}
        </p>
      </div>
      {onChange ? (
        <button
          type="button"
          onClick={onChange}
          className="min-h-[44px] shrink-0 self-start rounded-md px-3 text-[16px] font-medium text-focus underline underline-offset-4"
        >
          Change
        </button>
      ) : null}
    </div>
  );
}

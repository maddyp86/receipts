import { useMemo, useState } from 'react';
import { ArrowLeftIcon, ChevronDownIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react';
import type { Member } from '../../data/roster.js';
import { districtCount, memberTitle, stateName } from '../../lib/members.js';
import { GlossaryTerm } from '../glossary/GlossaryTerm.js';
import { MemberCard } from './MemberCard.js';
import { StateCombobox } from './StateCombobox.js';

// ===========================================================================
// Who to check.
//
// Leads with the members that can be checked NOW, because that is the list a
// voter can act on. Finding by state or by name comes second and is honest
// about gaps: a state we have nobody from says so, and a member we know about
// but have not analysed is shown as not checked yet, never as selectable.
// ===========================================================================

const FIND_DISTRICT_URL = 'https://www.house.gov/representatives/find-your-representative';

/** Up to this many covered members are shown as cards; past it, as state shortcuts. */
const GRID_LIMIT = 8;

type FindMode = 'state' | 'name';

interface Props {
  members: Member[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function MemberPicker({ members, selectedId, onSelect }: Props) {
  const [mode, setMode] = useState<FindMode>('state');
  const [stateCode, setStateCode] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState('');

  const covered = useMemo(() => members.filter((m) => m.cached), [members]);
  const upcoming = useMemo(() => members.filter((m) => !m.cached), [members]);
  const coveredCountByState = useMemo(
    () =>
      covered.reduce<Record<string, number>>((acc, m) => {
        if (m.state) acc[m.state] = (acc[m.state] ?? 0) + 1;
        return acc;
      }, {}),
    [covered],
  );
  const coveredStates = Object.keys(coveredCountByState).sort((a, b) => stateName(a).localeCompare(stateName(b)));

  const q = nameQuery.trim().toLowerCase();
  const nameMatches = q
    ? members.filter((m) => `${m.name} ${stateName(m.state)}`.toLowerCase().includes(q))
    : [];

  return (
    <div>
      {/* 1. What can be checked now. */}
      {covered.length === 0 ? (
        <p className="rounded-card border border-dashed border-rule bg-paper p-4 text-[16px] text-ink-soft">
          We couldn’t load the list of members just now. Try refreshing the page.
        </p>
      ) : covered.length <= GRID_LIMIT ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {covered.map((m) => (
            <MemberCard key={m.politician_id} member={m} selected={m.politician_id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        <div>
          <p className="text-[16px] text-ink-soft">
            We’ve checked {covered.length} members of Congress so far. Jump to one of their states:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {coveredStates.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setMode('state');
                  setStateCode(code);
                }}
                className="min-h-[44px] whitespace-nowrap rounded-full border border-rule bg-card px-4 text-[16px] text-ink transition-colors duration-150 hover:border-ink-faint"
              >
                {stateName(code)} <span className="text-ink-soft">· {coveredCountByState[code]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2. Who is coming. Names only, so the list reads as a queue, not as choices. */}
      {upcoming.length ? (
        <details className="group mt-5 rounded-card border border-rule bg-card">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 px-4 text-[16px] text-ink [&::-webkit-details-marker]:hidden">
            <span>
              <span className="font-medium">Being added next</span>{' '}
              <span className="text-ink-soft">
                · {upcoming.length} more {upcoming.length === 1 ? 'member' : 'members'}
              </span>
            </span>
            <ChevronDownIcon
              className="h-5 w-5 shrink-0 text-ink-soft transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="border-t border-rule px-4 pb-4 pt-3">
            <p className="text-[15px] leading-snug text-ink-soft">
              We’re going through these records now. You can’t check them yet — they’ll appear above as each one is
              finished.
            </p>
            <ul className="mt-3 divide-y divide-rule">
              {upcoming.map((m) => (
                <li key={m.politician_id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2.5">
                  <span className="text-[16px] font-medium text-ink">{m.name}</span>
                  <span className="text-[14px] text-ink-soft">
                    {memberTitle(m)}
                    {m.on_ballot_2026 ? ' · on the ballot this November' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}

      {/* 3. Find someone specific. */}
      <div className="mt-8">
        <p className="text-[16px] text-ink-soft">Looking for someone else? Find them by state or by name.</p>
        <div
          role="tablist"
          aria-label="How to find who represents you"
          className="mt-3 grid grid-cols-2 rounded-card border border-rule bg-cantsay-wash p-1"
        >
          {(['state', 'name'] as FindMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-[44px] rounded-lg text-[16px] font-medium transition-colors duration-150 ${
                mode === m ? 'bg-card text-ink shadow-soft' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {m === 'state' ? 'By state' : 'By name'}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {mode === 'state' && !stateCode ? (
            <StateCombobox onPick={setStateCode} coveredCountByState={coveredCountByState} />
          ) : null}

          {mode === 'state' && stateCode ? (
            <StateView
              key={stateCode}
              stateCode={stateCode}
              members={members.filter((m) => m.state === stateCode)}
              selectedId={selectedId}
              onSelect={onSelect}
              onBack={() => setStateCode(null)}
              coveredStates={coveredStates}
              onPickState={setStateCode}
            />
          ) : null}

          {mode === 'name' ? (
            <div>
              <label htmlFor="name-input" className="sr-only">
                Name of a senator or representative
              </label>
              <div className="flex items-center rounded-card border border-rule bg-card shadow-soft focus-within:border-focus focus-within:ring-1 focus-within:ring-focus">
                <SearchIcon className="ml-4 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
                <input
                  id="name-input"
                  value={nameQuery}
                  onChange={(e) => setNameQuery(e.target.value)}
                  placeholder="Type a last name"
                  autoComplete="off"
                  className="min-h-[56px] w-full bg-transparent px-3 text-[17px] text-ink placeholder:text-ink-soft focus:outline-none"
                />
              </div>
              <p className="mt-2 text-[15px] text-ink-soft">Searches senators and House members.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2" aria-live="polite">
                {nameMatches.map((m) => (
                  <MemberCard
                    key={m.politician_id}
                    member={m}
                    selected={m.politician_id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
              {q && nameMatches.length === 0 ? (
                <p className="mt-2 text-[16px] text-ink-soft">
                  We haven’t added anyone by that name yet. More members are being added.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface StateViewProps {
  stateCode: string;
  members: Member[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  coveredStates: string[];
  onPickState: (code: string) => void;
}

function StateView({ stateCode, members, selectedId, onSelect, onBack, coveredStates, onPickState }: StateViewProps) {
  const [district, setDistrict] = useState<number | null>(null);
  const totalDistricts = districtCount(stateCode);
  const atLarge = totalDistricts === 1;
  const senators = members.filter((m) => m.chamber === 'senate');
  const reps = members.filter((m) => m.chamber === 'house');
  const rep = atLarge ? reps[0] : reps.find((r) => r.district === district);
  const coveredHere = members.find((m) => m.cached) ?? null;
  const altFor = (m: Member) => (coveredHere && coveredHere.politician_id !== m.politician_id ? coveredHere : null);
  const name = stateName(stateCode);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[17px] text-ink">
          Who represents <span className="font-semibold">{name}</span>
        </p>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[15px] font-medium text-focus"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          Different state
        </button>
      </div>

      {members.length === 0 ? (
        <div className="mt-3 rounded-card border border-dashed border-rule bg-paper p-5">
          <p className="text-[17px] text-ink">
            We haven’t added anyone from {name} in the Senate or the House yet. More members are being added.
          </p>
          {coveredStates.length ? (
            <>
              <p className="mt-5 text-[15px] text-ink-soft">States we can check now:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {coveredStates.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => onPickState(code)}
                    className="min-h-[44px] rounded-full border border-rule bg-card px-4 text-[15px] text-ink transition-colors duration-150 hover:border-ink-faint"
                  >
                    {stateName(code)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <section className="mt-5" aria-labelledby="senators-heading">
            <h3 id="senators-heading" className="text-[16px] font-semibold text-ink">
              In the <GlossaryTerm id="senate">Senate</GlossaryTerm>
              <span className="ml-2 font-normal text-ink-soft">· whole state</span>
            </h3>
            {senators.length ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {senators.map((m) => (
                  <MemberCard
                    key={m.politician_id}
                    member={m}
                    selected={m.politician_id === selectedId}
                    onSelect={onSelect}
                    coveredAlternative={altFor(m)}
                  />
                ))}
              </div>
            ) : null}
            {senators.length < 2 ? (
              <p className="mt-3 text-[15px] text-ink-soft">
                Every state has 2 senators.{' '}
                {senators.length === 0
                  ? `We haven’t added either of ${name}’s yet.`
                  : `We haven’t added ${name}’s other senator yet.`}
              </p>
            ) : null}
          </section>

          <section className="mt-8" aria-labelledby="house-heading">
            <h3 id="house-heading" className="text-[16px] font-semibold text-ink">
              In the <GlossaryTerm id="house">House</GlossaryTerm>
            </h3>

            {reps.length === 0 ? (
              <p className="mt-2 text-[15px] text-ink-soft">We haven’t added any House members from {name} yet.</p>
            ) : atLarge ? (
              <p className="mt-1 text-[15px] text-ink-soft">{name} has one district — the whole state.</p>
            ) : (
              <div className="mt-3">
                <label htmlFor="district-select" className="block text-[15px] text-ink-soft">
                  It depends on your <GlossaryTerm id="district">district</GlossaryTerm>. {name} has {totalDistricts}.
                </label>
                <select
                  id="district-select"
                  value={district ?? ''}
                  onChange={(e) => setDistrict(e.target.value ? Number(e.target.value) : null)}
                  className="mt-2 min-h-[56px] w-full rounded-card border border-rule bg-card px-4 text-[17px] text-ink shadow-soft focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                >
                  <option value="">Pick your district</option>
                  {Array.from({ length: totalDistricts }, (_, i) => i + 1).map((d) => {
                    const known = reps.find((r) => r.district === d);
                    return (
                      <option key={d} value={d}>
                        District {d}
                        {known?.area ? ` — ${known.area}` : ''}
                      </option>
                    );
                  })}
                </select>
                <a
                  href={FIND_DISTRICT_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-[15px] font-medium text-focus underline underline-offset-4"
                >
                  Not sure? Find your district on house.gov
                  <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
            )}

            {reps.length ? (
              <div className="mt-3">
                {rep ? (
                  <MemberCard
                    member={rep}
                    selected={rep.politician_id === selectedId}
                    onSelect={onSelect}
                    coveredAlternative={altFor(rep)}
                  />
                ) : district ? (
                  <p className="rounded-card border border-dashed border-rule bg-paper p-4 text-[16px] text-ink">
                    We haven’t added District {district}’s representative yet. More members are being added.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

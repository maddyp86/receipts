import pg from 'pg';
import type { DirectoryMember } from '@receipts/shared';
import { config } from '../config.js';

// ===========================================================================
// Every serving member of Congress, for finding them by state or by name.
//
// The picker used to list only checked members plus a hand-kept roster, so a
// reader could not find most of Congress. With funding, anyone not checked
// yet is someone a reader can pay to have added, so all of them are listed.
//
// LISTING IS NOT COVERAGE. `cached` here comes from senatorCache's rule
// (live AND actions loaded), not from core.members.live alone, so nothing in
// this list can be checked unless /api/senators would offer it.
//
// Read from core.members (receipts_app has SELECT on core). Serving means
// left_at is null. Re-read at most every ten minutes; a failed read keeps the
// last good list, and with none the list is empty and the web falls back to
// its own roster.
// ===========================================================================

const { Pool } = pg;

export interface MemberRow {
  member_id: string;
  full_name: string;
  chamber: string;
  state: string | null;
  district: string | null;
  party: string | null;
}

export const DIRECTORY_SQL = `
  select member_id, full_name, chamber, state, district, party
    from core.members
   where left_at is null and chamber in ('Senate', 'House')`;

const PARTY: Record<string, DirectoryMember['party']> = { democrat: 'D', republican: 'R', independent: 'I' };

/** One row as the picker shows it, before coverage is applied. Null for an unusable row. */
export function toDirectoryMember(r: MemberRow): Omit<DirectoryMember, 'cached'> | null {
  const id = (r.member_id ?? '').trim();
  const name = (r.full_name ?? '').trim();
  const chamber = r.chamber === 'Senate' ? 'senate' : r.chamber === 'House' ? 'house' : null;
  if (!id || !name || !chamber) return null;
  const party = PARTY[(r.party ?? '').trim().toLowerCase()];
  const state = (r.state ?? '').trim().toUpperCase();
  // 'AL', '0' and blank are at-large: no district number.
  const district = chamber === 'house' ? Number.parseInt(String(r.district ?? ''), 10) : NaN;
  return {
    politician_id: id,
    name,
    chamber,
    ...(party ? { party } : {}),
    ...(state ? { state } : {}),
    ...(Number.isFinite(district) && district > 0 ? { district } : {}),
  };
}

export type LoadMembers = () => Promise<MemberRow[]>;

export class MemberDirectory {
  private all: Omit<DirectoryMember, 'cached'>[] | null = null;
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly load: LoadMembers | null,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Everyone serving, with `cached` set for the ids that are covered. */
  async list(coveredIds: ReadonlySet<string>): Promise<DirectoryMember[]> {
    return (await this.current()).map((m) => ({ ...m, cached: coveredIds.has(m.politician_id) }));
  }

  /** One serving member by id, or undefined. */
  async get(memberId: string): Promise<Omit<DirectoryMember, 'cached'> | undefined> {
    return (await this.current()).find((m) => m.politician_id === memberId);
  }

  private async current(): Promise<Omit<DirectoryMember, 'cached'>[]> {
    if (!this.load) return [];
    if (!this.all || this.now() - this.loadedAt >= this.ttlMs) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      if (!this.all) await this.inflight;
    }
    return this.all ?? [];
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await this.load!();
      this.all = rows.map(toDirectoryMember).filter((m): m is Omit<DirectoryMember, 'cached'> => m !== null);
    } catch (err) {
      console.error('[members] could not read the member list; keeping the last good one:', err instanceof Error ? err.message : String(err));
    }
    this.loadedAt = this.now();
  }
}

function memberLoader(connectionString: string): LoadMembers {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => console.error('[members] idle client error (non-fatal):', err.message));
  return async () => (await pool.query<MemberRow>(DIRECTORY_SQL)).rows;
}

// Same switch as senatorCache: demo and fixture modes answer only for the
// seed senators, so they list no one else.
export const memberDirectory = new MemberDirectory(
  config.database.url && !config.demoMode && !config.fixtureMode ? memberLoader(config.database.url) : null,
);

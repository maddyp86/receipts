import pg from 'pg';
import { surnameOf, type Senator } from '@receipts/shared';
import { config } from '../config.js';

const { Pool } = pg;

// ===========================================================================
// Who the picker offers, read from the pipeline's own data.
//
// A senator is COVERED when the pipeline marks them `In Scope` in
// mirror.mirror_politicians AND their actions have reached
// mirror.mirror_politician_bill_actions. The flag alone is not enough: it can
// be set before the pipeline has run, and a picker entry with an empty record
// answers every question with "we didn't find anything", which is the tool's
// most dangerous sentence. So a senator added through the pipeline appears
// here once their record has synced, with no code change.
//
// The picker lists covered senators only. The beta note says "the senators
// covered so far are the ones you can pick below", and a pickable senator we
// have not analysed would make that false.
//
// Every other senator in the table still RESOLVES, as uncached: a direct API
// call for one gets the honest "we haven't analysed them" stop and is queued
// as demand (ADR-004), exactly as before.
//
// Re-read at most every few minutes. A failed read keeps the last good list;
// with none, it falls back to SEED and says so in the log. SEED is also the
// list with no database (demo, fixtures, tests), where the fixtures exist only
// for these two.
// ===========================================================================

/**
 * The fallback, and the demo/fixture list. Not the source of truth. The
 * uncached five are never listed; they resolve, so the "not analysed yet" stop
 * still works without a database.
 */
export const SEED: readonly Senator[] = [
  { politician_id: 'S000148', name: 'Chuck Schumer', cached: true, party: 'D', state: 'NY' },
  { politician_id: 'T000250', name: 'John Thune', cached: true, party: 'R', state: 'SD' },
  { politician_id: 'W000817', name: 'Elizabeth Warren', cached: false, party: 'D', state: 'MA' },
  { politician_id: 'C001098', name: 'Ted Cruz', cached: false, party: 'R', state: 'TX' },
  { politician_id: 'S000033', name: 'Bernie Sanders', cached: false, party: 'I', state: 'VT' },
  { politician_id: 'M000355', name: 'Mitch McConnell', cached: false, party: 'R', state: 'KY' },
  { politician_id: 'K000377', name: 'Mark Kelly', cached: false, party: 'D', state: 'AZ' },
];

export interface PoliticianRow {
  politician_id: string;
  name: string | null;
  party: string | null;
  state: string | null;
  covered: boolean;
  /** Recorded actions in the mirror: the record the search ranks. */
  actions?: number | null;
}

export type LoadPoliticians = () => Promise<PoliticianRow[]>;

const SQL = `
  select p.politician_id,
         coalesce(nullif(p.row->>'Full Name', ''), p.full_name) as name,
         p.row->>'Party' as party,
         p.row->>'State' as state,
         coalesce(lower(p.row->>'In Scope') = 'true', false) and coalesce(a.n, 0) > 0 as covered,
         coalesce(a.n, 0)::int as actions
    from mirror.mirror_politicians p
    left join (select politician_id, count(*) as n
                 from mirror.mirror_politician_bill_actions
                group by politician_id) a on a.politician_id = p.politician_id
   where p.row->>'Chamber' = 'Senate'`;

const PARTY: Record<string, Senator['party']> = { democrat: 'D', republican: 'R', independent: 'I' };

/** One mirror row as the picker shows it. */
export function toSenator(r: PoliticianRow): Senator | null {
  const id = (r.politician_id ?? '').trim();
  const name = (r.name ?? '').trim();
  if (!id || !name) return null;
  const party = PARTY[(r.party ?? '').trim().toLowerCase()];
  const state = (r.state ?? '').trim();
  const actions = Number(r.actions);
  return {
    politician_id: id,
    name,
    cached: Boolean(r.covered),
    ...(party ? { party } : {}),
    ...(state ? { state } : {}),
    ...(r.covered && Number.isFinite(actions) && actions > 0 ? { record_actions: actions } : {}),
  };
}

/** By surname, then full name: a stable order that does not favour anyone. */
const bySurname = (a: Senator, b: Senator) =>
  surnameOf(a.name).localeCompare(surnameOf(b.name)) || a.name.localeCompare(b.name);

export class SenatorCache {
  private all: Senator[] | null = null;
  private fromMirror = false;
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly load: LoadPoliticians | null,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The picker: covered senators only. */
  async list(): Promise<Senator[]> {
    return (await this.current()).filter((s) => s.cached);
  }

  /** Any senator in the table; uncached unless covered. */
  async resolve(politicianId: string): Promise<Senator | undefined> {
    const id = politicianId.trim();
    return (await this.current()).find((s) => s.politician_id === id);
  }

  private async current(): Promise<Senator[]> {
    if (!this.load) return [...SEED];
    if (!this.all || this.now() - this.loadedAt >= this.ttlMs) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      // Wait only when there is nothing to serve; otherwise serve the last
      // good list while the re-read runs.
      if (!this.all) await this.inflight;
    }
    return this.all ?? [...SEED];
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await this.load!();
      const senators = rows.map(toSenator).filter((s): s is Senator => s !== null).sort(bySurname);
      if (!senators.some((s) => s.cached)) {
        // An empty picker is never right for the beta. Keep what we had.
        throw new Error(`no covered senator among ${senators.length} rows`);
      }
      this.all = senators;
      this.fromMirror = true;
    } catch (err) {
      console.error(
        `[senators] could not read coverage from the mirror; ${this.fromMirror ? 'keeping the last good list' : 'using the seed list'}:`,
        err instanceof Error ? err.message : String(err),
      );
      this.all ??= [...SEED];
    }
    // A failure also waits out the TTL, so a broken read is not retried on
    // every request.
    this.loadedAt = this.now();
  }
}

function mirrorLoader(connectionString: string): LoadPoliticians {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => console.error('[senators] idle client error (non-fatal):', err.message));
  return async () => (await pool.query<PoliticianRow>(SQL)).rows;
}

// Demo and fixture answers exist only for the seed senators, so those modes
// keep the seed list even with a database configured.
export const senatorCache = new SenatorCache(
  config.database.url && !config.demoMode && !config.fixtureMode ? mirrorLoader(config.database.url) : null,
);

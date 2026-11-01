import pg from 'pg';
import { CLIENT_FUNNEL_EVENTS, FUNNEL_EVENTS, type FunnelEvent, type FunnelProps } from '@receipts/shared';

// ===========================================================================
// Funnel counts — which steps of a visit happened, never what was asked.
//
// One row per step (landed, started, saw an answer, asked a follow-up), tied
// to the per-tab session id and nothing else: no question text, no IP, no
// user agent. Write-only, like feedback: the app is granted INSERT on
// app.app_funnel_events and nothing more (migration 025), and the funnel is
// read as postgres (docs/queries/activation.sql).
//
// The validator is the privacy boundary. Every property is checked against a
// closed shape — ids by pattern, enums by list, counts by range — and
// anything else is DROPPED, not stored. There is no field a question's text
// could ride in on, and a client that sends one loses it here.
// ===========================================================================

const { Pool } = pg;

export interface FunnelRow {
  session_key: string;
  event: FunnelEvent;
  props: FunnelProps;
}

const SESSION_RE = /^[0-9a-f-]{32,36}$/i;
const MEMBER_RE = /^[A-Z]\d{6}$/;
/** A verdict, a record label, or ND_<reason>: upper-case words only. */
const OUTCOME_RE = /^[A-Z_]{2,48}$/;

/** Keep only the properties we allow, in the shapes we allow. Pure, for the test. */
export function cleanProps(raw: unknown): FunnelProps {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: FunnelProps = {};
  if (typeof p.politician_id === 'string' && MEMBER_RE.test(p.politician_id)) out.politician_id = p.politician_id;
  if (p.source === 'starter' || p.source === 'typed') out.source = p.source;
  if (typeof p.nth === 'number' && Number.isInteger(p.nth) && p.nth >= 1 && p.nth <= 1000) out.nth = p.nth;
  if (typeof p.outcome === 'string' && OUTCOME_RE.test(p.outcome)) out.outcome = p.outcome;
  return out;
}

/**
 * Check an event sent by the page. `followup_asked` is refused here: the
 * server records it itself, inside /api/followup, so it cannot be inflated
 * from outside or lost by a dropped request.
 */
export function validateClientEvent(body: unknown): { ok: true; row: FunnelRow } | { ok: false; message: string } {
  const b = (body ?? {}) as { session?: unknown; event?: unknown; props?: unknown };
  const session_key = typeof b.session === 'string' ? b.session.trim() : '';
  if (!SESSION_RE.test(session_key)) return { ok: false, message: 'session must be the tab’s session id.' };
  const event = b.event as FunnelEvent;
  if (!CLIENT_FUNNEL_EVENTS.includes(event)) {
    return { ok: false, message: `event must be one of ${CLIENT_FUNNEL_EVENTS.join(', ')}.` };
  }
  return { ok: true, row: { session_key, event, props: cleanProps(b.props) } };
}

/** The server's own follow-up count, or null when there is no usable session id. */
export function followupRow(session: unknown): FunnelRow | null {
  const session_key = typeof session === 'string' ? session.trim() : '';
  if (!SESSION_RE.test(session_key)) return null;
  // No run id: it would join this count to the question (DECISIONS 2026-08-22).
  return { session_key, event: 'followup_asked', props: {} };
}

export interface FunnelStore {
  readonly kind: 'supabase' | 'null';
  /** Store one row. Never throws: a lost count is logged, not surfaced. */
  add(row: FunnelRow): Promise<void>;
}

/** No database, or the flag off: counts go nowhere, and nothing pretends otherwise. */
export const nullFunnelStore: FunnelStore = {
  kind: 'null',
  async add() {},
};

export class SupabaseFunnelStore implements FunnelStore {
  readonly kind = 'supabase' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => console.error('[funnel] idle client error:', err.message));
  }

  async add(row: FunnelRow): Promise<void> {
    if (!FUNNEL_EVENTS.includes(row.event)) return;
    try {
      await this.pool.query(
        'insert into app.app_funnel_events (session_key, event, props) values ($1, $2, $3::jsonb)',
        [row.session_key, row.event, JSON.stringify(row.props)],
      );
    } catch (err) {
      console.error('[funnel] could not store an event:', (err as Error).message);
    }
  }
}

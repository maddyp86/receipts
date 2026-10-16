import pg from 'pg';

// ===========================================================================
// Where funding is kept (migration 018).
//
// The app may INSERT a funding row and read back only the columns the
// "Funded — live by …" label needs. Email and the credit name go in and are
// never read by the app: they are for an operator, as postgres.
// ===========================================================================

const { Pool } = pg;

/** What checkout needs to know about a member before taking money for them. */
export interface FundableMember {
  member_id: string;
  full_name: string;
  chamber: 'Senate' | 'House';
  live: boolean;
  /** Set when the member has left office. */
  left_at: string | null;
}

export interface FundingRow {
  member_id: string;
  stripe_session_id: string;
  amount_cents: number;
  currency: string;
  email: string | null;
  display_name: string | null;
  refund_due_at: Date;
}

/** One open (paid, not yet live or refunded) funding row, as the label needs it. */
export interface OpenFunding {
  member_id: string;
  refund_due_at: Date;
}

export interface FundingStore {
  member(memberId: string): Promise<FundableMember | null>;
  /** Paid and not yet live or refunded, one per member (the earliest). */
  open(): Promise<OpenFunding[]>;
  /** Idempotent on stripe_session_id: true when this call wrote the row. */
  record(row: FundingRow): Promise<boolean>;
  /**
   * Names to credit publicly: only rows the operator has set 'live' (and so
   * looked at), with a name the payer chose to give. Migration 019.
   */
  credits(): Promise<FunderCredit[]>;
}

export interface FunderCredit {
  member_id: string;
  name: string;
}

export class SupabaseFundingStore implements FundingStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => console.error('[funding] idle client error:', err.message));
  }

  async member(memberId: string): Promise<FundableMember | null> {
    const { rows } = await this.pool.query<FundableMember>(
      `select member_id, full_name, chamber, live, left_at::text as left_at
         from core.members where member_id = $1`,
      [memberId],
    );
    return rows[0] ?? null;
  }

  async open(): Promise<OpenFunding[]> {
    const { rows } = await this.pool.query<OpenFunding>(
      `select member_id, min(refund_due_at) as refund_due_at
         from app.member_funding
        where status in ('paid', 'processing')
        group by member_id`,
    );
    return rows;
  }

  async credits(): Promise<FunderCredit[]> {
    const { rows } = await this.pool.query<FunderCredit>(
      `select member_id, display_name as name
         from app.member_funding
        where status = 'live' and display_name is not null and btrim(display_name) <> ''
        order by live_at nulls last, paid_at`,
    );
    return rows;
  }

  async record(r: FundingRow): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `insert into app.member_funding
         (member_id, stripe_session_id, amount_cents, currency, email, display_name, refund_due_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (stripe_session_id) do nothing`,
      [r.member_id, r.stripe_session_id, r.amount_cents, r.currency, r.email, r.display_name, r.refund_due_at],
    );
    return (rowCount ?? 0) > 0;
  }
}

/** In memory, for tests. */
export class MemoryFundingStore implements FundingStore {
  readonly rows: FundingRow[] = [];
  /** Stands in for rows an operator has set 'live'. */
  readonly live: FunderCredit[] = [];
  constructor(private readonly members: FundableMember[] = []) {}

  async member(memberId: string): Promise<FundableMember | null> {
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  async open(): Promise<OpenFunding[]> {
    const byMember = new Map<string, Date>();
    for (const r of this.rows) {
      const cur = byMember.get(r.member_id);
      if (!cur || r.refund_due_at < cur) byMember.set(r.member_id, r.refund_due_at);
    }
    return [...byMember].map(([member_id, refund_due_at]) => ({ member_id, refund_due_at }));
  }

  async credits(): Promise<FunderCredit[]> {
    return [...this.live];
  }

  async record(r: FundingRow): Promise<boolean> {
    if (this.rows.some((x) => x.stripe_session_id === r.stripe_session_id)) return false;
    this.rows.push(r);
    return true;
  }
}

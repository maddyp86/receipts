import pg from 'pg';
import {
  FEEDBACK_KINDS,
  FEEDBACK_PROMPT_KINDS,
  type FeedbackKind,
  type FeedbackLevel,
  type FeedbackRequest,
} from '@receipts/shared';

// ===========================================================================
// Reader feedback — "something looks wrong" — stored for an operator's review.
//
// WRITE-ONLY, BY CONSTRUCTION. This store has one method, `add`, and the
// database grants the app INSERT on app.app_feedback and nothing else
// (migration 012). There is no read here and no privilege for one, so
// feedback cannot reach a verdict through any path the app has: it is for a
// person to read, as postgres, and act on by changing the data or the code.
// ===========================================================================

const { Pool } = pg;

/** A validated row, ready to store. */
export interface FeedbackRow {
  run_id: string;
  kind: FeedbackKind;
  level: FeedbackLevel;
  politician_id: string;
  promise_text: string;
  verdict_shown: string;
  action_uid: string | null;
  bill_id: string | null;
  comment: string | null;
}

export const FEEDBACK_COMMENT_MAX = 1000;

const S = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Every kind the endpoint accepts: "what looks wrong", and the answers to the two prompts. */
export const ACCEPTED_KINDS: readonly FeedbackKind[] = [
  ...FEEDBACK_KINDS.result,
  ...FEEDBACK_KINDS.evidence,
  ...FEEDBACK_PROMPT_KINDS.result,
  ...FEEDBACK_PROMPT_KINDS.evidence,
];
const EVIDENCE_KINDS: readonly string[] = [...FEEDBACK_KINDS.evidence, ...FEEDBACK_PROMPT_KINDS.evidence];
const levelOf = (kind: FeedbackKind): FeedbackLevel => (EVIDENCE_KINDS.includes(kind) ? 'evidence' : 'result');

/**
 * Check a request and shape it into a row, or say what is wrong. Mirrors the
 * table's constraints so a bad request is refused here with a reason, not by
 * the database with an error.
 */
export function validateFeedback(body: unknown): { ok: true; row: FeedbackRow } | { ok: false; message: string } {
  const b = (body ?? {}) as Partial<Record<keyof FeedbackRequest, unknown>>;
  const kind = S(b.kind) as FeedbackKind;
  if (!ACCEPTED_KINDS.includes(kind)) {
    return { ok: false, message: `kind must be one of ${ACCEPTED_KINDS.join(', ')}.` };
  }
  const run_id = S(b.run_id);
  if (!/^[0-9a-f-]{36}$/i.test(run_id)) return { ok: false, message: 'run_id must be the trace id of the answer.' };
  const politician_id = S(b.politician_id);
  if (!/^[A-Z]\d{6}$/.test(politician_id)) return { ok: false, message: 'politician_id is not a senator id.' };
  const promise_text = S(b.promise_text);
  if (!promise_text || promise_text.length > 2000) return { ok: false, message: 'promise_text is required (2,000 characters at most).' };
  const verdict_shown = S(b.verdict_shown);
  if (!verdict_shown || verdict_shown.length > 64) return { ok: false, message: 'verdict_shown is required.' };
  const comment = S(b.comment);
  if (comment.length > FEEDBACK_COMMENT_MAX) return { ok: false, message: `The comment can be at most ${FEEDBACK_COMMENT_MAX} characters.` };

  const level = levelOf(kind);
  const action_uid = S(b.action_uid);
  const bill_id = S(b.bill_id);
  if (level === 'evidence' && (!action_uid || !bill_id)) {
    return { ok: false, message: 'Feedback about a bill must say which bill (action_uid and bill_id).' };
  }
  if (level === 'result' && (action_uid || bill_id)) {
    return { ok: false, message: 'Feedback about the whole answer must not name a bill.' };
  }
  return {
    ok: true,
    row: {
      run_id, kind, level, politician_id, promise_text, verdict_shown,
      action_uid: action_uid || null, bill_id: bill_id || null, comment: comment || null,
    },
  };
}

export interface FeedbackStore {
  readonly kind: 'supabase' | 'null';
  /** Store one row. Throws when it could not be stored; the caller says so. */
  add(row: FeedbackRow): Promise<void>;
  /**
   * Whether the table accepts the two prompts' answers (migration 013). The
   * prompts are offered only when it does, so turning the flag on before the
   * migration hides them instead of failing every answer.
   */
  promptsAccepted(): Promise<boolean>;
}

/** Every kind the two prompts send. All must be allowed. */
const PROMPT_KINDS: readonly string[] = [...FEEDBACK_PROMPT_KINDS.result, ...FEEDBACK_PROMPT_KINDS.evidence];

/** True when this kind CHECK constraint allows every prompt kind. Pure, for the test. */
export function constraintAcceptsPrompts(definitions: readonly string[]): boolean {
  const kindCheck = definitions.find((d) => /\bkind\b/.test(d) && d.includes('QUESTION_MISREAD'));
  return Boolean(kindCheck) && PROMPT_KINDS.every((k) => kindCheck!.includes(`'${k}'`));
}

/** No database: feedback cannot be kept, and the endpoint says so rather than pretending. */
export const nullFeedbackStore: FeedbackStore = {
  kind: 'null',
  async add() {
    throw new Error('Feedback cannot be stored: no database is configured.');
  },
  async promptsAccepted() {
    return false;
  },
};

export class SupabaseFeedbackStore implements FeedbackStore {
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
    this.pool.on('error', (err) => console.error('[feedback] idle client error:', err.message));
  }

  private accepted: { value: boolean; at: number } | null = null;

  /**
   * Read from the catalog, not assumed: whether migration 013 has been run.
   * Re-read every five minutes, so running it takes effect without a deploy.
   * A failed read is "no" — offering prompts that cannot be stored is worse
   * than not offering them.
   */
  async promptsAccepted(): Promise<boolean> {
    if (this.accepted && Date.now() - this.accepted.at < 5 * 60_000) return this.accepted.value;
    let value = false;
    try {
      const { rows } = await this.pool.query<{ def: string }>(
        `select pg_get_constraintdef(con.oid) as def
           from pg_constraint con
           join pg_class cls on cls.oid = con.conrelid
           join pg_namespace n on n.oid = cls.relnamespace
          where n.nspname = 'app' and cls.relname = 'app_feedback' and con.contype = 'c'`,
      );
      value = constraintAcceptsPrompts(rows.map((r) => r.def));
      if (!value) console.warn('[feedback] prompts are switched on but migration 013 has not been run; not offering them.');
    } catch (err) {
      console.error('[feedback] could not read whether the prompts are accepted:', err instanceof Error ? err.message : String(err));
    }
    this.accepted = { value, at: Date.now() };
    return value;
  }

  async add(r: FeedbackRow): Promise<void> {
    await this.pool.query(
      `insert into app.app_feedback
         (run_id, kind, level, politician_id, promise_text, verdict_shown, action_uid, bill_id, comment)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.run_id, r.kind, r.level, r.politician_id, r.promise_text, r.verdict_shown, r.action_uid, r.bill_id, r.comment],
    );
  }
}

import { billCitation, type NoteEvent, type StepId } from '@receipts/shared';

// ===========================================================================
// Narration: what the reader sees happening while the answer is worked out.
//
// Every line here is built in code from what the pipeline DECIDED — a bill
// admitted or set aside, which text was read, which way a bill pushes — and
// never from a model's raw reasoning, which is written for the pipeline and
// carries its vocabulary. A note never states a verdict: the verdict is
// decided after every bill is read, and a second read can still hold it back.
// ===========================================================================

export type Narrate = (note: Omit<NoteEvent, 'type'>) => void;

const TITLE_MAX = 70;

/** "S. 1071 — Disinterment of …". The id when it can't be cited, the title shortened. */
export function billName(billId: string, title?: string | null): string {
  const cite = billCitation(billId) ?? billId;
  const t = String(title ?? '').trim();
  if (!t) return cite;
  return `${cite} — ${t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t}`;
}

/** The citation alone, for the second half of a line the title already opened. */
const cite = (billId: string) => billCitation(billId) ?? billId;

export function retrievedNote(count: number): Omit<NoteEvent, 'type'> {
  return {
    step: 'search',
    key: 'retrieved',
    status: 'done',
    text:
      count === 0
        ? 'Nothing in the record came close to this topic'
        : `Found ${count} ${count === 1 ? 'vote or bill' : 'votes and bills'} that come up for this topic`,
  };
}

export function relevanceStartNote(actionUid: string, billId: string, title: string): Omit<NoteEvent, 'type'> {
  return { step: 'search', key: `rel:${actionUid}`, group: 'relevance', status: 'running', text: `Is it about this? ${billName(billId, title)}` };
}

const RELEVANCE_COPY: Record<string, string> = {
  TRUE_POSITIVE: 'about this',
  PARTIAL: 'partly about this',
  FALSE_POSITIVE: 'about something else',
  ERROR: 'couldn’t check this one',
};

/**
 * What the relevance check found, as it lands. Whether the row is KEPT is the
 * evidence gate's call, made once every check is in; `admitted` is passed
 * then, and the line is said again with the outcome.
 */
export function relevanceDoneNote(actionUid: string, billId: string, verdict: string, admitted?: boolean): Omit<NoteEvent, 'type'> {
  const found = RELEVANCE_COPY[verdict] ?? RELEVANCE_COPY.ERROR!;
  const status: NoteEvent['status'] = admitted === false ? 'skipped' : 'done';
  const suffix = admitted === undefined ? '' : admitted ? ' — kept' : ' — set aside';
  return {
    step: 'search', key: `rel:${actionUid}`, group: 'relevance', status, text: `${cite(billId)}: ${found}${suffix}`,
    ...(admitted === undefined ? {} : { outcome: admitted ? 'kept' : 'set_aside' }),
  };
}

export function nearMissNote(count: number, step: StepId = 'search'): Omit<NoteEvent, 'type'> {
  return {
    step,
    key: `near-miss:${step}`,
    status: 'done',
    text: `Nothing clearly about this yet — checking ${count} closer ${count === 1 ? 'call' : 'calls'}`,
  };
}

export function enrichmentNote(status: 'running' | 'done', bills: number): Omit<NoteEvent, 'type'> {
  return {
    step: 'score',
    key: 'enrichment',
    status,
    text:
      status === 'running'
        ? 'Looking up vote dates, roles, and how far each bill got'
        : `Looked up vote dates, roles, and how far ${bills === 1 ? 'the bill' : `${bills} bills`} got`,
  };
}

/**
 * A bill with more than one text under the same number, read as it stood when
 * the senator acted. Said only when that version was the one read.
 */
export function textVersionNote(actionUid: string, billId: string, versionType: string | null, date: string | null): Omit<NoteEvent, 'type'> {
  const which = [versionType, date].filter(Boolean).join(', ');
  return {
    step: 'score',
    key: `ver:${actionUid}`,
    group: 'version',
    status: 'done',
    text: `${cite(billId)} changed as it moved — reading the text in front of them when they acted${which ? ` (${which})` : ''}`,
  };
}

/** A row a rule closed before it was read. The first sentence of its reason is reader copy already. */
export function gatedNote(actionUid: string, billId: string, reason: string): Omit<NoteEvent, 'type'> {
  const first = /^(.+?[.!?])(\s|$)/.exec(reason.trim())?.[1] ?? reason.trim();
  return { step: 'score', key: `gate:${actionUid}`, group: 'gated', status: 'skipped', text: `${cite(billId)}: not counted. ${first}` };
}

export function readStartNote(actionUid: string, billId: string, title: string): Omit<NoteEvent, 'type'> {
  return { step: 'score', key: `read:${actionUid}`, group: 'read', status: 'running', text: `Reading ${billName(billId, title)}` };
}

/** Which way the BILL pushes. Not how the senator acted on it, and not a verdict. */
const EFFECT_COPY: Record<string, { text: string; status: NoteEvent['status'] }> = {
  ADVANCE: { text: 'the bill pushes toward this', status: 'done' },
  HINDER: { text: 'the bill pushes against this', status: 'done' },
  NEUTRAL: { text: 'doesn’t move this either way', status: 'done' },
  CONTESTED: { text: 'cuts both ways — parts push each direction', status: 'done' },
  ERROR: { text: 'couldn’t read this one — it won’t be counted', status: 'skipped' },
};

export function readDoneNote(actionUid: string, billId: string, billEffect: string): Omit<NoteEvent, 'type'> {
  const c = EFFECT_COPY[billEffect] ?? EFFECT_COPY.ERROR!;
  return { step: 'score', key: `read:${actionUid}`, group: 'read', status: c.status, text: `${cite(billId)}: ${c.text}` };
}

export function judgeNote(status: 'running' | 'done'): Omit<NoteEvent, 'type'> {
  return {
    step: 'score',
    key: 'judge',
    status,
    text:
      status === 'running'
        ? 'Getting an independent second read on the strongest evidence before we answer'
        : 'Second read done',
  };
}

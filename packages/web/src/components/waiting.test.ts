import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NoteEvent, StepEvent, StepId } from '@receipts/shared';
import { Waiting, readProgress, stageStatuses } from './Waiting.js';
import { Entry } from './Entry.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE WAITING SCREEN'S FOUR STAGES are derived from the server's real steps,
// never from a timer. These are the step sequences the live server emits.
// ===========================================================================

const step = (id: StepId, status: StepEvent['status']): StepEvent => ({ type: 'step', id, label: id, status });
/** The hook keeps one row per step id, the latest status winning. */
const latest = (events: StepEvent[]): StepEvent[] => {
  const out: StepEvent[] = [];
  for (const e of events) {
    const i = out.findIndex((s) => s.id === e.id);
    if (i === -1) out.push(e);
    else out[i] = e;
  }
  return out;
};

describe('stageStatuses', () => {
  it('before anything arrives, the first stage is working', () => {
    expect(stageStatuses([])).toEqual(['working', 'waiting', 'waiting', 'waiting']);
  });

  it('the scope check alone does not finish "reading what you wrote"', () => {
    expect(stageStatuses(latest([step('classify_scope', 'running'), step('classify_scope', 'done')]))).toEqual([
      'working', 'waiting', 'waiting', 'waiting',
    ]);
  });

  it('a finished stage hands straight on to the next, with no gap where nothing is in progress', () => {
    const s = latest([step('classify_scope', 'done'), step('interpret', 'done')]);
    expect(stageStatuses(s)).toEqual(['done', 'working', 'waiting', 'waiting']);
  });

  it('mid-search', () => {
    const s = latest([
      step('classify_scope', 'done'), step('interpret', 'done'), step('resolve_senator', 'done'),
      step('embed', 'done'), step('search', 'running'),
    ]);
    expect(stageStatuses(s)).toEqual(['done', 'working', 'waiting', 'waiting']);
  });

  it('demo mode skips the scope check; the stage still finishes', () => {
    const s = latest([step('interpret', 'done'), step('resolve_senator', 'done'), step('embed', 'done'), step('search', 'done'), step('score', 'running')]);
    expect(stageStatuses(s)).toEqual(['done', 'done', 'working', 'waiting']);
  });

  it('an explanation that was sent back and rewritten ends as done, not as an error', () => {
    const s = latest([
      step('classify_scope', 'done'), step('interpret', 'done'), step('resolve_senator', 'done'), step('embed', 'done'),
      step('search', 'done'), step('score', 'done'), step('explain', 'running'), step('explain', 'error'),
      step('explain', 'running'), step('explain', 'done'),
    ]);
    expect(stageStatuses(s)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('a failed step marks its stage, and nothing after it is shown as working', () => {
    const s = latest([step('classify_scope', 'done'), step('interpret', 'done'), step('resolve_senator', 'done'), step('embed', 'error')]);
    expect(stageStatuses(s)).toEqual(['done', 'error', 'waiting', 'waiting']);
  });
});

// ===========================================================================
// THE PICKER never lets a member the pipeline has not analysed be the
// selection, whatever id it is handed.
// ===========================================================================

describe('the entry screen and coverage', () => {
  const render = (selected: string) =>
    renderToStaticMarkup(
      React.createElement(Entry, {
        senators: [
          { politician_id: 'X000001', name: 'Jane Example', cached: true, party: 'D', state: 'DE', chamber: 'senate' },
          { politician_id: 'X000002', name: 'Pat Sample', cached: false, party: 'R', state: 'DE', chamber: 'house' },
        ],
        selected, promise: 'supports something', busy: false,
        onSelect: () => {}, onPromiseChange: () => {}, onSubmit: () => {},
      }),
    );

  it('a covered member can be the selection', () => {
    const page = render('X000001');
    expect(page).toContain('Checking');
    expect(page).toContain('Check their record');
  });

  it('an uncovered member cannot: the picker is shown and the check is blocked', () => {
    const page = render('X000002');
    expect(page).toContain('Who do you want to check?');
    expect(page).toContain('Pick who to check first');
    expect(page).not.toContain('Check their record');
  });

  it('an uncovered member is listed as coming, not offered as a choice', () => {
    const page = render('');
    expect(page).toContain('Being added next');
    expect(page).toContain('Pat Sample');
    // The only selectable card is the covered member's.
    expect(page.match(/data-covered="true"/g)).toHaveLength(1);
    expect(page).not.toMatch(/data-covered="true"[^>]*>[\s\S]{0,400}Pat Sample/);
  });
});

// ===========================================================================
// THE NARRATION under each stage: what the server says it is doing, as it
// does it. Open under the stage that is working, folded under one that is done.
// ===========================================================================

describe('the narration', () => {
  const note = (key: string, step: StepId, status: NoteEvent['status'], text: string, group?: NoteEvent['group']): NoteEvent =>
    ({ type: 'note', key, step, status, text, ...(group ? { group } : {}) });

  const notes: NoteEvent[] = [
    note('retrieved', 'search', 'done', 'Found 3 votes and bills that come up for this topic'),
    note('rel:A', 'search', 'done', 'S. 1: about this — kept', 'relevance'),
    note('rel:B', 'search', 'skipped', 'S. 2: about something else — set aside', 'relevance'),
    note('read:A', 'score', 'done', 'S. 1: the bill pushes toward this', 'read'),
    note('read:C', 'score', 'running', 'Reading H.R. 3 — A bill', 'read'),
  ];

  it('counts bills read, not bills started', () => {
    expect(readProgress(notes)).toBe('1 of 2 read');
    expect(readProgress(notes.slice(0, 3))).toBeNull();
  });

  it('shows each line under its stage while it works, and folds a finished stage', () => {
    const steps = (['classify_scope', 'interpret', 'resolve_senator', 'embed', 'search'] as StepId[])
      .map((id) => step(id, 'done'))
      .concat(step('score', 'running'));
    const page = renderToStaticMarkup(
      React.createElement(Waiting, {
        member: { politician_id: 'X1', name: 'Jane Example', chamber: 'senate', cached: true },
        promise: 'supports something', steps, notes, interpretation: null,
        onCancel: () => {}, onChange: () => {},
      }),
    );
    expect(page).toContain('Reading H.R. 3 — A bill');
    expect(page).toContain('1 of 2 read');
    // The search is done: its lines are a tap away, not gone.
    expect(page).toContain('What we checked (3)');
    expect(page).toContain('S. 2: about something else — set aside');
  });
});

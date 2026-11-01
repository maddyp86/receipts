import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NoteEvent, StepEvent, StepId } from '@receipts/shared';
import { Waiting, stageStatuses, subtasksFor } from './Waiting.js';
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
    // Picked: a chip in the search field, with a way to change it.
    expect(page).toContain('Change from Jane Example');
    expect(page).toContain('Check their record');
  });

  it('an uncovered member cannot: the picker is shown and the check is blocked', () => {
    const page = render('X000002');
    expect(page).toContain('Who do you want to check?');
    expect(page).toContain('Pick who to check first');
    expect(page).not.toContain('Check their record');
  });

  it('an uncovered member is not offered as a choice, and there is no "coming next" list', () => {
    const page = render('');
    // Readers find (and can fund) anyone by searching or browsing; nobody
    // unchecked is put in front of them, and nothing is preselected.
    expect(page).not.toContain('Being added next');
    expect(page).not.toContain('Pat Sample');
    expect(page).toContain('id="lawmaker"');
    expect(page).toContain('Pick who to check first');
  });
});

// ===========================================================================
// THE NARRATION under each stage: what the server says it is doing, as it
// does it. Open under the stage that is working, folded under one that is done.
// ===========================================================================

describe('the narration', () => {
  const note = (key: string, step: StepId, status: NoteEvent['status'], text: string, extra: Partial<NoteEvent> = {}): NoteEvent =>
    ({ type: 'note', key, step, status, text, ...extra });

  const notes: NoteEvent[] = [
    note('retrieved', 'search', 'done', 'Found 3 votes and bills that come up for this topic'),
    note('rel:A', 'search', 'done', 'S. 1: about this — kept', { group: 'relevance', outcome: 'kept' }),
    note('rel:B', 'search', 'skipped', 'S. 2: about something else — set aside', { group: 'relevance', outcome: 'set_aside' }),
    note('enrichment', 'score', 'done', 'Looked up vote dates, roles, and how far 2 bills got'),
    note('ver:A', 'score', 'done', 'S. 1 changed as it moved — reading the text in front of them', { group: 'version' }),
    note('read:A', 'score', 'done', 'S. 1: the bill pushes toward this', { group: 'read' }),
    note('read:C', 'score', 'running', 'Reading H.R. 3 — A bill', { group: 'read' }),
  ];

  it('one summary line per group, each note kept behind it', () => {
    const search = subtasksFor(notes.filter((n) => n.step === 'search'));
    expect(search.map((t) => t.text)).toEqual(['Found 3 votes and bills that come up for this topic', '1 about this · 1 set aside']);
    expect(search[1]!.items).toHaveLength(2);

    const score = subtasksFor(notes.filter((n) => n.step === 'score'));
    expect(score.map((t) => [t.status, t.text])).toEqual([
      ['done', 'Looked up vote dates, roles, and how far 2 bills got'],
      ['running', 'Reading 1 of 2 bills'],
    ]);
    // A rewritten-text note is about a bill being read, so it sits with them — and is not counted as one.
    expect(score[1]!.items.map((n) => n.key)).toEqual(['ver:A', 'read:A', 'read:C']);
  });

  it('the relevance line waits for the rule before saying what was kept', () => {
    const checking = subtasksFor([
      note('rel:A', 'search', 'done', 'S. 1: about this', { group: 'relevance' }),
      note('rel:B', 'search', 'running', 'Is it about this? S. 2', { group: 'relevance' }),
    ]);
    expect(checking[0]).toMatchObject({ status: 'running', text: 'Checking which are about this · 1 of 2' });
  });

  it('shows the stages and their summary lines, with each bill folded away', () => {
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
    expect(page).toContain('Reading 1 of 2 bills');
    expect(page).toContain('1 about this · 1 set aside');
    expect(page).toContain('See each bill (3)');
    // Behind a closed dropdown, not on the page's surface.
    expect(page).not.toMatch(/<details[^>]*open/);
  });

  it('in the landing page pop-up (framed), only the four big steps: no detail lines, no bills', () => {
    const steps = (['classify_scope', 'interpret', 'resolve_senator', 'embed', 'search'] as StepId[])
      .map((id) => step(id, 'done'))
      .concat(step('score', 'running'));
    const page = renderToStaticMarkup(
      React.createElement(Waiting, {
        member: { politician_id: 'X1', name: 'Jane Example', chamber: 'senate', cached: true },
        promise: 'supports something', steps, notes, interpretation: null, framed: true,
        onCancel: () => {}, onChange: () => {},
      }),
    );
    expect(page).toContain('Reading what you wrote');
    expect(page).toContain('Reading each bill');
    expect(page).not.toContain('Reading 1 of 2 bills');
    expect(page).not.toContain('1 about this · 1 set aside');
    expect(page).not.toContain('See each bill');
    expect(page).not.toContain('Good to know');
  });
});

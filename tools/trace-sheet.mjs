#!/usr/bin/env node
// ===========================================================================
// trace-sheet — render one run's trace as a readable log sheet (markdown).
//
//   npm run trace -- <run_id>                      # from .data/traces (local)
//   npm run trace -- <path/to/run.jsonl>           # a trace file directly
//   npm run trace -- <run_id> --api http://localhost:8787
//   npm run trace -- <run_id> --api https://receipts-65yk.onrender.com
//   npm run trace -- <run_id> --out sheet.md       # write instead of print
//   npm run trace -- <run_id> --full               # untruncated payloads
//   npm run trace -- <run_id> --json               # the raw record, pretty
//
// No dependencies. Reads a JSONL file, a run id in TRACE_DIR, or the
// /api/trace/:run_id endpoint of a running server (which reads Supabase
// first, then its own files — so a production run can be pulled from a
// laptop with `--api`).
//
// The sheet has three parts: the run header, a one-line-per-step summary
// table, and one section per step with its input and output. The summary is
// what you scan to find the gate that bent the answer; the sections are what
// you open to see why.
// ===========================================================================

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const has = (name) => args.includes(name);
const target = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

if (!target || has('--help')) {
  console.error(
    'usage: node tools/trace-sheet.mjs <run_id | file.jsonl> [--api <base>] [--dir <traces dir>] [--out <file.md>] [--full] [--json]',
  );
  process.exit(target ? 0 : 2);
}

const FULL = has('--full');
const CUT = FULL ? Infinity : 1200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function parseJsonl(text) {
  let run = null;
  const steps = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const { type, ...rest } = row;
    if (type === 'run') run = rest;
    else if (type === 'step') steps.push(rest);
  }
  if (!run) return null;
  steps.sort((a, b) => a.seq - b.seq);
  return { run, steps };
}

async function load() {
  if (target.endsWith('.jsonl')) return parseJsonl(await readFile(target, 'utf8'));

  if (!UUID.test(target)) {
    throw new Error(`"${target}" is neither a .jsonl path nor a run id (uuid).`);
  }

  const api = flag('--api');
  if (api) {
    const url = `${api.replace(/\/+$/, '')}/api/trace/${target}`;
    const res = await fetch(url);
    if (res.status === 404) throw new Error(`No trace for ${target} at ${url}`);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  }

  const dir = resolve(flag('--dir') ?? process.env.TRACE_DIR ?? '.data/traces');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    throw new Error(`Cannot read ${dir}. Pass --dir, or --api <server> to read from a running server.`);
  }
  const name = names.find((n) => n.endsWith(`_${target.toLowerCase()}.jsonl`));
  if (!name) throw new Error(`No trace for ${target} under ${dir}. Try --api <server>.`);
  return parseJsonl(await readFile(resolve(dir, name), 'utf8'));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ms = (v) => (v === null || v === undefined ? '' : `${v}`);
const tokens = (u) => (u ? [u.input_tokens, u.output_tokens].map((n) => n ?? '·').join('/') : '');

function fence(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) text = 'null';
  if (text.length > CUT) text = `${text.slice(0, CUT)}\n…[${text.length - CUT} more chars — use --full]`;
  return `\`\`\`json\n${text}\n\`\`\``;
}

/** Long strings inside a payload are the raw prompts and texts; show them as prose blocks, not JSON escapes. */
function payload(value) {
  if (value === null || value === undefined) return '_none_';
  if (typeof value !== 'object') return fence(value);
  const long = Object.entries(value).filter(([, v]) => typeof v === 'string' && v.length > 200);
  if (!long.length) return fence(value);
  const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !long.some(([lk]) => lk === k)));
  const parts = long.map(([k, v]) => {
    const text = v.length > CUT * 4 ? `${v.slice(0, CUT * 4)}\n…[${v.length - CUT * 4} more chars — use --full]` : v;
    return `**${k}**\n\n\`\`\`text\n${text}\n\`\`\``;
  });
  if (Object.keys(rest).length) parts.push(`**other fields**\n\n${fence(rest)}`);
  return parts.join('\n\n');
}

const STATUS_MARK = { ok: '✓', error: '✗', skipped: '–', rejected: '↺' };

function render({ run, steps }) {
  const out = [];
  const result = steps.find((s) => s.stage === 'RESULT');
  const modelCalls = steps.filter((s) => s.kind === 'model' && s.status !== 'skipped');
  const totalTokens = modelCalls.reduce(
    (acc, s) => ({
      in: acc.in + (s.usage?.input_tokens ?? 0),
      out: acc.out + (s.usage?.output_tokens ?? 0),
    }),
    { in: 0, out: 0 },
  );
  const wall = run.ended_at ? new Date(run.ended_at) - new Date(run.started_at) : null;

  out.push(`# Trace ${run.run_id}`);
  out.push('');
  out.push(`| | |`);
  out.push(`|---|---|`);
  out.push(`| Started | ${run.started_at} |`);
  out.push(`| Ended | ${run.ended_at ?? '_still running or never closed_'}${wall !== null ? ` (${wall} ms)` : ''} |`);
  out.push(`| Concluded as | **${run.status}** |`);
  out.push(`| Senator | ${cell(run.politician_id)} |`);
  out.push(`| Statement | ${cell(run.promise_text)} |`);
  out.push(`| Final | ${result ? `**${cell(result.label)}**` : '_no RESULT step_'} |`);
  out.push(`| app_queries row | ${run.query_id ?? '_none_'} |`);
  out.push(`| Mode | ${cell(JSON.stringify(run.meta ?? {}))} |`);
  out.push(`| Model calls | ${modelCalls.length} · tokens in/out ${totalTokens.in}/${totalTokens.out} |`);
  out.push('');

  const flagged = steps.filter((s) => s.status !== 'ok');
  if (flagged.length) {
    out.push(`## Steps that did not simply pass`);
    out.push('');
    for (const s of flagged) {
      out.push(`- **${s.seq} ${s.stage}** (${s.status})${s.subject ? ` · ${cell(s.subject)}` : ''}: ${cell(s.label)}${s.error ? ` — \`${cell(s.error)}\`` : ''}`);
    }
    out.push('');
  }

  out.push(`## Log sheet`);
  out.push('');
  out.push(`| # | | stage | kind | subject | decision | ms | model | tok in/out |`);
  out.push(`|--:|:-:|---|---|---|---|--:|---|---|`);
  for (const s of steps) {
    out.push(
      `| ${s.seq} | ${STATUS_MARK[s.status] ?? s.status} | ${s.stage} | ${s.kind} | ${cell(s.subject)} | ${cell(s.label)} | ${ms(s.duration_ms)} | ${cell(s.model)} | ${tokens(s.usage)} |`,
    );
  }
  out.push('');

  out.push(`## Steps`);
  out.push('');
  for (const s of steps) {
    out.push(`### ${s.seq} · ${s.stage} · ${s.status}${s.subject ? ` · ${cell(s.subject)}` : ''}`);
    out.push('');
    out.push(`${cell(s.label)}`);
    out.push('');
    const meta = [];
    if (s.duration_ms !== null && s.duration_ms !== undefined) meta.push(`${s.duration_ms} ms`);
    if (s.model) meta.push(`model \`${s.model}\``);
    if (s.prompt_version) meta.push(`prompt \`${s.prompt_version}\``);
    if (s.prompt_sha256) meta.push(`sha256 \`${s.prompt_sha256.slice(0, 12)}…\``);
    if (s.usage) meta.push(`tokens ${JSON.stringify(s.usage)}`);
    if (meta.length) {
      out.push(meta.join(' · '));
      out.push('');
    }
    if (s.error) {
      out.push(`**error:** ${cell(s.error)}`);
      out.push('');
    }
    if (s.input !== null && s.input !== undefined) {
      out.push(`**Input**`);
      out.push('');
      out.push(payload(s.input));
      out.push('');
    }
    if (s.output !== null && s.output !== undefined) {
      out.push(`**Output**`);
      out.push('');
      out.push(payload(s.output));
      out.push('');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------

try {
  const record = await load();
  if (!record) throw new Error('The trace file had no run header.');
  const text = has('--json') ? JSON.stringify(record, null, 2) : render(record);
  const outPath = flag('--out');
  if (outPath) {
    await writeFile(outPath, `${text}\n`, 'utf8');
    console.error(`wrote ${outPath} (${record.steps.length} steps)`);
  } else {
    process.stdout.write(`${text}\n`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// ---- shared helpers (same in every v2 pipeline Code node) -----------------
// Values arrive as strings, numbers or booleans. 'NA', 'N/A' and blank all
// mean "no value" and become null, never a default.
const S = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pick = (o, n) => {
  const t = n.toLowerCase();
  for (const k of Object.keys(o || {})) if (k.trim().toLowerCase() === t) return o[k];
  return undefined;
};
const problems = [];
const problem = (id, field, value, issue) => { problems.push({ id, field, value: S(value).slice(0, 80), issue }); };
const nz = (v) => { const s = S(v); return !s || s === 'NA' || s === 'N/A' ? null : s; };
// A calendar date from an ISO timestamp or date, as the old pipeline wrote it:
// the UTC date (new Date(x).toISOString().slice(0, 10)).
const utcDay = (v) => {
  const s = S(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const iso = (v) => {
  const s = S(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
};

// The run's settings. Every workflow starts with a Config node; anything other
// than an explicit false keeps dry_run on.
const cfg = $('Config').first().json;
const dryRun = !(cfg.dry_run === false || S(cfg.dry_run).toLowerCase() === 'false');

// GET a URL from inside a Code node. Public sources only (the storage bucket,
// congress-legislators); congress.gov needs the credential, so those calls are
// HTTP Request nodes.
const getJson = async (url, tries) => {
  tries = tries || 3;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await this.helpers.httpRequest({ url, json: true, timeout: 60000 });
      return typeof res === 'string' ? JSON.parse(res) : res;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error('GET ' + url + ' failed: ' + (last && last.message));
};

// Every object in the storage bucket under a prefix, with its content hash.
// The bucket re-uploads the current congress every day, so the hash (not the
// upload time) is what says a file changed.
const BUCKET = 'congress-legislative-data';
const listBucket = async (prefix, glob) => {
  const out = [];
  let token = '';
  for (let page = 0; page < 200; page++) {
    let url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o?prefix=' + encodeURIComponent(prefix) +
      '&fields=items(name,md5Hash,size),nextPageToken&maxResults=1000';
    if (glob) url += '&matchGlob=' + encodeURIComponent(glob);
    if (token) url += '&pageToken=' + encodeURIComponent(token);
    const body = await getJson(url);
    for (const it of body.items || []) out.push({ path: it.name, md5: it.md5Hash, size: Number(it.size) || null });
    token = body.nextPageToken || '';
    if (!token) return out;
  }
  throw new Error('bucket listing for ' + prefix + ' did not end after 200 pages');
};
const fileUrl = (path) => 'https://storage.googleapis.com/' + BUCKET + '/' + path;

// Run fn over items, a few at a time.
const pool = async (items, size, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e.message }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
};

// One INSERT ... ON CONFLICT per chunk. Rows travel as a bound jsonb
// parameter ($1), never in the query text: the driver reads $n anywhere in the
// text as a placeholder, so data in the text breaks on "$95 million".
//
// opts.guard:   update only when a column actually differs, so updated_at and
//               opts.changedAt move only on a real change.
// opts.changedAt: a column set to now() when the row is inserted or changed.
// opts.onlyCols: on conflict, update only these columns (the rest are written
//               on insert only).
const upsert = (table, spec, key, rows, opts) => {
  opts = opts || {};
  const chunk = opts.chunk || 300;
  const touch = opts.touch !== false;
  const cols = Object.keys(spec);
  const q = (c) => '"' + c + '"';
  const updCols = (opts.onlyCols || cols).filter((c) => key.indexOf(c) === -1);
  const set = updCols.map((c) => q(c) + ' = EXCLUDED.' + q(c));
  if (touch) set.push('updated_at = now()');
  if (opts.changedAt) set.push(q(opts.changedAt) + ' = now()');
  // opts.extra: columns set from an SQL expression, e.g. { run_id: '$2::bigint' }.
  const extra = opts.extra || {};
  for (const c of Object.keys(extra)) set.push(q(c) + ' = ' + extra[c]);
  const where = opts.guard && updCols.length
    ? ' WHERE (' + updCols.map((c) => 't.' + q(c)).join(', ') + ') IS DISTINCT FROM (' + updCols.map((c) => 'EXCLUDED.' + q(c)).join(', ') + ')'
    : '';
  const extraCols = (touch ? ', updated_at' : '') + (opts.changedAt ? ', ' + q(opts.changedAt) : '') +
    Object.keys(extra).map((c) => ', ' + q(c)).join('');
  const extraVals = (touch ? ', now()' : '') + (opts.changedAt ? ', now()' : '') +
    Object.keys(extra).map((c) => ', ' + extra[c]).join('');
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const sql =
      'INSERT INTO core.' + table + ' AS t (' + cols.map(q).join(', ') + extraCols + ') ' +
      'SELECT ' + cols.map((c) => 'x.' + q(c)).join(', ') + extraVals + ' ' +
      'FROM jsonb_to_recordset($1::jsonb) AS x(' + cols.map((c) => q(c) + ' ' + spec[c]).join(', ') + ') ' +
      'ON CONFLICT (' + key.map(q).join(', ') + ') DO ' + (set.length ? 'UPDATE SET ' + set.join(', ') + where : 'NOTHING') + ';';
    out.push({ table, rows: slice.length, sql, payload: JSON.stringify(slice) });
  }
  return out;
};

// What an upsert WOULD do, without doing it: rows new to the table, and for
// existing rows the number that would change per column, with a few samples.
// Used on dry runs, and on write runs before the write, so every run reports
// what it changed.
const preview = (table, spec, key, rows, opts) => {
  opts = opts || {};
  const cols = Object.keys(spec);
  const q = (c) => '"' + c + '"';
  const cmp = (opts.onlyCols || cols).filter((c) => key.indexOf(c) === -1);
  const join = key.map((k) => 't.' + q(k) + ' = x.' + q(k)).join(' AND ');
  const keyExpr = key.length === 1 ? 'x.' + q(key[0]) + '::text' : "concat_ws('|', " + key.map((k) => 'x.' + q(k)).join(', ') + ')';
  const perCol = cmp.map((c) =>
    "'" + c + "', jsonb_build_object('n', count(*) FILTER (WHERE t." + q(key[0]) + ' IS NOT NULL AND t.' + q(c) + ' IS DISTINCT FROM x.' + q(c) + '), ' +
    "'eg', (jsonb_agg(jsonb_build_object('key', " + keyExpr + ", 'was', to_jsonb(t." + q(c) + "), 'now', to_jsonb(x." + q(c) + '))) FILTER (WHERE t.' + q(key[0]) + ' IS NOT NULL AND t.' + q(c) + ' IS DISTINCT FROM x.' + q(c) + "))->0)");
  const sql =
    'SELECT ' + "'" + table + "' AS \"table\", count(*) AS rows, count(*) FILTER (WHERE t." + q(key[0]) + ' IS NULL) AS new_rows, ' +
    "(jsonb_agg(" + keyExpr + ") FILTER (WHERE t." + q(key[0]) + ' IS NULL)) AS new_keys, ' +
    'jsonb_build_object(' + (perCol.length ? perCol.join(', ') : "'none', 0") + ') AS changes ' +
    'FROM jsonb_to_recordset($1::jsonb) AS x(' + cols.map((c) => q(c) + ' ' + spec[c]).join(', ') + ') ' +
    'LEFT JOIN core.' + table + ' t ON ' + join + ';';
  return { table, rows: rows.length, sql, payload: JSON.stringify(rows) };
};

// Every item carries the run's summary and dry_run, so whichever branch runs
// reads the same thing.
const emit = (statements, previews, summary) => {
  summary.problems_count = problems.length;
  summary.problems = problems.slice(0, 50);
  summary.statements = statements.length;
  summary.dry_run = dryRun;
  console.log('[v2 pipeline] ' + JSON.stringify(summary).slice(0, 3000));
  if (!statements.length) statements.push({ table: null, rows: 0, sql: 'SELECT 0 WHERE $1::text IS NOT NULL;', payload: '[]' });
  return statements.map((s) => ({ json: Object.assign({}, s, { dry_run: dryRun, summary, previews: previews || [] }) }));
};
// ---------------------------------------------------------------------------

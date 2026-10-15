// Dry run of the members Code node (js/helpers.js + js/members.js) outside
// n8n, to preview the membership report before publishing.
//
//   node docs/v2/pipeline/oneoff/members_crosscheck_dryrun.cjs [out.json]
//
// Reads, never writes: legislators-current and -historical, the congress.gov
// list of current members (CONGRESS_API_KEY from the environment, else the
// public api.data.gov DEMO_KEY, which allows a few calls an hour), and
// core.members plus the last membership report through DATABASE_URL from the
// repo-root .env, in a READ ONLY transaction. Prints the summary the run would
// record; nothing is sent and nothing is written.
const fs = require('fs');
const path = require('path');
// The main checkout holds .env and node_modules; a worktree has neither.
const ROOT = path.dirname(path.resolve(__dirname, require('child_process').execSync('git rev-parse --git-common-dir', { cwd: __dirname }).toString().trim()));
const req = (m) => require(require.resolve(m, { paths: [ROOT, process.cwd()] }));
req('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set in ' + path.join(ROOT, '.env'));
const { Client } = req('pg');
const PIPE = path.resolve(__dirname, '..');

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('GET ' + url.replace(/api_key=[^&]+/, 'api_key=...') + ' -> ' + res.status);
  return res.json();
};

(async () => {
  const key = process.env.CONGRESS_API_KEY || 'DEMO_KEY';
  const pages = [];
  let url = 'https://api.congress.gov/v3/member?currentMember=true&limit=250&format=json';
  while (url && pages.length < 10) {
    const body = await getJson(url + '&api_key=' + key);
    pages.push({ json: body });
    url = body.pagination && body.pagination.next;
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const members = (await c.query('SELECT member_id, full_name, chamber, state, district, party, in_scope, left_at::text AS left_at FROM core.members ORDER BY member_id')).rows;
  const last = (await c.query("SELECT counts->'membership' AS membership FROM core.ingest_runs WHERE workflow LIKE 'v2 Pipeline: members%' AND status = 'ok' AND counts->'membership' IS NOT NULL ORDER BY run_id DESC LIMIT 1")).rows;
  await c.query('ROLLBACK');
  await c.end();

  const nodes = {
    'Config': [{ json: { dry_run: true, disagree_days: 3 } }],
    'Read Members': members.map((r) => ({ json: r })),
    'Read Last Report': [{ json: last[0] || {} }],
    'Fetch congress.gov Members': pages,
  };
  const $ = (n) => ({ first: () => nodes[n][0], all: () => nodes[n] });
  const ctx = { helpers: { httpRequest: async ({ url: u }) => getJson(u) } };
  const src = fs.readFileSync(path.join(PIPE, 'js/helpers.js'), 'utf8') + '\n' + fs.readFileSync(path.join(PIPE, 'js/members.js'), 'utf8');
  const run = new Function('$', 'console', 'return (async function () {' + src + '\n}).call(this);');
  const items = await run.call(ctx, $, { log: () => {} });
  const s = items[0].json.summary;
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(s.membership, null, 1));
  const m = s.membership;
  console.log(JSON.stringify({
    checked_on: m.checked_on, legislators_current: s.rows_out, congress_gov: m.congress_gov_members, core_members: members.length,
    errors: s.errors, arrived: m.arrived, left: m.left, disagreements: m.disagreements, alert: m.alert && m.alert.reasons,
  }, null, 1));
})().catch((e) => { console.error(String(e && e.message || e).replace(/postgres(ql)?:\/\/\S+/g, '[url]')); process.exit(1); });

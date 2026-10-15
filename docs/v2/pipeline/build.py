"""Assemble n8n Workflow SDK code for the v2 daily pipeline (Phase 3).

    python3 docs/v2/pipeline/build.py <name>    -> writes out/<name>.sdk.ts

Code-node JavaScript lives in js/, SQL in sql/; both are embedded as JSON
strings, so nothing in them is reinterpreted by the SDK parser. Every Code
node that reads Config or writes SQL is prefixed with js/helpers.js.
"""
import json, sys, pathlib

HERE = pathlib.Path(__file__).parent
J = json.dumps
# The helpers go into every Code node that needs them; their comments live in
# js/helpers.js and are left out of the embedded copy.
HELPERS = '\n'.join(l for l in (HERE / 'js' / 'helpers.js').read_text().split('\n')
                     if not l.strip().startswith('//') or l.startswith('// ----'))

CRED = {
    'sheets': "{ googleSheetsOAuth2Api: { id: 'NJjmUOfPUntWQQNr', name: 'Google Sheets account' } }",
    'postgres': "{ postgres: { id: '3qIhuJmA7fIiofhS', name: 'Postgres account' } }",
    'openai': "{ openAiApi: { id: '8ZxNLryYxwOqNDfP', name: 'n8n OpenAI' } }",
    'congress': "{ httpQueryAuth: { id: '5UocaIVkAqR6GakY', name: 'US Gov' } }",
    'gmail': "{ gmailOAuth2: { id: 'gVqIYw99SzrE88BR', name: 'Gmail account 2' } }",
}
TAXONOMY = '1jCZ3fFNl3ZZqiBlDmUQg_ORk2nDBnrxj4SL3MMZm7jo'
IMPACT = '1eQFWCstVau5GpB6NnQwGHc_ZytO54Hjyj5RPEK2nOko'
MASTER = '1AJK0A8rJ5oY4kUwnYR7Z_g_W2tGnwCNlfMsGwbGaTj0'


def lit(text):
    """A long string as a concatenation of JSON literals of up to ~1,400
    characters each, split at line ends, so the generated SDK code has short
    lines but few enough pieces for the SDK parser."""
    lines = text.split('\n')
    pieces, cur = [], ''
    for i, l in enumerate(lines):
        seg = l + ('\n' if i < len(lines) - 1 else '')
        if cur and len(cur) + len(seg) > 1400:
            pieces.append(cur)
            cur = ''
        cur += seg
    if cur:
        pieces.append(cur)
    return '\n    + '.join(J(x) for x in pieces) if pieces else '""'


def js(name):
    return (HERE / 'js' / name).read_text()


def sql(name):
    return (HERE / 'sql' / name).read_text()


def code(var, name, source, helpers=True, extra=''):
    body = (HELPERS + '\n' + source) if helpers else source
    # A Code node already runs once for all its items. executeOnce would hand it
    # only the FIRST input item, so a node that reads $input must not have it.
    if '$input' in source:
        extra = extra.replace(', executeOnce: true', '')
    return f"const {var} = node({{ type: 'n8n-nodes-base.code', version: 2, config: {{ name: {J(name)}{extra}, parameters: {{ jsCode: {lit(body)} }} }}, output: [{{}}] }});"


def pg(var, name, query, replacement=None, extra='', batching=None):
    opts = []
    if batching:
        opts.append(f"queryBatching: {J(batching)}")
    if replacement:
        opts.append(f"queryReplacement: expr({J(replacement)})")
    return (f"const {var} = node({{ type: 'n8n-nodes-base.postgres', version: 2.6, config: {{ name: {J(name)}{extra}, "
            f"parameters: {{ operation: 'executeQuery', query: {lit(query)}, options: {{ {', '.join(opts)} }} }}, "
            f"credentials: {CRED['postgres']} }}, output: [{{}}] }});")


def sheet(var, name, doc, tab):
    return (f"const {var} = node({{ type: 'n8n-nodes-base.googleSheets', version: 4.7, config: {{ name: {J(name)}, executeOnce: true, "
            f"retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, parameters: {{ documentId: {{ __rl: true, mode: 'id', value: {J(doc)} }}, "
            f"sheetName: {{ __rl: true, mode: 'name', value: {J(tab)} }}, options: {{}} }}, credentials: {CRED['sheets']} }}, output: [{{}}] }});")


def triggers(inputs):
    """Manual start (dry_run defaults to true) and a call from the orchestrator."""
    vals = ', '.join(f"{{ name: {J(n)}, type: 'any' }}" for n in inputs)
    return '\n'.join([
        "const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' }, output: [{}] });",
        f"const called = trigger({{ type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.1, config: {{ name: 'When Called by the Orchestrator', parameters: {{ inputSource: 'workflowInputs', workflowInputs: {{ values: [{vals}] }} }} }}, output: [{{}}] }});",
    ])


def config(fields):
    """fields: (name, type, default). A value passed by the caller wins; dry_run
    is false only when the caller says false."""
    parts = []
    for n, t, default in fields:
        if n == 'dry_run':
            v = "={{ !($json.dry_run === false || String($json.dry_run).toLowerCase() === 'false') }}"
        else:
            v = "={{ $json." + n + " !== undefined && $json." + n + " !== null && $json." + n + " !== '' ? $json." + n + " : " + J(default) + " }}"
        parts.append(f"{{ id: {J('cfg-' + n)}, name: {J(n)}, value: {J(v)}, type: {J(t)} }}")
    return (f"const config = node({{ type: 'n8n-nodes-base.set', version: 3.4, config: {{ name: 'Config', parameters: {{ mode: 'manual', includeOtherFields: false, "
            f"assignments: {{ assignments: [{', '.join(parts)}] }}, options: {{}} }} }}, output: [{{ dry_run: true }}] }});")


def tail(build):
    """Preview what the run changes, then (write runs only) open a run row, write
    every statement in one transaction, and close the row. A run that stops part
    way leaves its row as failed / 'in progress'."""
    previews_js = (
        "// One item per preview query built by " + build + ".\n"
        f"const p = $({J(build)}).first().json.previews || [];\n"
        "if (!p.length) return [{ json: { table: null, sql: 'SELECT NULL::text AS \"table\" WHERE $1::text IS NOT NULL', payload: '[]' } }];\n"
        "return p.map((x) => ({ json: x }));"
    )
    report_js = (
        "// What this run would change (dry run) or is about to change (write run).\n"
        f"const s = $({J(build)}).first().json.summary;\n"
        "const changes = $input.all().map((i) => i.json).filter((r) => r.table);\n"
        "return [{ json: { dry_run: s.dry_run, summary: s, changes } }];"
    )
    statements_js = (
        "// The statements, each with the run id when the SQL asks for it ($2).\n"
        "const runId = $('Open Run').first().json.run_id;\n"
        f"return $({J(build)}).all().map((i) => ({{ json: {{ table: i.json.table, rows: i.json.rows, sql: i.json.sql, params: i.json.sql.indexOf('$2') !== -1 ? [i.json.payload, runId] : [i.json.payload] }} }}));"
    )
    result_js = (
        "// One summary back to the caller. A run with errors fails here, AFTER\n"
        "// writing what it could, so the failure email goes out.\n"
        "const r = $('Report').first().json;\n"
        "let runId = null;\n"
        "try { runId = $('Close Run').first().json.run_id; } catch (e) { runId = null; }\n"
        "const out = Object.assign({}, r.summary, { changes: r.changes, ingest_run_id: runId });\n"
        "const errs = r.summary.errors || [];\n"
        "if (errs.length && !r.dry_run) throw new Error('[' + $workflow.name + '] ' + errs.join('; ') + (runId ? ' (ingest run ' + runId + ')' : ''));\n"
        "return [{ json: out }];"
    )
    open_sql = ("INSERT INTO core.ingest_runs (workflow, execution_id, status, notes, counts) "
                "VALUES ($1, $2, 'failed', 'in progress', $3::jsonb) RETURNING run_id;")
    close_sql = ("UPDATE core.ingest_runs SET status = $2, finished_at = now(), notes = NULL, counts = $3::jsonb, errors = $4::jsonb "
                 "WHERE run_id = $1 RETURNING run_id;")
    return '\n'.join([
        code('listPreviews', 'List Previews', previews_js, helpers=False, extra=', executeOnce: true'),
        pg('runPreviews', 'Preview Changes', '{{ $json.sql }}', '{{ [$json.payload] }}'),
        code('report', 'Report', report_js, helpers=False, extra=', executeOnce: true'),
        """const writeEnabled = ifElse({ version: 2.2, config: { name: 'Write enabled?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.dry_run }}'), operator: { type: 'boolean', operation: 'false', singleValue: true } }], combinator: 'and' }, options: {} } } });""",
        pg('openRun', 'Open Run', open_sql, "{{ [$workflow.name, $execution.id, JSON.stringify({ changes: $json.changes })] }}", extra=', executeOnce: true'),
        code('statementsNode', 'Statements', statements_js, helpers=False, extra=', executeOnce: true'),
        pg('writeCore', 'Write to core', '{{ $json.sql }}', '{{ $json.params }}', batching='transaction'),
        pg('closeRun', 'Close Run', close_sql,
           "{{ [$('Open Run').first().json.run_id, ($('Report').first().json.summary.errors || []).length ? 'failed' : 'ok', "
           "JSON.stringify(Object.assign({}, $('Report').first().json.summary, { changes: $('Report').first().json.changes })), "
           "JSON.stringify($('Report').first().json.summary.errors || [])] }}", extra=', executeOnce: true'),
        code('result', 'Result', result_js, helpers=False, extra=', executeOnce: true'),
    ])


def assemble(wid, title, inputs, cfg_fields, body_parts, chain, sticky_text):
    """chain: node variable names from Config to the build node, in order."""
    parts = ["import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';",
             triggers(inputs), config(cfg_fields)] + body_parts + [tail(chain[-1][1])]
    parts.append(f"const note = sticky({J(sticky_text)}, [config], {{ color: 4 }});")
    flow = ''.join(f"\n  .to({v})" for v, _ in chain)
    parts.append(f"""export default workflow({J(wid)}, {J(title)})
  .add(start)
  .to(config){flow}
  .to(listPreviews)
  .to(runPreviews)
  .to(report)
  .to(writeEnabled.onTrue(openRun.to(statementsNode).to(writeCore).to(closeRun).to(result)).onFalse(result))
  .add(called)
  .to(config)
  .add(note);""")
    return '\n'.join(parts)


NOTE = ('Manual start: **dry_run defaults to true**, which reads, builds and reports what would change, and writes nothing. '
        'The orchestrator calls it with dry_run false. Every write is an upsert that changes a row only when a value differs, '
        'and every write run leaves one core.ingest_runs row. Sheets and every old workflow are only ever read.')


def members():
    return assemble('v2-pipeline-members', 'v2 Pipeline: members (weekly)', ['dry_run'],
        [('dry_run', 'boolean', True)],
        [code('buildMembers', 'Build Members', js('members.js'))],
        [('buildMembers', 'Build Members')],
        '## v2 pipeline: members\nWeekly. Names, parties, states, districts, Senate class, LIS id and terms from '
        'congress-legislators. A member already here who has left gets left_at and term_end from legislators-historical, and a blank '
        'LIS id filled, so their votes still join. A former senator who served since 3 Jan 2023 and is not here is added, not in scope '
        'and not live, so their stored votes join. Never touches in_scope, live, the congresses collected, roles, OpenSecrets id or website. ' + NOTE)


def rollcalls():
    scope_sql = ("SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}') AS congresses "
                 "FROM core.members m, unnest(m.congresses) AS c WHERE m.in_scope;")
    unread_sql = ("SELECT count(*) AS listed, coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.path) FILTER (WHERE f.path IS NULL), '[]') AS unread "
                  "FROM jsonb_to_recordset($1::jsonb) AS x(path text, md5 text, size bigint) "
                  "LEFT JOIN core.source_files f ON f.path = x.path;")
    return assemble('v2-pipeline-roll-calls', 'v2 Pipeline: roll calls', ['dry_run', 'max_files', 'congresses'],
        [('dry_run', 'boolean', True), ('max_files', 'number', 400), ('congresses', 'string', '')],
        [pg('getScope', 'Get Scope', scope_sql, extra=', executeOnce: true'),
         code('listFiles', 'List Vote Files', js('rollcalls_list.js'), extra=', executeOnce: true'),
         pg('findUnread', 'Find Unread Files', unread_sql, '{{ [JSON.stringify($json.listing)] }}', extra=', executeOnce: true'),
         code('buildRollCalls', 'Build Roll Calls', js('rollcalls.js'), extra=', executeOnce: true')],
        [('getScope', 'Get Scope'), ('listFiles', 'List Vote Files'), ('findUnread', 'Find Unread Files'), ('buildRollCalls', 'Build Roll Calls')],
        '## v2 pipeline: roll calls\nLists the Senate vote files in the bucket, reads only the ones never read, keeps '
        "today's filter (passage and cloture votes on a bill) and loads each kept vote whole, every member's position. "
        'max_files caps one run; the rest wait for the next. ' + NOTE)


def sponsorships():
    members_sql = ("SELECT member_id, congresses, full_name FROM core.members "
                   "WHERE in_scope AND cardinality(congresses) > 0 ORDER BY member_id;")
    complete = ("{{ !$response.body.pagination || !$response.body.pagination.next || "
                "($response.body.sponsoredLegislation || $response.body.cosponsoredLegislation || []).every(e => Number(e.congress) < "
                "Math.min(...$('Get Members').all().flatMap(i => i.json.congresses.map(Number)))) }}")
    fetch_members = (
        "const fetchMembers = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3, config: { name: 'Fetch Member Legislation', "
        "retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, parameters: { method: 'GET', url: expr('{{ $json.url }}'), "
        "authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth', options: { pagination: { pagination: { "
        "paginationMode: 'responseContainsNextURL', nextURL: expr('{{ $response.body.pagination.next }}'), "
        f"paginationCompleteWhen: 'other', completeExpression: expr({J(complete)}), limitPagesFetched: true, maxRequests: 40, requestInterval: 250 }} }} }} }}, "
        f"credentials: {CRED['congress']} }}, output: [{{}}] }});")
    fetch_text = (
        "const fetchText = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3, config: { name: 'Fetch Text Links', "
        "retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput', alwaysOutputData: true, "
        "parameters: { method: 'GET', url: expr('{{ $json.url }}'), authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth', "
        "options: { batching: { batch: { batchSize: 5, batchInterval: 300 } }, response: { response: { responseFormat: 'json' } } } }, "
        f"credentials: {CRED['congress']} }}, output: [{{}}] }});")
    return assemble('v2-pipeline-sponsorships-bills', 'v2 Pipeline: sponsorships and bills', ['dry_run', 'max_bill_files', 'members'],
        [('dry_run', 'boolean', True), ('max_bill_files', 'number', 300), ('members', 'string', '')],
        [pg('getMembers', 'Get Members', members_sql, extra=', executeOnce: true'),
         code('memberQueries', 'Member Queries', js('sb_queries.js'), helpers=False),
         fetch_members,
         code('parseMembers', 'Parse Member Bills', js('sb_parse.js'), helpers=False, extra=', executeOnce: true'),
         code('listBills', 'List Bill Files', js('sb_list.js'), extra=', executeOnce: true'),
         pg('findWork', 'Find Work', sql('sb_find_work.sql'),
            "{{ [JSON.stringify($('Parse Member Bills').first().json.pairs), JSON.stringify($json.listing)] }}", extra=', executeOnce: true'),
         code('textRequests', 'Text Requests', js('sb_text_requests.js'), helpers=False, extra=', executeOnce: true'),
         fetch_text,
         code('buildBills', 'Build Bills', js('sb_build.js'), extra=', executeOnce: true')],
        [('getMembers', 'Get Members'), ('memberQueries', 'Member Queries'), ('fetchMembers', 'Fetch Member Legislation'),
         ('parseMembers', 'Parse Member Bills'), ('listBills', 'List Bill Files'), ('findWork', 'Find Work'),
         ('textRequests', 'Text Requests'), ('fetchText', 'Fetch Text Links'), ('buildBills', 'Build Bills')],
        '## v2 pipeline: sponsorships and bills\nFor each in_scope member: sponsored and cosponsored bills from congress.gov, '
        "back to the oldest congress collected (fails loudly if a list is cut off). New bills and bills whose file changed are "
        "read from the bucket: WF2/WF4 fields for a new bill, WF2b status and WF2c progress, sponsor tier, true cosponsor dates and "
        'withdrawals. max_bill_files caps one run. ' + NOTE)


def obj(o, ind='    '):
    """A JSON value as SDK object literal, long strings split per line."""
    if isinstance(o, dict):
        return '{ ' + ', '.join(f'{J(k)}: {obj(v, ind)}' for k, v in o.items()) + ' }'
    if isinstance(o, list):
        return '[' + ', '.join(obj(v, ind) for v in o) + ']'
    if isinstance(o, str) and len(o) > 200:
        return lit(o)
    return J(o)


def wf5(name):
    return (HERE / 'wf5' / name).read_text()


def copy_statements():
    return assemble('v2-pipeline-statement-copy', 'v2 Pipeline: statement copy (parallel run)', ['dry_run'],
        [('dry_run', 'boolean', True)],
        [sheet('readStatements', 'Read Impact Statements', IMPACT, 'Impact Statements'),
         sheet('readStakeholders', 'Read Affected Stakeholders', IMPACT, 'Affected Stakeholders'),
         sheet('readVersions', 'Read Statement Versions', IMPACT, 'Impact Statements - Versions'),
         code('buildCopy', 'Build Statement Copy', js('copy.js'), extra=', executeOnce: true')],
        [('readStatements', 'Read Impact Statements'), ('readStakeholders', 'Read Affected Stakeholders'),
         ('readVersions', 'Read Statement Versions'), ('buildCopy', 'Build Statement Copy')],
        '## v2 pipeline: statement copy\nPARALLEL RUN ONLY, retired at cutover. Copies the old pipeline\'s impact statements, '
        'stakeholders and per-version statements into core.bill_impacts each day, so statements are generated (and paid for) once. '
        'Never copies bills. A statement whose bill core does not hold is reported, not written. ' + NOTE)


def embeddings():
    cand_sql = ("SELECT i.impact_id, i.bill_id, i.title, i.summary, i.intended_effects, i.mechanisms, i.policy_area, i.primary_issue, "
                "i.sub_issue, i.keywords, i.stakeholders, b.subjects, (i.embedding IS NOT NULL) AS has_embedding, i.embedded_text_md5 "
                "FROM core.bill_impacts i JOIN core.bills b USING (bill_id) "
                "WHERE i.version_code IS NULL AND (i.embedding IS NULL OR i.embedded_text_md5 IS NULL OR i.content_changed_at > i.embedded_at) "
                "ORDER BY (i.embedding IS NULL) DESC, i.bill_id LIMIT $1;")
    hash_sql = ("SELECT x.impact_id, x.embedded_text_md5, md5(x.text) AS md5, "
                "CASE WHEN NOT x.has_embedding OR x.embedded_text_md5 IS NULL OR x.embedded_text_md5 <> md5(x.text) THEN 'embed' ELSE 'same' END AS action "
                "FROM jsonb_to_recordset($1::jsonb) AS x(impact_id text, text text, has_embedding boolean, embedded_text_md5 text);")
    embed = ("const embedCall = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3, config: { name: 'Embed', retryOnFail: true, maxTries: 3, "
             "waitBetweenTries: 3000, onError: 'continueRegularOutput', parameters: { method: 'POST', url: 'https://api.openai.com/v1/embeddings', "
             "authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi', sendBody: true, specifyBody: 'json', "
             "jsonBody: expr('{{ JSON.stringify($json.body) }}'), options: {} }, "
             f"credentials: {CRED['openai']} }}, output: [{{}}] }});")
    skip_embed = ("const sendEmbeds = ifElse({ version: 2.2, config: { name: 'Anything to embed?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, "
                  "conditions: [{ leftValue: expr('{{ !$json.skip }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } } });")
    parts = ["import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';",
             triggers(['dry_run', 'max_rows']), config([('dry_run', 'boolean', True), ('max_rows', 'number', 1000)]),
             pg('getCandidates', 'Get Candidates', cand_sql, "{{ [$json.max_rows] }}", extra=', executeOnce: true, alwaysOutputData: true'),
             sheet('getTaxonomy', 'Get Approved Taxonomy', TAXONOMY, 'Approved Taxonomy'),
             code('buildTexts', 'Build Texts', js('embed_texts.js'), extra=', executeOnce: true'),
             pg('hashTexts', 'Hash Texts', hash_sql, "{{ [JSON.stringify($json.texts)] }}", extra=', executeOnce: true, alwaysOutputData: true'),
             code('requests', 'Embedding Requests', js('embed_batches.js'), extra=', executeOnce: true'),
             skip_embed, embed,
             code('buildEmbeds', 'Build Writes', js('embed_build.js'), extra=', executeOnce: true'),
             tail('Build Writes'),
             f"const note = sticky({J('## v2 pipeline: embeddings' + chr(10) + 'Bill-level statements with no embedding, or whose embedding text changed: the exact text of Bill Embeddings (WF6), text-embedding-3-small at 1024 dimensions, one vector per bill. The text is hashed in the database and only a changed hash is embedded. A dry run builds and hashes the texts and calls nothing. ' + NOTE)}, [config], {{ color: 4 }});",
             """export default workflow("v2-pipeline-embeddings", "v2 Pipeline: embeddings")
  .add(start)
  .to(config)
  .to(getCandidates)
  .to(getTaxonomy)
  .to(buildTexts)
  .to(hashTexts)
  .to(requests)
  .to(sendEmbeds.onTrue(embedCall.to(buildEmbeds)).onFalse(buildEmbeds))
  .add(buildEmbeds)
  .to(listPreviews)
  .to(runPreviews)
  .to(report)
  .to(writeEnabled.onTrue(openRun.to(statementsNode).to(writeCore).to(closeRun).to(result)).onFalse(result))
  .add(called)
  .to(config)
  .add(note);"""]
    return '\n'.join(parts)


def statements():
    model = json.loads((HERE / 'wf5' / 'create_impact_statements.json').read_text())
    sysprompt = model['parameters']['responses']['values'][0]['content']
    userprompt = model['parameters']['responses']['values'][1]['content']
    prompt_chars = len(sysprompt) + len(userprompt)
    st = model['settings']
    # The one change from WF5: the raw response, so Build Statements can read
    # the token usage that the cost record and the monthly budget stop need.
    # The raw response has the same `output` array WF5's Parse JSON reads.
    model['parameters'] = dict(model['parameters'], simplify=False)
    model_node = (f"const createStatements = node({{ type: '@n8n/n8n-nodes-langchain.openAi', version: {model['typeVersion']}, config: {{ name: 'Create Impact Statements', "
                  f"retryOnFail: {J(st['retryOnFail'])}, maxTries: {st['maxTries']}, waitBetweenTries: {st['waitBetweenTries']}, alwaysOutputData: {J(st['alwaysOutputData'])}, "
                  f"onError: {J(st['onError'])}, parameters: {obj(model['parameters'])}, credentials: {CRED['openai']} }}, output: [{{}}] }});")
    fetch_versions = ("const fetchVersions = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3, config: { name: 'Fetch Text Versions', retryOnFail: true, maxTries: 3, "
                      "waitBetweenTries: 3000, onError: 'continueRegularOutput', alwaysOutputData: true, parameters: { method: 'GET', url: expr('{{ $json.url }}'), "
                      "authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth', options: { batching: { batch: { batchSize: 5 } }, timeout: 30000, "
                      f"response: {{ response: {{ responseFormat: 'json' }} }} }} }}, credentials: {CRED['congress']} }}, output: [{{}}] }});")
    fetch_summary = ("const fetchSummary = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3, config: { name: 'Fetch Bill Summary', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput', "
                     "parameters: { url: expr('{{ $json.version_fetch_url || $json[\"Bill Status URL\"] }}'), options: { timeout: 30000, response: { response: { responseFormat: 'text' } } } } }, output: [{}] });")
    loop = "const loop = splitInBatches({ version: 3, config: { name: 'Loop Over Items', onError: 'continueRegularOutput', parameters: { options: {} } } });"
    wait = "const waitNode = node({ type: 'n8n-nodes-base.wait', version: 1.1, config: { name: 'Wait', parameters: { amount: 1 } }, output: [{}] });"
    call_model = ("const callModel = ifElse({ version: 2.2, config: { name: 'Call the model?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, "
                  "conditions: [{ leftValue: expr(\"{{ $('Limit').first().json._mode !== 'plan' && !!$('Prepare Bill Context').item.json['Bill ID'] }}\"), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } } });")
    model_mode = ("const modelMode = ifElse({ version: 2.2, config: { name: 'Model was called?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, "
                  "conditions: [{ leftValue: expr(\"{{ $('Limit').first().json._mode !== 'plan' }}\"), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } } });")
    fields = [('dry_run', 'boolean', True), ('statements_mode', 'string', 'plan'), ('sample_size', 'number', 10), ('sample_bills', 'string', ''), ('cap', 'number', 60),
              ('max_pairs', 'number', 100), ('monthly_budget_usd', 'number', 100), ('usd_per_m_input', 'number', 0.75),
              ('usd_per_m_output', 'number', 4.5), ('usd_per_web_search', 'number', 0.01), ('run_label', 'string', '')]
    parts = ["import { workflow, node, trigger, sticky, ifElse, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';",
             triggers([f[0] for f in fields]), config(fields),
             pg('getCandidates', 'Get Candidates', sql('st_candidates.sql'), "{{ [$workflow.name, $('Config').first().json.sample_bills] }}", extra=', executeOnce: true'),
             sheet('getPolicy', 'Get Policy Area', TAXONOMY, 'Policy Area'),
             code('policyCode', 'Policy Area Code Node', wf5('policy_area.js'), helpers=False),
             sheet('getTaxonomy', 'Get Approved Taxonomy', TAXONOMY, 'Approved Taxonomy'),
             code('taxonomyCode', 'Taxonomy Code Node', wf5('taxonomy.js'), helpers=False),
             sheet('getSubjects', 'Get Subject Areas', TAXONOMY, 'Subject Area'),
             code('subjectCode', 'Subject Area Code', wf5('subject_area.js'), helpers=False),
             code('textRequests', 'Text Requests', js('st_text_requests.js'), helpers=False, extra=', executeOnce: true'),
             fetch_versions,
             code('versionRequests', 'Build Version Requests', js('st_versions.js'), extra=', executeOnce: true'),
             code('limitNode', 'Limit', js('st_limit.js').replace("return rows.map(", "if (!rows.length) return [{ json: { _empty: true, _mode: mode, _budget_stop: stopped } }];\nreturn rows.map("), extra=', executeOnce: true'),
             loop,
             code('prepare', 'Prepare Bill Context', wf5('prepare_bill_context.js'), helpers=False),
             fetch_summary,
             code('extract', 'Extract Bill Summary', wf5('extract_bill_summary.js'), helpers=False),
             call_model, model_node, wait,
             model_mode,
             code('parseJson', 'Parse JSON', wf5('parse_json.js'), helpers=False, extra=", onError: 'continueRegularOutput', alwaysOutputData: true"),
             code('flatten', 'Flatten Impact Statements', wf5('flatten_impact_statements.js'), helpers=False, extra=", onError: 'continueRegularOutput', alwaysOutputData: true"),
             code('buildStatements', 'Build Statements', f'const PROMPT_CHARS = {prompt_chars};\n' + js('st_build.js'), extra=', executeOnce: true'),
             tail('Build Statements'),
             f"const note = sticky({J('## v2 pipeline: impact statements' + chr(10) + 'SHIPS IN PLAN MODE. statements_mode: plan builds every bill context and calls no model (the daily mode until cutover); sample sends sample_size bills to the model and writes core.impact_drafts; live writes core.bill_impacts (after cutover only). Prompt, parser and taxonomy gate are WF5 verbatim; the bill-context builder is WF5 except that the text of every bill is fetched and inlined (2026-10-11); per-version requests are WF5b. Cap 60 bill-level and max_pairs versions a run; monthly_budget_usd stops sample and live. Statements written with no published text are marked title_only and redone when the text appears. ' + NOTE)}, [config], {{ color: 4 }});",
             """export default workflow("v2-pipeline-impact-statements", "v2 Pipeline: impact statements")
  .add(start)
  .to(config)
  .to(getCandidates)
  .to(getPolicy)
  .to(policyCode)
  .to(getTaxonomy)
  .to(taxonomyCode)
  .to(getSubjects)
  .to(subjectCode)
  .to(textRequests)
  .to(fetchVersions)
  .to(versionRequests)
  .to(limitNode)
  .to(loop
    .onDone(modelMode.onTrue(parseJson.to(flatten).to(buildStatements)).onFalse(buildStatements))
    .onEachBatch(prepare.to(fetchSummary).to(extract).to(callModel.onTrue(createStatements.to(waitNode).to(nextBatch(loop))).onFalse(nextBatch(loop)))))
  .add(buildStatements)
  .to(listPreviews)
  .to(runPreviews)
  .to(report)
  .to(writeEnabled.onTrue(openRun.to(statementsNode).to(writeCore).to(closeRun).to(result)).onFalse(result))
  .add(called)
  .to(config)
  .add(note);"""]
    return '\n'.join(parts)


def call(var, name, wid, inputs, disabled=False):
    """Execute a v2 sub-workflow and wait for it. inputs: {name: expression}.
    A disabled node passes its input straight through to the next one."""
    schema = ', '.join(f"{{ id: {J(k)}, displayName: {J(k)}, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false }}" for k in inputs)
    vals = ', '.join(f"{J(k)}: {J(v)}" for k, v in inputs.items())
    return (f"const {var} = node({{ type: 'n8n-nodes-base.executeWorkflow', version: 1.2, config: {{ name: {J(name)}, " + ("disabled: true, " if disabled else "") + f"parameters: {{ source: 'database', "
            f"workflowId: {{ __rl: true, mode: 'id', value: {J(wid)} }}, workflowInputs: {{ mappingMode: 'defineBelow', value: {{ {vals} }}, matchingColumns: [], "
            f"schema: [{schema}], attemptToConvertTypes: false, convertFieldsToString: true }}, options: {{ waitForSubWorkflow: true }} }} }}, output: [{{}}] }});")


def orchestrator(ids):
    # A string: the inputs are typed string, and each sub-workflow's Config reads 'false'.
    dry = "={{ String($('Config').first().json.dry_run) }}"
    fields = [('dry_run', 'boolean', True), ('compare_members', 'string', 'S000148,T000250')]
    cfg_node = (
        "const config = node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Config', executeOnce: true, parameters: { mode: 'manual', includeOtherFields: false, "
        "assignments: { assignments: ["
        # The schedule writes; a manual start is a dry run of every step.
        "{ id: 'cfg-dry_run', name: 'dry_run', value: \"={{ !$('Daily 07:00 Pacific').isExecuted }}\", type: 'boolean' }, "
        "{ id: 'cfg-members', name: 'compare_members', value: 'S000148,T000250', type: 'string' }, "
        "{ id: 'cfg-weekly', name: 'members_day', value: \"={{ $now.setZone('America/Los_Angeles').weekday === 1 }}\", type: 'boolean' }"
        "] }, options: {} } }, output: [{ dry_run: true }] });")
    weekly = ("const weekly = ifElse({ version: 2.2, config: { name: 'Monday?', executeOnce: true, parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, "
              "conditions: [{ leftValue: expr(\"{{ $('Config').first().json.members_day }}\"), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } } });")
    parts = ["import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';",
             "const schedule = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, config: { name: 'Daily 07:00 Pacific', parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 0 }] } } }, output: [{}] });",
             "const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start (dry run)' }, output: [{}] });",
             cfg_node,
             call('rollCalls', 'Roll calls', ids['rollcalls'], {'dry_run': dry}),
             call('sponsorships', 'Sponsorships and bills', ids['sponsorships'], {'dry_run': dry}),
             # Cutover, 12 Oct 2026: v2 writes the statements; the copy from the Sheets is off.
             call('copyStatements', 'Statement copy', ids['copy'], {'dry_run': dry}, disabled=True),
             call('statements', 'Impact statements (live)', ids['statements'], {'dry_run': dry, 'statements_mode': 'live'}),
             call('embeddings', 'Embeddings', ids['embeddings'], {'dry_run': dry}),
             weekly,
             call('members', 'Members (Mondays)', ids['members'], {'dry_run': dry}),
             pg('readCore', 'Read core', sql('compare_core.sql'), "{{ [$('Config').first().json.compare_members] }}", extra=', executeOnce: true, alwaysOutputData: true'),
             sheet('readActions', 'Read Bill Actions', MASTER, ' Politician Bill Actions'),
             sheet('readBills', 'Read Bills Master', MASTER, 'Bills Master'),
             sheet('readVotes', 'Read Roll Call Votes', MASTER, 'Roll Call Votes'),
             code('compareNode', 'Compare with Sheets', js('compare.js'), extra=', executeOnce: true'),
             tail('Compare with Sheets'),
             f"const note = sticky({J('## v2 pipeline: orchestrator' + chr(10) + 'Daily at 07:00 Pacific, an hour after the old orchestrator. Runs roll calls, sponsorships and bills, the statement copy (parallel run only), impact statements in PLAN mode (no model calls), embeddings, members on Mondays, then compares core with the Sheets for Schumer and Thune (gate G4) and records the result in core.ingest_runs. A manual start is a dry run of every step. A failure stops the run and emails Matt.')}, [config], {{ color: 4 }});",
             """export default workflow("v2-pipeline-orchestrator", "v2 Pipeline: orchestrator (daily 07:00 Pacific)")
  .add(schedule)
  .to(config)
  .to(rollCalls)
  .to(sponsorships)
  .to(copyStatements)
  .to(statements)
  .to(embeddings)
  .to(weekly.onTrue(members.to(readCore)).onFalse(readCore))
  .add(readCore)
  .to(readActions)
  .to(readBills)
  .to(readVotes)
  .to(compareNode)
  .to(listPreviews)
  .to(runPreviews)
  .to(report)
  .to(writeEnabled.onTrue(openRun.to(statementsNode).to(writeCore).to(closeRun).to(result)).onFalse(result))
  .add(start)
  .to(config)
  .add(note);"""]
    return '\n'.join(parts)


def alert():
    body = ("={{ (() => { const e = $json.execution || {}; const w = $json.workflow || {}; const err = e.error || {}; "
            "return '<p><b>' + (w.name || 'A v2 workflow') + '</b> failed.</p>' + "
            "'<p>' + String(err.message || 'no message').replace(/</g, '&lt;') + '</p>' + "
            "'<p>Node: ' + (e.lastNodeExecuted || 'unknown') + '<br>Execution: <a href=\"' + (e.url || '') + '\">' + (e.id || '') + '</a><br>Mode: ' + (e.mode || '') + '</p>' + "
            "'<p>Nothing the live tool reads comes from these workflows until cutover.</p>'; })() }}")
    subject = "={{ '[Receipts v2] ' + ($json.workflow && $json.workflow.name || 'workflow') + ' failed' }}"
    log_sql = ("INSERT INTO core.ingest_runs (workflow, execution_id, finished_at, status, errors, notes) "
               "VALUES ($1, $2, now(), 'failed', $3::jsonb, 'failure alert');")
    return '\n'.join([
        "import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';",
        "const onError = trigger({ type: 'n8n-nodes-base.errorTrigger', version: 1, config: { name: 'When a v2 Workflow Fails' }, output: [{}] });",
        (f"const email = node({{ type: 'n8n-nodes-base.gmail', version: 2.2, config: {{ name: 'Email Matt', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput', "
         f"parameters: {{ resource: 'message', operation: 'send', sendTo: 'matthewtyler1986@gmail.com', subject: {J(subject)}, emailType: 'html', message: {J(body)}, "
         f"options: {{ appendAttribution: false }} }}, credentials: {CRED['gmail']} }}, output: [{{}}] }});"),
        pg('logFailure', 'Log Failure', log_sql,
           "{{ [ ($('When a v2 Workflow Fails').first().json.workflow || {}).name || 'unknown', String(($('When a v2 Workflow Fails').first().json.execution || {}).id || ''), "
           "JSON.stringify([{ message: (($('When a v2 Workflow Fails').first().json.execution || {}).error || {}).message || null, node: ($('When a v2 Workflow Fails').first().json.execution || {}).lastNodeExecuted || null, url: ($('When a v2 Workflow Fails').first().json.execution || {}).url || null }]) ] }}"),
        f"const note = sticky({J('## v2 pipeline: failure alert' + chr(10) + 'Set as the error workflow of every v2 pipeline workflow. Emails Matt with the workflow, the error, the node and a link to the execution, and records the failure in core.ingest_runs. Uses the Gmail account credential, which must be shared with this project.')}, [onError], {{ color: 4 }});",
        """export default workflow("v2-pipeline-alert", "v2 Pipeline: failure alert")
  .add(onError)
  .to(email)
  .to(logFailure)
  .add(note);""",
    ])


WORKFLOWS = {'members': members, 'rollcalls': rollcalls, 'sponsorships': sponsorships, 'copy': copy_statements, 'embeddings': embeddings, 'statements': statements, 'alert': alert,
             'orchestrator': lambda: orchestrator(json.loads((HERE / 'ids.json').read_text()))}

if __name__ == '__main__':
    name = sys.argv[1]
    out = WORKFLOWS[name]()
    (HERE / 'out').mkdir(exist_ok=True)
    (HERE / 'out' / f'{name}.sdk.ts').write_text(out)
    print(len(out))

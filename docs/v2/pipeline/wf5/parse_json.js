// ============================================
// PARSE OPENAI IMPACT STATEMENT RESPONSE v5
// Bill identity is paired BY INDEX against the single-run Limit node.
// $('Loop Over Items').item does NOT pair across the OpenAI/Wait/loop
// accumulation (returns empty), so we cannot trust it or the model's
// echoed bill_id/title. Limit holds every bill that entered the loop,
// in order, so items[idx] <-> $('Limit').all()[idx].
//
// VERSION PASSTHROUGH (added 2026-09-19). A versioned request (WF5c) tags the
// Limit row with requested_* fields; they are carried onto the parsed item so
// Flatten can key the row by bill|version and route it to the Versions tab.
// The summary actionDate actually used comes from Extract Bill Summary's run
// for the same loop index: $('Extract Bill Summary').all(0, idx).
// ============================================
const items = $input.all();
const loopBills = $('Limit').all();
const pairingReliable = loopBills.length === items.length;
if (!pairingReliable) {
  console.log(`WARNING: pairing mismatch — ${items.length} outputs vs ${loopBills.length} bills. bill_id/congress may be misaligned; rows flagged for review.`);
}

const summaryDateForRun = (idx) => {
  try {
    const runItems = $('Extract Bill Summary').all(0, idx);
    const e = runItems && runItems[0] ? runItems[0].json : null;
    return e ? String(e.bill_summary_action_date || '') : '';
  } catch (err) {
    return '';
  }
};

const results = [];

for (let idx = 0; idx < items.length; idx++) {
  const item = items[idx];
  const response = item.json;
  const outputs = response.output || [];

  // Canonical bill identity from the input row (system of record), paired by index.
  const inputItem = (loopBills[idx] && loopBills[idx].json) || {};
  const fallbackBillId = inputItem['Bill ID'] || null;
  const fallbackTitle  = inputItem['Official Title'] || null;
  const versionFields = {
    requested_version:      String(inputItem.requested_version || ''),
    requested_version_type: String(inputItem.requested_version_type || ''),
    requested_version_date: String(inputItem.requested_version_date || ''),
    requested_text_url:     String(inputItem.requested_text_url || ''),
    summary_action_date:    summaryDateForRun(idx)
  };

  // Find the message output with text content
  let rawText = null;

  for (const output of outputs) {
    if (output.type === 'message' && output.content) {
      const textBlock = output.content.find(block => block.type === 'output_text');
      if (textBlock && textBlock.text) {
        rawText = textBlock.text.trim();
        break;
      }
    }
  }

  if (!rawText) {
    results.push({
      json: {
        error:           'no_output_text',
        error_message:   'No output_text block found in API response',
        bill_id:         fallbackBillId,
        title:           fallbackTitle,
        flag_for_review: true,
        raw_response:    JSON.stringify(response).substring(0, 500),
        ...versionFields
      }
    });
    continue;
  }

  // Strip code fences if model ignored instructions
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed = null;

  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    results.push({
      json: {
        error:           'json_parse_failed',
        error_message:   error.message,
        bill_id:         fallbackBillId,
        title:           fallbackTitle,
        flag_for_review: true,
        raw_text:        rawText.substring(0, 1000),
        ...versionFields
      }
    });
    continue;
  }

  // Normalize schema — handle both correct nested structure
  // and the flat structure the model sometimes returns incorrectly
  let impactStatement = null;
  let schemaNormalized = false;

  if (parsed.impact_statement && typeof parsed.impact_statement === 'object') {
    // Correct nested structure
    impactStatement = parsed.impact_statement;
  } else if (parsed.issue_primary || parsed.policy_area_raw || parsed.policy_area) {
    // Model returned flat structure — normalize it
    schemaNormalized = true;
    impactStatement = {
      policy_area_raw:       parsed.policy_area_raw || parsed.policy_area || null,
      issue_primary:         parsed.issue_primary || null,
      issue_sub:             parsed.issue_sub || null,
      intended_effects:      parsed.intended_effects || [],
      affected_stakeholders: parsed.affected_stakeholders || [],
      mechanisms:            parsed.mechanisms || [],
      neutral_summary:       parsed.neutral_summary || null,
      classification_note:   parsed.classification_note || '',
      regulatory_action:     parsed.regulatory_action || null,
      bill_keywords:         parsed.bill_keywords || []
    };
  } else {
    results.push({
      json: {
        error:           'unrecognized_schema',
        error_message:   'Parsed JSON does not match expected schema — missing impact_statement and known flat fields',
        bill_id:         fallbackBillId,
        title:           fallbackTitle,
        flag_for_review: true,
        raw_text:        rawText.substring(0, 1000),
        ...versionFields
      }
    });
    continue;
  }

  // Normalize affected_stakeholders — model sometimes returns flat strings
  // instead of objects with group/positive_impact/negative_impact
  if (Array.isArray(impactStatement.affected_stakeholders)) {
    impactStatement.affected_stakeholders = impactStatement.affected_stakeholders.map(s => {
      if (typeof s === 'string') {
        return {
          group:           s,
          positive_impact: ['none identified'],
          negative_impact: ['none identified']
        };
      }
      // Ensure both impact arrays exist even if model omitted one
      return {
        group:           s.group || s.name || 'Unknown group',
        positive_impact: s.positive_impact || ['none identified'],
        negative_impact: s.negative_impact || ['none identified']
      };
    });
  }

  // Normalize bill_keywords — model may return array of strings or a
  // comma-separated string if it ignored the array format instruction
  let billKeywords = impactStatement.bill_keywords || [];
  if (typeof billKeywords === 'string') {
    // Comma-separated fallback — split and clean
    billKeywords = billKeywords
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0 && k.length < 60);
  } else if (Array.isArray(billKeywords)) {
    billKeywords = billKeywords
      .map(k => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
      .filter(k => k.length > 0 && k.length < 60);
  } else {
    billKeywords = [];
  }
  impactStatement.bill_keywords = billKeywords;

  // ---- OUTPUT HYGIENE GUARD (added 2026-09-19) ----
  // Web search is enabled on Create Impact Statements, scoped by prompt to the
  // bill's EXTERNAL TARGET only (a Federal Register rule, a public law). Two
  // observed failure modes are caught here rather than trusted to instruction:
  //
  // 1. VERSION SUBSTITUTION. On run 13865 the model was handed sjres7-119's
  //    INTRODUCED url and returned a summary citing BILLS-119sjres7es.pdf - it
  //    described the engrossed text under the introduced label. That silently
  //    corrupts the whole versions tab, because the row looks correct. Any
  //    BILLS-<congress><type><num><code> reference in the response whose code
  //    is not the requested one sets source_version_mismatch and flags the row.
  //
  // 2. CITATION LEAKAGE. The same response left a markdown link with
  //    ?utm_source=openai inside neutral_summary - a field published as neutral
  //    prose. All links and bare urls are stripped from the text fields.
  //
  // Stripping is safe: no downstream consumer wants a url in these fields. The
  // mismatch flag is NOT auto-corrected - it is recorded so the row can be
  // regenerated, because we cannot know which version the prose describes.
  const URL_RE = /\bhttps?:\/\/[^\s)\]"']+/gi;
  const MD_LINK_RE = /\[([^\]]*)\]\(\s*https?:\/\/[^\s)]+\s*\)/gi;
  const BILLS_RE = /BILLS-\d+[a-z]+\d+([a-z]+)\.(?:htm|html|pdf|xml)/gi;

  const scrub = (v) => {
    if (typeof v !== 'string') return v;
    return v
      .replace(MD_LINK_RE, '$1')
      .replace(URL_RE, '')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  const requestedCode = String(versionFields.requested_version || '').toLowerCase();
  const citedCodes = [];
  let m;
  BILLS_RE.lastIndex = 0;
  while ((m = BILLS_RE.exec(rawText)) !== null) citedCodes.push(m[1].toLowerCase());
  const uniqueCited = Array.from(new Set(citedCodes));
  const versionMismatch = requestedCode
    ? uniqueCited.some(c => c !== requestedCode)
    : uniqueCited.length > 0;
  if (versionMismatch) {
    console.log('[WF5] VERSION MISMATCH ' + (fallbackBillId || '(no bill)') +
      ': requested ' + (requestedCode || '(none)') + ', response cited ' + uniqueCited.join(', ') +
      ' - row flagged, prose may describe a different text version');
  }

  impactStatement.neutral_summary = scrub(impactStatement.neutral_summary);
  impactStatement.classification_note = scrub(impactStatement.classification_note);
  if (Array.isArray(impactStatement.intended_effects)) {
    impactStatement.intended_effects = impactStatement.intended_effects.map(scrub);
  }
  if (Array.isArray(impactStatement.mechanisms)) {
    impactStatement.mechanisms = impactStatement.mechanisms.map(scrub);
  }
  if (Array.isArray(impactStatement.affected_stakeholders)) {
    impactStatement.affected_stakeholders = impactStatement.affected_stakeholders.map(s => ({
      group: scrub(s.group),
      positive_impact: (s.positive_impact || []).map(scrub),
      negative_impact: (s.negative_impact || []).map(scrub)
    }));
  }

  // Validate required fields
  const missingFields = [];
  const required = [
    'policy_area_raw',
    'issue_primary',
    'issue_sub',
    'intended_effects',
    'affected_stakeholders',
    'mechanisms',
    'neutral_summary',
    'bill_keywords'
  ];
  for (const field of required) {
    const val = impactStatement[field];
    if (!val || (Array.isArray(val) && val.length === 0)) {
      missingFields.push(field);
    }
  }

  // Validate taxonomy pair
  const taxonomyValid = !!(impactStatement.issue_primary && impactStatement.issue_sub);

  // Validate keyword quality — flag if fewer than 4 keywords or if any
  // generic forbidden terms slipped through
  // Observed offenders added 2026-09-19 from the first versions backfill:
  // category-level nouns that name a whole policy domain rather than this
  // bill, and procedural filler that matches every bill in the corpus. A
  // keyword is a retrieval key - a generic one pulls the bill into matches
  // for promises it has nothing to do with.
  const forbiddenKeywords = new Set([
    'healthcare', 'federal legislation', 'public policy', 'congress',
    'legislation', 'federal funding', 'public health', 'government',
    'united states', 'bill', 'act', 'law', 'policy',
    'appropriations', 'federal budget', 'federal spending', 'funding',
    'immigration', 'immigration process', 'immigration reform',
    'eligibility requirements', 'regulations', 'federal regulations',
    'agency rule', 'rulemaking', 'oversight', 'reform', 'tax', 'taxes',
    'defense', 'national security', 'education', 'environment', 'trade',
    'transportation', 'housing', 'energy', 'infrastructure', 'veterans',
    'federal agencies', 'federal programs', 'program funding',
    'specified countries', 'safety measures', 'compliance'
  ]);
  const keywordsValid = billKeywords.length >= 4 &&
    !billKeywords.some(k => forbiddenKeywords.has(k));

  // REGULATORY ACTION — defensive default so downstream never sees undefined.
  // Most bills are not reversals and the model may omit the block entirely;
  // an absent block means "not a reversal", which is the same as the default.
  // UNKNOWN direction is the EXPECTED outcome for agency rules - WF5 is given
  // the disapproval resolution, not the regulation it nullifies. Never treat
  // UNKNOWN as an error; a guessed direction is far worse than a blank.
  const ra = impactStatement.regulatory_action || {};
  const RA_TYPES = ['AGENCY_RULE','STATUTE','EXECUTIVE_ACTION','APPROPRIATION','PROGRAM','NONE'];
  const raStr = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const targetType = RA_TYPES.includes(raStr(ra.target_type).toUpperCase())
    ? raStr(ra.target_type).toUpperCase() : 'NONE';
  const reverses = ra.reverses_existing_policy === true
    || raStr(ra.reverses_existing_policy).toUpperCase() === 'TRUE'
    || (targetType !== 'NONE' && targetType !== '');

  // target_direction removed: RESTRICTS/EXPANDS needs a referent (restricts
  // WHOM) that only the promise supplies. 7 of 12 stated directions in the
  // first backfill batch contradicted their own target_effect sentence.
  const naOr = (v) => (raStr(v) === '' ? 'N/A' : raStr(v));
  const targetEffect = raStr(ra.target_effect);
  const rawConf = parseFloat(ra.effect_confidence);
  const effectConfidence = targetEffect === ''
    ? 0 : (Number.isFinite(rawConf) ? rawConf : 0.6);

  impactStatement.regulatory_action = {
    reverses_existing_policy: reverses,
    target_type: targetType,
    target_name: naOr(ra.target_name),
    target_source: naOr(ra.target_source),
    target_direction: 'N/A',
    target_effect: scrub(naOr(targetEffect)),
    direction_confidence: effectConfidence,
    effect_missing: reverses && targetEffect === ''
  };

  // Resolve bill_id and title — INPUT (index-paired) is authoritative.
  // Only fall back to the model's echo if the input row is somehow missing.
  const resolvedBillId = fallbackBillId || parsed.bill_id;
  const resolvedTitle  = fallbackTitle  || parsed.title;

  // VERSION TITLE (revised 2026-09-20). Read deterministically by WF5c from the
  // version's own text and passed in as requested_version_title. Asking the
  // model for it did not work: on run 13883 it returned the bill's CURRENT
  // Official Title for all four s1071-119 versions - including the introduced
  // text, a VA disinterment measure that only became the NDAA eight months
  // later - and bare document headers ("S. 836 IS") for s836-119. The model's
  // answer is still accepted as a second fallback, then the canonical title.
  const versionTitle = versionFields.requested_version
    ? (String(inputItem.requested_version_title || '').trim()
       || String(parsed.version_title || '').trim()
       || resolvedTitle)
    : '';

  // Derive congress from the canonical bill_id (format: {type}{number}-{congress}).
  const congressParsed   = resolvedBillId ? parseInt(String(resolvedBillId).split('-').pop(), 10) : NaN;
  const resolvedCongress = Number.isNaN(congressParsed) ? null : congressParsed;

  results.push({
    json: {
      bill_id:          resolvedBillId,
      congress:         resolvedCongress,
      title:            resolvedTitle,
      impact_statement: impactStatement,
      // Audit fields
      schema_normalized:  schemaNormalized,
      missing_fields:     missingFields,
      keywords_valid:     keywordsValid,
      keywords_count:     billKeywords.length,
      pairing_reliable:   pairingReliable,
      flag_for_review:    missingFields.length > 0 || !taxonomyValid || !keywordsValid || !pairingReliable || versionMismatch,
      taxonomy_valid:     taxonomyValid,
      regulatory_action:  impactStatement.regulatory_action,
      is_reversal_bill:   impactStatement.regulatory_action.reverses_existing_policy,
      source_version_mismatch: versionMismatch,
      version_title:           versionTitle,
      version_title_source:    versionFields.requested_version
        ? (String(inputItem.requested_version_title || '').trim() ? 'TEXT'
           : (String(parsed.version_title || '').trim() ? 'MODEL' : 'CANONICAL'))
        : 'NA',
      cited_version_codes:     uniqueCited.join('; '),
      ...versionFields
    }
  });
}

if (results.length === 0) {
  throw new Error('No items processed. Check API response structure.');
}

const flagged    = results.filter(r => r.json.flag_for_review).length;
const normalized = results.filter(r => r.json.schema_normalized).length;
const badKeywords = results.filter(r => r.json.keywords_valid === false).length;
const reversals = results.filter(r => r.json.is_reversal_bill).length;
const unknownDir = results.filter(r => r.json.is_reversal_bill && r.json.regulatory_action?.target_direction === 'UNKNOWN').length;
const downgraded = results.filter(r => r.json.regulatory_action?.direction_downgraded).length;
const versioned = results.filter(r => r.json.requested_version).length;
const mismatched = results.filter(r => r.json.source_version_mismatch).length;
const titleFromText = results.filter(r => r.json.version_title_source === 'TEXT').length;
console.log(`Parsed: ${results.length} | Flagged for review: ${flagged} | Schema normalized: ${normalized} | Bad keywords: ${badKeywords} | Versioned: ${versioned} | Version mismatch: ${mismatched} | Version title from text: ${titleFromText}`);
console.log(`Reversal bills: ${reversals} | direction UNKNOWN: ${unknownDir} | direction downgraded (stated without basis): ${downgraded}`);

return results;

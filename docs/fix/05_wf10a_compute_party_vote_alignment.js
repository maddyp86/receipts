// ===================================================================
// COMPUTE PARTY VOTE ALIGNMENT (WHIP-AWARE, LEADER-AWARE)  — full replacement
// ===================================================================
// Party Whip Vote = the party whip's actual vote on the roll call
// (whip-of-record proxy: Thune 118th, Barrasso 119th; Durbin for D).
// Whip vote must be Yea/Nay to define a party position:
//   - whip missing OR whip 'Not Voting' -> NA (no fabricated signal)
// Sponsorship-only rows (senator Vote = NA, no roll call) -> NA
//
// 2026-09-05 — LEADER_SWITCH ADDED.
// The existing PROCEDURAL branch covers a sponsor who votes NAY. It does not
// cover the far more common Rule XIII case: the FLOOR LEADER votes NAY on a
// cloture that is failing, while the whip votes YEA, so the leader can move to
// reconsider. Audit of 79 BROKE rows found 15 of these (Thune on his own FY27
// NDAA motion to proceed x12, Thune on the Oct 2025 DoD approps cloture,
// Schumer on S.326-118 cloture x2). All were labelled CROSS_PARTY - the
// highest-magnitude band in the scoring model - and all were substantively
// false. Both MVP senators are floor leaders, so this artifact hits this corpus
// harder than it would any other pair.
//
// Detection here is whip-based only (leader NAY vs whip YEA). The cloture
// outcome check lives in Pre-Evaluator Gates, which has the roll call result;
// this node only needs to stop calling it CROSS_PARTY.
// ===================================================================

const S = (v) => (v === null || v === undefined ? '' : String(v).trim());

const normalizeVote = (v) => {
  if (!v) return 'NA';
  const n = String(v).toLowerCase().trim();
  if (['yea', 'yes', 'aye'].includes(n)) return 'Yea';
  if (['nay', 'no'].includes(n)) return 'Nay';
  if (n.includes('not')) return 'NOT_VOTED';
  return 'NA';
};
const truthy = (v) => ['TRUE', 'YES', 'Y', '1'].includes(S(v).toUpperCase());
const congressOf = (billId) => { const m = S(billId).match(/-(\d{3})$/); return m ? m[1] : ''; };

// Fallback only — prefer a 'Role' column on the Politicians tab
// ("MAJORITY_LEADER:119;MINORITY_LEADER:118").
const FLOOR_LEADERS_FALLBACK = {
  '118': { S000148: 'MAJORITY_LEADER', M000355: 'MINORITY_LEADER' },
  '119': { T000250: 'MAJORITY_LEADER', S000148: 'MINORITY_LEADER' }
};
let politicianRole = '';
try { politicianRole = S(($('Get Politician').first().json || {})['Role']); } catch (e) {}
const roleAt = (pol, congress) => {
  if (politicianRole) {
    for (const part of politicianRole.split(';')) {
      const [r, c] = part.split(':').map(S);
      if (c === congress && r) return r.toUpperCase();
    }
  }
  return (FLOOR_LEADERS_FALLBACK[congress] || {})[pol] || 'NONE';
};

const matches = $input.all();
const tally = {};

const out = matches.map(item => {
  const data = item.json;

  const senatorVote       = normalizeVote(data.Vote || data.vote);
  const clotureVote       = normalizeVote(data['Cloture Vote']);
  const passageVote       = normalizeVote(data['Passage Vote']);
  const partyMajorityVote = normalizeVote(data['Party Whip Vote']);

  const sponsored = truthy(data['Is Sponsor'] || data.is_sponsor) ||
                    truthy(data['Is Co-Sponsor'] || data.is_cosponsor);
  const anyNay = [senatorVote, clotureVote, passageVote].includes('Nay');

  const pol = S(data['Politician ID'] || data.politician_id);
  const congress = congressOf(data['Bill ID'] || data.bill_id);
  const role = roleAt(pol, congress);

  let partyAlignment = 'NA';

  if (sponsored && anyNay) {
    // Sponsor voting NAY: Rule XIII maneuver on their own bill.
    partyAlignment = 'PROCEDURAL';
  } else if (role !== 'NONE' && clotureVote === 'Nay' && partyMajorityVote === 'Yea') {
    // Floor leader voting NAY on cloture against their own whip: reconsideration
    // switch. NOT cross-party. Evaluator verdict is set by Pre-Evaluator Gates.
    partyAlignment = 'LEADER_SWITCH';
  } else if (senatorVote === 'NA') {
    partyAlignment = 'NA';
  } else if (senatorVote === 'NOT_VOTED') {
    partyAlignment = 'NOT_VOTED';
  } else if (partyMajorityVote !== 'Yea' && partyMajorityVote !== 'Nay') {
    partyAlignment = 'NA';
  } else if (senatorVote === partyMajorityVote) {
    partyAlignment = 'WITH_PARTY';
  } else {
    partyAlignment = 'CROSS_PARTY';
  }

  tally[partyAlignment] = (tally[partyAlignment] || 0) + 1;

  return { json: { ...data, 'Party Alignment': partyAlignment, 'Senator Role': role } };
});

console.log('[PARTY] ' + matches.length + ' rows -> ' + JSON.stringify(tally));
return out;

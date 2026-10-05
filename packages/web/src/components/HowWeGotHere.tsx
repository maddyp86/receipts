import {
  BAND_PHRASE,
  ND_NO_REASON_COPY,
  ND_REASON_COPY,
  coverageSpanPhrase,
  judgeDispositionSentence,
  outcomeHeadline,
  type QueryResult,
} from '@receipts/shared';

// ===========================================================================
// How we got here — the path from the reader's statement to the verdict, in
// plain language, one step per gate.
//
// Every sentence is derived from fields already on the result. Nothing here is
// model prose and nothing is computed: it is the same facts the analyst trace
// shows as numbers, read out in order. The analyst trace stays one level
// further down for anyone who wants the raw values.
//
// The rule the copy keeps: a step that did not run says so ("we could not run
// this check"), and a leg that was not needed is never described as passed.
// ===========================================================================

const STANCE_PHRASE: Record<string, string> = {
  'In Favor': 'you want this to happen',
  Opposed: 'you want to stop this',
  'Neutral/Unclear': 'it is not clear which way you lean',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function HowWeGotHere({ result }: { result: QueryResult }) {
  const { senator, interpretation, scored, coverage, search, gated, judge } = result;
  const { receipt } = scored;
  const surname = senator.name.split(' ').pop() ?? senator.name;
  const span = coverage ? coverageSpanPhrase(coverage) : null;
  const gatedCount = gated?.length ?? 0;

  const steps: Array<{ title: string; body: string }> = [];

  // 1. What we understood.
  steps.push({
    title: 'What we understood',
    body:
      `We read your statement as being about ${interpretation.primary_issue || 'this subject'}` +
      (interpretation.sub_issue ? `, specifically ${interpretation.sub_issue}` : '') +
      `, and that ${STANCE_PHRASE[interpretation.stance] ?? 'it is not clear which way you lean'}. ` +
      `In short: “${interpretation.restated.replace(/[.。]\s*$/, '')}.”`,
  });

  // 2. What we searched.
  if (search) {
    const found =
      search.returned === null
        ? `found ${plural(search.evaluated, 'bill or vote', 'bills and votes')} on this subject`
        : `found ${plural(search.returned, 'bill or vote', 'bills and votes')} on this subject` +
          (search.below_floor
            ? `, ${search.below_floor} of which ${search.below_floor === 1 ? 'was' : 'were'} not close enough to consider`
            : '');
    steps.push({
      title: `What we searched`,
      body:
        `We searched ${surname}’s analyzed record` +
        (span ? ` — ${span} —` : '') +
        ` and ${found}.`,
    });

    // 3. Which of them bear on it.
    steps.push({
      title: 'Which ones actually bear on what you said',
      body: search.relevance_applied
        ? `We checked each one for whether it is really about your statement, not just the same general subject. ` +
          `${search.admitted === search.evaluated ? 'All' : search.admitted} of ${search.evaluated} ${search.admitted === 1 ? 'was' : 'were'} close enough to count.` +
          (search.exclusions.length ? ` ${search.exclusions.join(' ')}` : '')
        : `We could not run the check that separates bills about your statement from bills on the same general subject, so all ${search.evaluated} passed through unchecked.`,
    });
  }

  // 4. Gated before weighing.
  if (gatedCount) {
    steps.push({
      title: 'Set aside before weighing',
      body:
        `${plural(gatedCount, 'bill')} ${gatedCount === 1 ? 'was' : 'were'} set aside before being weighed — ` +
        `a rule decided ${gatedCount === 1 ? 'it' : 'they'} could not bear on this statement either way. ` +
        `${gatedCount === 1 ? 'It is' : 'They are'} listed under “Found, but not evaluated” with the reason.`,
    });
  }

  // 5. Direction on the goal — of each BILL, as the evaluator read it.
  //
  // Counted from each row's bill_effect, never from direction_split. Direction
  // is the senator's alignment (a no vote on a bill that sets the goal back
  // "keeps"), so reading it here said a bill moved the goal forward when the
  // evaluator read it as setting it back. And every undirected row — an
  // unread bill, an abstention, a contested reading — was described as "about
  // something else", contradicting the reason given in step 7.
  if (scored.verdict !== 'NOT_DETERMINABLE' || receipt.match_count > 0) {
    const count = (effect: string) =>
      scored.evidence.filter((e) => String(e.bill_effect ?? '').toUpperCase() === effect).length;
    const advance = count('ADVANCE');
    const hinder = count('HINDER');
    const neutral = count('NEUTRAL');
    const contested = count('CONTESTED');
    const unread = scored.evidence.length - advance - hinder - neutral - contested;
    const parts: string[] = [];
    if (advance) parts.push(`${advance} would move your goal forward`);
    if (hinder) parts.push(`${hinder} would set it back`);
    if (neutral) parts.push(`${neutral} ${neutral === 1 ? 'does' : 'do'} not move it either way`);
    if (contested) {
      parts.push(
        `${contested} could reasonably be read either way, so ${contested === 1 ? 'it is' : 'they are'} not counted in either direction`,
      );
    }
    if (unread) parts.push(`${unread} could not be read against your statement`);
    const belowFloor = search ? search.admitted - receipt.match_count : 0;
    steps.push({
      title: 'Which way each bill pushes your goal',
      body:
        `For each bill that counted, we asked whether passing it would move the goal in your statement forward or set it back. ` +
        (parts.length ? `As we read them: ${parts.join('; ')}.` : 'None carried a direction.') +
        (belowFloor > 0
          ? ` ${plural(belowFloor, 'bill')} ${belowFloor === 1 ? 'was' : 'were'} related but not close enough to weigh.`
          : ''),
    });

    // 6. What the senator did.
    const votes = receipt.evidence_mix.vote;
    const sponsorships = receipt.evidence_mix.sponsorship;
    steps.push({
      title: `What ${surname} did`,
      body:
        votes === 0 && sponsorships > 0
          ? `Every action that counts is a sponsorship — ${surname} put ${sponsorships === 1 ? 'their name on the bill' : `their name on ${sponsorships} bills`} — and none came to a recorded vote. Sponsorship is weaker evidence than a vote.`
          : `We then looked at what ${surname} actually did: ${plural(votes, 'recorded vote')} and ${plural(sponsorships, 'sponsorship')}. The cards below say what each one was.`,
    });
  }

  // 7. Adding it up.
  if (scored.verdict === 'NOT_DETERMINABLE') {
    steps.push({
      title: 'Adding it up',
      body: scored.nd_reason ? ND_REASON_COPY[scored.nd_reason] : ND_NO_REASON_COPY,
    });
  } else {
    const { keeps, breaks } = receipt.direction_split;
    const agreement =
      scored.mode === 'ranked'
        ? `The evidence points both ways — ${keeps} one way, ${breaks} the other — so we show both sides below rather than averaging them.`
        : `Everything that counts points the same way.`;
    steps.push({
      title: 'Adding it up',
      body:
        `${agreement} That gives: ${outcomeHeadline(scored.verdict, interpretation.statement_type, interpretation.provenance).toLowerCase()}` +
        (scored.band ? ` — ${BAND_PHRASE[scored.band]}.` : '.'),
    });
  }

  // 8. The second look.
  const judgeSentence = judgeDispositionSentence(judge?.disposition);
  // An accusation withheld by a rule before review is still an accusation that
  // was reached; "this reading does not accuse" would be false of it. The
  // breaking rows stay on the result, so they are what tells.
  const withheldBeforeReview =
    scored.verdict === 'NOT_DETERMINABLE' && scored.evidence.some((e) => e.direction === 'breaks');
  steps.push({
    title: 'A second look',
    body: judge
      ? (judgeSentence ?? 'A second, adversarial review was attempted on this reading.')
      : withheldBeforeReview
        ? 'A second, adversarial review runs when a reading accuses the senator of going against what they said. This one was withheld by the rule above before it got that far, so none ran.'
        : 'A second, adversarial review runs only when a reading accuses the senator of going against what they said. This reading does not, so none ran.',
  });

  return (
    <section className="walkthrough" aria-label="How we got here">
      <h3 className="walkthrough-title">How we got here</h3>
      <ol className="walkthrough-steps">
        {steps.map((s) => (
          <li key={s.title}>
            <strong>{s.title}.</strong> {s.body}
          </li>
        ))}
      </ol>
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { Senator } from '@receipts/shared';
import { useReceiptStream } from './lib/useReceiptStream.js';
import { Entry, type ExamplePromise } from './components/Entry.js';
import { ReasoningStream } from './components/ReasoningStream.js';
import { Verdict } from './components/Verdict.js';
import {
  DemoBanner,
  ErrorState,
  HaltState,
  ThinResultActions,
  UncachedState,
} from './components/States.js';
import {
  AppliedCorrections,
  AssertedPremiseBadge,
  CorrectionPanel,
  type TaxonomyEntry,
} from './components/CorrectionPanel.js';
import type { Corrections } from '@receipts/shared';
import { apiUrl } from './lib/api.js';

export default function App() {
  const [senators, setSenators] = useState<Senator[]>([]);
  const [modes, setModes] = useState({ demo: false, fixture: false, override: false });
  const [taxonomy, setTaxonomy] = useState<TaxonomyEntry[]>([]);
  const [selected, setSelected] = useState('S000148');
  const [promise, setPromise] = useState('');

  const stream = useReceiptStream();

  useEffect(() => {
    fetch(apiUrl('/api/senators'))
      .then((r) => r.json())
      .then((d) => {
        setSenators(d.senators ?? []);
        setModes({
          demo: Boolean(d.demo_mode),
          fixture: Boolean(d.fixture_mode),
          override: Boolean(d.campaign_promise_override),
        });
      })
      .catch(() => {
        /* The entry screen still renders; submitting will surface the error. */
      });
  }, []);

  useEffect(() => {
    fetch(apiUrl('/api/taxonomy'))
      .then((r) => r.json())
      .then((d) => setTaxonomy(d.primary_issues ?? []))
      .catch(() => {
        /* No taxonomy means no correction pickers; the query path is unaffected. */
      });
  }, []);

  const submit = () => stream.run(selected, promise.trim());

  // A correction re-runs the ENTIRE query from embedding. `stream.run` resets
  // state first, so the previous verdict is gone before the new one starts —
  // there is no window in which an old verdict sits beside corrected values.
  const rerunWithCorrections = (corrections: Corrections) =>
    stream.run(selected, promise.trim(), corrections);

  // A STATEMENT_DATE_REQUIRED halt is resolved by supplying the date, which
  // re-runs the whole query — the date changes `valid_until`, which is what the
  // scope gates test against.
  const rerunWithDate = (isoDate: string) =>
    stream.run(selected, promise.trim(), undefined, isoDate);

  const runExample = (example: ExamplePromise) => {
    setSelected(example.senatorId);
    setPromise(example.text);
    stream.run(example.senatorId, example.text);
  };

  const startOver = () => {
    stream.reset();
    setPromise('');
  };

  const busy = stream.phase === 'streaming';
  const showEntry = stream.phase === 'idle';
  const senatorName =
    senators.find((s) => s.politician_id === selected)?.name ?? 'this senator';

  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">Receipts</h1>
      </header>
      <p className="explainer">
        Check whether a senator kept a campaign promise — matched against their real votes and
        bills.
      </p>

      <DemoBanner demo={modes.demo} fixture={modes.fixture} />

      {showEntry ? (
        <Entry
          senators={senators}
          selected={selected}
          promise={promise}
          busy={busy}
          onSelect={setSelected}
          onPromiseChange={setPromise}
          onSubmit={submit}
          onExample={runExample}
        />
      ) : (
        <>
          <ReasoningStream steps={stream.steps} interpretation={stream.interpretation} />

          {stream.uncached ? (
            <UncachedState
              senator={stream.uncached.senator}
              queued={stream.uncached.queued}
              onReset={startOver}
            />
          ) : null}

          {stream.error ? <ErrorState error={stream.error} onRetry={submit} /> : null}

          {stream.halt ? (
            <HaltState halt={stream.halt} onReset={startOver} onRetryWithDate={rerunWithDate} />
          ) : null}

          {stream.result && stream.interpretation ? (
            <>
              <AssertedPremiseBadge interpretation={stream.interpretation} />
              <AppliedCorrections interpretation={stream.interpretation} />
              <Verdict result={stream.result} />
            </>
          ) : null}

          {/* Offered only once a result exists: correcting a classification
              mid-flight would stage edits against values still changing. */}
          {stream.phase === 'done' && stream.interpretation && !stream.uncached && !stream.halt ? (
            <CorrectionPanel
              interpretation={stream.interpretation}
              taxonomy={taxonomy}
              overrideEnabled={modes.override}
              busy={busy}
              onRerun={rerunWithCorrections}
            />
          ) : null}

          {stream.phase === 'done' && !stream.uncached && !stream.error && !stream.halt ? (
            <ThinResultActions onReset={startOver} senatorName={senatorName} />
          ) : null}
        </>
      )}
    </main>
  );
}

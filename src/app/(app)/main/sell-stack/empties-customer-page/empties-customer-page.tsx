'use client';

import { useMemo } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { PlusIcon } from '@/components/ui/Icon';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { emptiesLedger, emptiesOwed, type EmptiesMove } from '@/lib/stacks/customer-ledgers';
import { rollUpOwed, saidAsPart, type OwedRow } from '@/lib/empties-rollup';

import styles from './empties-customer-page.module.css';

/**
 * One customer's containers: what is owed, and every move of it.
 *
 * TWO READINGS OF THE SAME FACT, and both are needed.
 *
 *   What is owed, ROLLED UP the way a shop says it — "8 NBL crates, ½ Goldberg, ½ Gulder". That is
 *   the sentence somebody reads out over a counter, and it is what goes on a receipt.
 *
 *   And the same thing SHAPE BY SHAPE, because that is what can be counted against and what a
 *   return is recorded in. Eight NBL crates cannot be handed back — three Goldberg crates can.
 *
 * Returns are PARTIAL by nature. Three crates on Tuesday and two on Friday are two rows, and the
 * ledger below is the trace, which is why nothing here edits anything: every correction is another
 * row saying what happened.
 */
export default function EmptiesCustomerPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const showProblem = problem.show;

  const customerId = (location?.params?.id as string | undefined) ?? null;

  const owedArea = useLoadArea<OwedRow[]>(
    () => emptiesOwed(customerId!),
    [customerId],
    { onFail: showProblem, whenNot: !customerId },
  );
  const ledgerArea = useLoadArea<EmptiesMove[]>(
    () => emptiesLedger(customerId!),
    [customerId],
    { onFail: showProblem, whenNot: !customerId },
  );

  /*
   * RE-READ ON THE WAY BACK, because this page never unmounted.
   *
   * The recording page is pushed OVER this one, so when it pops there is no mount to trigger a
   * fetch — and the figure somebody just changed would still be the old one. No polling: the
   * lifecycle says when the page is looked at again.
   */
  useLiveRefresh(nav, () => {
    owedArea.reload();
    ledgerArea.reload();
  });

  const owed = useMemo(() => owedArea.data ?? [], [owedArea.data]);
  const outstanding = useMemo(() => owed.filter((r) => r.owed > 0), [owed]);
  const lines = useMemo(() => rollUpOwed(outstanding), [outstanding]);

  return (
    <PageScaffold
      onBack={goBack}
      title="Empties"
      subtitle="What they are holding, and every move of it"
    >
      <ProblemDialog problem={problem} title="Not recorded" />

      <h2 className={styles.section}>Still with them</h2>

      <LoadArea area={owedArea} what="what they are holding">
        {() =>
          lines.length === 0 ? (
            <InfoPanel tone="success" title="Everything is back">
              Nothing of yours is out with them.
            </InfoPanel>
          ) : (
            <>
              {/*
                THE SENTENCE, said the way it is said out loud.

                Whole crates add up across the maker — a Goldberg crate settles a Gulder crate,
                both go back to Nigerian Breweries — and the part-loads stay with their own beer,
                because half a Goldberg and half a Gulder are not one crate of anything.
              */}
              <ul className={styles.said}>
                {lines.map((l, i) => (
                  <li key={`${l.label}-${l.unit}-${i}`} className={l.isPart ? styles.part : styles.whole}>
                    <span className={styles.saidQty}>{l.said}</span>
                    <span className={styles.saidWhat}>
                      {l.label} {l.unit.toLowerCase()}
                    </span>
                    {/*
                      THE WORKING, on the line that needed it.

                      There used to be a second section below repeating every shape separately —
                      "Counted shape by shape" — which said the same thing twice and made the screen
                      look like two different answers. What that section was really for is visible
                      here: which products a rolled-up total came from.
                    */}
                    {l.products.length > 1 && (
                      <span className={styles.saidFrom}>{l.products.join(' + ')}</span>
                    )}
                  </li>
                ))}
              </ul>

            </>
          )
        }
      </LoadArea>

      {/*
        BOTH PUSH A PAGE. They were a bottom sheet with a select, a quantity and a reason in it,
        which is a FORM — and the rule here is that a form is a page and a sheet is for choosing
        from a list. On a phone the keyboard covers half a sheet, dragging to reach a field reads as
        a dismiss, and nothing typed survives a rotation.
      */}
      <div className={styles.actions}>
        <Button
          fullWidth
          disabled={outstanding.length === 0}
          onClick={() =>
            void nav.push('empties_record_page', { id: customerId, direction: 'returned' })
          }
        >
          <PlusIcon /> They brought some back
        </Button>
        {/*
          A WRITE-OFF IS NOT A RETURN, and it is red because it closes an obligation without the
          thing coming back. On trust, broken, or paid for at the counter — all ordinary, and all
          previously impossible to record unless the shop happened to hold a deposit.
        */}
        <Button
          variant="danger"
          fullWidth
          disabled={outstanding.length === 0}
          onClick={() =>
            void nav.push('empties_record_page', { id: customerId, direction: 'damaged' })
          }
        >
          Broken or lost
        </Button>
      </div>

      <h2 className={styles.section}>Everything that has happened</h2>
      <LoadArea area={ledgerArea} what="the history">
        {(moves) =>
          moves.length === 0 ? (
            <p className={styles.none}>Nothing recorded yet.</p>
          ) : (
            <ul className={styles.ledger}>
              {moves.map((m) => (
                <li key={m.id} className={styles.move}>
                  <span className={`${styles.dot} ${styles[m.direction]}`} aria-hidden="true" />
                  <span className={styles.moveBody}>
                    <span className={styles.moveWhat}>
                      {m.direction === 'out'
                        ? 'Took'
                        : m.direction === 'returned'
                          ? 'Brought back'
                          : 'Written off'}{' '}
                      {saidAsPart(m.qty)} {m.qty === 1 ? m.unitName : m.unitPlural}
                    </span>
                    <span className={styles.moveWho}>{m.productName}</span>
                    {m.reason ? <span className={styles.moveWhy}>{m.reason}</span> : null}
                  </span>
                  <span className={styles.moveWhen}>
                    {new Date(m.occurredAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </LoadArea>

    </PageScaffold>
  );
}

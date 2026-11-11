'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { usePermission } from '@/hooks/usePermission';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { PeopleIcon } from '@/components/ui/Icon';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { RecordLink } from '@/components/ui/RecordLink';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import {
  emptiesLedger,
  emptiesOwed,
  returnOwedRow,
  type EmptiesMove,
  LEDGERS_SCOPE,
} from '@/lib/stacks/customer-ledgers';
import { accountsChanged, useCustomerAccount } from '@/lib/stacks/customer-account';
import { PrintShareButton, listDocument } from '@/components/ui/PrintShare';
import { formatQtySpoken } from '@/lib/format';
import { useAuth } from '@/providers/AuthProvider';
import { messageOf } from '@/lib/format';
import { rollUpOwed, saidAsPart, settleLine, type OwedLine, type OwedRow } from '@/lib/empties-rollup';
import { EmptiesBroughtBack } from '@/components/empties/EmptiesBroughtBack';
import { undoEmptiesMove } from '@/lib/stacks/sale-empties';

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
  const { canOpen } = usePermission();
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const showProblem = problem.show;
  const { store } = useAuth();

  const customerId = (location?.params?.id as string | undefined) ?? null;

  const owedArea = useLoadArea<OwedRow[]>(
    () => emptiesOwed(customerId!),
    [customerId],
    {
      key: `empties-owed:${customerId ?? 'none'}`,
      scope: LEDGERS_SCOPE,
      onFail: showProblem,
      whenNot: !customerId,
    },
  );
  const ledgerArea = useLoadArea<EmptiesMove[]>(
    () => emptiesLedger(customerId!),
    [customerId],
    {
      key: `empties-ledger:${customerId ?? 'none'}`,
      scope: LEDGERS_SCOPE,
      onFail: showProblem,
      whenNot: !customerId,
    },
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
  const { account } = useCustomerAccount(customerId);
  const outstanding = useMemo(() => owed.filter((r) => r.owed > 0), [owed]);
  const rolled = useMemo(() => rollUpOwed(outstanding), [outstanding]);

  /*
   * TWO OBLIGATIONS, NEVER ONE NUMBER.
   *
   * A customer holding 55 of our crates while we hold 65 of theirs read as "120 crates still with
   * them" — the roll-up bucketed by maker and shape and said nothing about which way each ran. One
   * of those figures is what a breakage fee is worked out from, so the two are kept apart here and
   * the recording buttons act on what THEY hold, which is the only side this page can settle.
   */
  const lines = useMemo(() => rolled.filter((l) => l.side === 'they_hold'), [rolled]);
  const oursWithUs = useMemo(() => rolled.filter((l) => l.side === 'we_hold'), [rolled]);
  const theirsOutstanding = useMemo(
    () => outstanding.filter((r) => (r.side ?? 'they_hold') === 'they_hold'),
    [outstanding],
  );

  /*
   * GIVING THEIRS BACK.
   *
   * "I have returned Arewa's Nigerian Breweries crate but I could not clear it." Their containers in
   * our yard could only be read here, never settled. Each line now has "Given back" — asked first,
   * because it clears the line — and it is recorded on THEIR side, as a maker's crate when that is
   * what was entered.
   */
  const giveDialog = useConfirm();
  // A return taken back (0280): mounted means asked.
  const undoDialog = useConfirm();
  const [undoing, setUndoing] = useState<EmptiesMove | null>(null);
  const [giving, setGiving] = useState<OwedLine | null>(null);
  const [givingBusy, setGivingBusy] = useState(false);
  const giveBack = async (line: OwedLine) => {
    if (!store || !customerId) return;
    setGivingBusy(true);
    try {
      for (const part of settleLine(line, outstanding)) {
        await returnOwedRow({
          storeId: store.id,
          customerId,
          row: part.row,
          direction: 'returned',
          qty: part.qty,
          reason: 'Given back to them',
        });
      }
      accountsChanged();
      owedArea.reload();
      ledgerArea.reload();
    } catch (e) {
      showProblem(messageOf(e, 'That could not be recorded.'));
    } finally {
      setGivingBusy(false);
    }
  };

  /*
   * ONE HEADER, and the body waits for both reads. The two record buttons used to be drawn
   * straight away, greyed out, above two separate spinners — buttons for a figure nobody had seen.
   */
  const status: PageStatus =
    owedArea.data && ledgerArea.data
      ? { state: 'ready' }
      : owedArea.error || ledgerArea.error
        ? {
            state: 'error',
            what: 'their empties',
            error: owedArea.error ?? ledgerArea.error,
            onRetry: () => {
              owedArea.reload();
              ledgerArea.reload();
            },
          }
        : { state: 'loading', what: 'their empties' };

  return (
    <PageScaffold
      layout="record"
      onBack={goBack}
      title="Empties"
      subtitle={account?.customer.name ? `${account.customer.name} — what they hold, and every move` : 'What they are holding, and every move of it'}
      // UP TO THE RECORD THIS BELONGS TO: the customer, with their statement and deposit.
      /*
        UP TO THEIR ACCOUNT — only when this was not opened from it. From the account, Back is the way
        there; a second way made a loop (account, deposit, account, deposit...).
      */
      actions={
        customerId && location?.params?.from !== 'account'
          ? [
              {
                key: 'account',
                icon: <PeopleIcon />,
                onClick: () => void nav.push('account_page', { id: customerId }),
                ariaLabel: 'Their account',
              },
            ]
          : undefined
      }
    >
      <ProblemDialog problem={problem} title="Not recorded" />

      <PageState status={status}>
        {() => (
          <>

      <div className={styles.layout}>
        <div className={styles.col}>
          {/*
            STILL WITH THEM, settled where it is read (EmptiesBroughtBack): All back on a line is one tap
            and a dialog, Part counts some, and "They brought everything back" clears the lot. It used to
            be a list to read and a separate button to a page to record on.
          */}
          {store && customerId && (
            <EmptiesBroughtBack
              storeId={store.id}
              customerId={customerId}
              title="Still with them"
              onRecorded={() => {
                owedArea.reload();
                ledgerArea.reload();
              }}
            />
          )}

          {/* THEIRS, IN OUR YARD — the other direction, said as its own thing (0157). */}
          {oursWithUs.length > 0 && (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Theirs, in your yard</h2>
              <ul className={styles.said}>
                {oursWithUs.map((l, i) => (
                  <li key={`ours-${l.label}-${l.unit}-${i}`} className={l.isPart ? styles.part : styles.whole}>
                    <span className={styles.saidQty}>{l.said}</span>
                    <span className={styles.saidWhat}>
                      {l.label} {l.unit.toLowerCase()}
                    </span>
                    {l.products.length > 1 && <span className={styles.saidFrom}>{l.products.join(' + ')}</span>}
                    {canOpen('empties_record_page') && (
                      <Button size="small" disabled={givingBusy} onClick={() => setGiving(l)}>
                        Given back
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {canOpen('empties_record_page') && (
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => void nav.push('empties_record_page', { id: customerId, direction: 'returned', side: 'we_hold' })}
                >
                  Give some of theirs back
                </Button>
              )}
            </section>
          )}

          {giving && (
            <ConfirmDialog
              controller={giveDialog}
              tone="primary"
              title={`Gave back ${giving.said} ${giving.label} ${giving.unit.toLowerCase()}?`}
              message="They come off what you are holding of theirs."
              confirmText="Yes, given back"
              onDismiss={() => setGiving(null)}
              onConfirm={() => void giveBack(giving)}
            />
          )}

          {/* A write-off is not a return: red, because it closes an obligation without the thing coming back. */}
          {canOpen('empties_record_page') && theirsOutstanding.length > 0 && (
            <Button
              variant="danger"
              fullWidth
              onClick={() => void nav.push('empties_record_page', { id: customerId, direction: 'damaged' })}
            >
              Broken or lost
            </Button>
          )}
        </div>

        <section className={`${styles.col} ${styles.card}`} aria-label="Everything that has happened">
          <h2 className={styles.cardTitle}>Everything that has happened</h2>
          <LoadArea area={ledgerArea} what="the history">
            {(moves) =>
              moves.length === 0 ? (
                <p className={styles.none}>Nothing recorded yet.</p>
              ) : (
                <ul className={styles.ledger}>
                  {moves.map((m) => {
                    const gone = m.undone >= m.qty - 1e-9 && m.undone > 0;
                    return (
                      <li key={m.id} className={`${styles.move} ${gone ? styles.moveUndone : ''}`}>
                        <span className={`${styles.dot} ${styles[m.undoes ? 'undo' : m.direction]}`} aria-hidden="true" />
                        <span className={styles.moveBody}>
                          <span className={styles.moveWhat}>
                            {/* Said from the right direction (0157), and an undo says it is one (0280). */}
                            {m.undoes
                              ? 'Undone — not back'
                              : m.direction === 'damaged'
                                ? 'Written off'
                                : m.side === 'we_hold'
                                  ? m.direction === 'out'
                                    ? 'Left with you'
                                    : 'Given back to them'
                                  : m.direction === 'out'
                                    ? 'Took'
                                    : 'Brought back'}{' '}
                            {saidAsPart(m.qty)} {m.qty === 1 ? m.unitName : m.unitPlural}
                            {gone && <span className={styles.undoneTag}>undone</span>}
                            {!gone && m.undone > 0 && <span className={styles.undoneTag}>{saidAsPart(m.undone)} undone</span>}
                          </span>
                          {m.productId ? (
                            <RecordLink route="product_page" id={m.productId} className={styles.moveWho}>
                              {m.productName}
                            </RecordLink>
                          ) : (
                            <span className={styles.moveWho}>{m.productName}</span>
                          )}
                          {m.reason ? <span className={styles.moveWhy}>{m.reason}</span> : null}
                          <span className={styles.moveLinks}>
                            {m.saleId && (
                              <button
                                type="button"
                                className={styles.moveOpen}
                                onClick={() => void nav.push('receipt_page', { id: m.saleId })}
                              >
                                See the receipt
                              </button>
                            )}
                            {m.canUndo && canOpen('empties_record_page') && (
                              <button type="button" className={styles.moveUndo} onClick={() => setUndoing(m)}>
                                Undo
                              </button>
                            )}
                          </span>
                        </span>
                        <span className={styles.moveWhen}>{new Date(m.occurredAt).toLocaleDateString()}</span>
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </LoadArea>
        </section>
      </div>

      {undoing && (
        <ConfirmDialog
          controller={undoDialog}
          tone="danger"
          title={`Undo: ${undoing.direction === 'damaged' ? 'written off' : 'brought back'} ${saidAsPart(undoing.qty - undoing.undone)} ${(undoing.qty - undoing.undone === 1 ? undoing.unitName : undoing.unitPlural).toLowerCase()}?`}
          message={`${undoing.productName}: they go back on what ${account?.customer.name ?? 'the customer'} holds. The return stays in the history, marked undone.`}
          confirmText="Yes, undo it"
          onDismiss={() => setUndoing(null)}
          onConfirm={() => {
            const m = undoing;
            setUndoing(null);
            void (async () => {
              try {
                await undoEmptiesMove(m.id);
                owedArea.reload();
                ledgerArea.reload();
              } catch (e) {
                showProblem(messageOf(e, 'That could not be undone.'));
              }
            })();
          }}
        />
      )}

            {store && (
              <PrintShareButton
                label="Print or share their empties"
                spec={() => ({
                  title: `Empties · ${account?.customer.name ?? 'Customer'}`,
                  filename: `empties-${(account?.customer.name ?? 'customer').toLowerCase().replace(/\s+/g, '-')}`,
                  message: `${account?.customer.name ?? 'Your'} empties at ${store.name}.`,
                  whatsapp: {
                    phone: account?.customer.phone,
                    customerId,
                    customerName: account?.customer.name,
                  },
                  build: () =>
                    listDocument({
                      shopName: store.name,
                      title: 'Empties',
                      meta: [account?.customer.name ?? '', new Date().toLocaleString()].filter(Boolean),
                      rows: [...(ledgerArea.data ?? [])].reverse().map((m) => {
                        const theirs = m.side === 'we_hold';
                        const what =
                          m.direction === 'out'
                            ? theirs ? 'Left with us' : 'Took'
                            : m.direction === 'returned'
                              ? theirs ? 'Given back' : 'Brought back'
                              : 'Written off';
                        return {
                          name: `${what} · ${m.productName}`,
                          detail: `${new Date(m.occurredAt).toLocaleDateString()}${m.reason ? ` · ${m.reason}` : ''}`,
                          amount: `${formatQtySpoken(m.qty)} ${(m.qty <= 1 ? m.unitName : m.unitPlural).toLowerCase()}`,
                        };
                      }),
                      totals: [
                        ...(lines.length > 0
                          ? [
                              { label: 'Still with you', value: '', strong: true },
                              ...lines.map((l) => ({ label: `${l.label} ${l.unit.toLowerCase()}`, value: l.said })),
                            ]
                          : [{ label: 'Still with you', value: 'None' }]),
                        ...(oursWithUs.length > 0
                          ? [
                              { label: 'Yours with us', value: '', strong: true },
                              ...oursWithUs.map((l) => ({ label: `${l.label} ${l.unit.toLowerCase()}`, value: l.said })),
                            ]
                          : []),
                      ],
                    }),
                })}
              />
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}

'use client';


import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { depositLedger, type DepositMove } from '@/lib/stacks/customer-ledgers';
import { formatMoney } from '@/lib/format';
import styles from './deposit-customer-page.module.css';

/**
 * One customer's deposit, and every move of it.
 *
 * PARTIAL IS NORMAL. A shop holding twenty thousand gives back twelve and keeps eight for a broken
 * crate, and both halves of that need saying separately — one is the customer's money returning,
 * the other is income. A single "settled" flag could not carry either.
 *
 * So nothing here edits anything: giving some back is a row, keeping some is a row, and the balance
 * is what they add to. The running figure beside each row comes from the SERVER, because a balance
 * the screen works out is one that disagrees the moment two rows share a timestamp.
 */
export default function DepositCustomerPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const showProblem = problem.show;

  const customerId = (location?.params?.id as string | undefined) ?? null;

  const area = useLoadArea<DepositMove[]>(
    () => depositLedger(customerId!),
    [customerId],
    { onFail: showProblem, whenNot: !customerId },
  );

  const moves = area.data ?? [];
  // Newest first, and the reader carries the running balance — so the first row is what is held.
  const held = moves.length > 0 ? moves[0].running : 0;

  /*
   * RE-READ ON THE WAY BACK.
   *
   * The move is recorded on a page pushed OVER this one, so when it pops there is no mount to
   * trigger a fetch and the balance somebody just changed would still read as it was.
   */
  useLiveRefresh(nav, () => area.reload());

  return (
    <PageScaffold onBack={goBack} title="Deposit">
      <ProblemDialog problem={problem} title="Not recorded" />

      <LoadArea area={area} what="their deposit">
        {() => (
          <>
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>You are holding</span>
              <span className={styles.headlineValue}>{formatMoney(held)}</span>
            </div>

            {held === 0 && moves.length > 0 && (
              <InfoPanel tone="success" title="Nothing outstanding">
                Everything they put down has been given back or kept. The history below says which.
              </InfoPanel>
            )}

            {/*
              GIVE IT BACK, OR KEEP IT — and the colours mean what they say. Green hands the
              customer's money back; red keeps it, which is income and needs a reason somebody can
              read out months later.
            */}
            {/*
              ALL THREE PUSH A PAGE. They were a bottom sheet holding an amount and a reason, which
              is a FORM — and a form is a page here. A sheet is for choosing from a list; nothing
              typed into one survives a rotation, and this moves somebody's money.
            */}
            <div className={styles.actions}>
              <Button
                fullWidth
                disabled={held <= 0}
                onClick={() => void nav.push('deposit_move_page', { id: customerId, mode: 'give' })}
              >
                Give some back
              </Button>
              <Button
                variant="danger"
                fullWidth
                disabled={held <= 0}
                onClick={() => void nav.push('deposit_move_page', { id: customerId, mode: 'keep' })}
              >
                Keep some for breakage
              </Button>
              <Button
                variant="secondary"
                fullWidth
                onClick={() => void nav.push('deposit_move_page', { id: customerId, mode: 'take' })}
              >
                Take more
              </Button>
            </div>

            <h2 className={styles.section}>Every move of it</h2>
            {moves.length === 0 ? (
              <p className={styles.none}>Nothing recorded yet.</p>
            ) : (
              <ul className={styles.ledger}>
                {moves.map((m) => (
                  <li key={m.id} className={styles.move}>
                    <span className={`${styles.dot} ${styles[m.direction]}`} aria-hidden="true" />
                    <span className={styles.moveBody}>
                      <span className={styles.moveWhat}>
                        {m.direction === 'taken'
                          ? 'Taken'
                          : m.direction === 'given'
                            ? 'Given back'
                            : 'Kept'}{' '}
                        {formatMoney(m.amount)}
                      </span>
                      {m.reason ? <span className={styles.moveWhy}>{m.reason}</span> : null}
                    </span>
                    <span className={styles.moveAfter}>
                      <span className={styles.moveWhen}>
                        {new Date(m.occurredAt).toLocaleDateString()}
                      </span>
                      {/* What was held after this row, so the history reconciles line by line. */}
                      <span className={styles.moveRunning}>{formatMoney(m.running)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </LoadArea>

    </PageScaffold>
  );
}

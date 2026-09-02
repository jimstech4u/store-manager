'use client';


import styles from './empties-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { formatMoney } from '@/lib/format';
import { useReceiptEmpties } from '@/lib/stacks/empties';

/**
 * What is still out, receipt by receipt.
 *
 * The shop's question is not "how many NBL bottles does Irekanmi owe" — the account page answers
 * that. It is "he took these out on Tuesday; what has come back?" A man walks in with crates in the
 * boot of a car and the shop needs the stack they belong to, not a pool total.
 *
 * Reached from the till's own actions and from a receipt, because those are the two moments the
 * question comes up: someone standing at the counter with empties, and someone reading back the
 * sale they came from.
 */
export default function EmptiesPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  // Optionally narrowed to one customer, when opened from their account or their receipt.
  const customerId = (location?.params?.customerId as string | undefined) ?? null;

  const { rows, error, loading, reload } = useReceiptEmpties(store?.id ?? null, customerId);
  /*
    Re-read when the shop comes back to this page.

    Settling from another screen — the account, a receipt — moves these figures, and `onResume` is
    how this page learns without polling. `useLiveRefresh` keeps what is on screen while the
    request is in flight, so returning here never shows a spinner over rows that were nearly right.
  */
  useLiveRefresh(nav, reload);

  if (!store) return null;

  if (loading) {
    return <FullPageMessage title="Reading what is still out" tone="loading" />;
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Empties out"
      subtitle={customerId ? 'For this customer' : 'Receipts with containers still to come back'}
    >
      {/*
        A LOAD that failed is the state of the page, not an event — it stays here rather than
        interrupting, per the rule. A failed SETTLE interrupts, and does so from the sheet.
      */}
      {error && rows.length === 0 && (
        <InfoPanel tone="danger" title="Could not read what is still out">
          {error}
        </InfoPanel>
      )}

      {rows.length === 0 ? (
        <InfoPanel tone="success" title="Nothing is out">
          Every returnable this shop has sold has come back, or was sold to a walk-in who paid a
          deposit instead.
        </InfoPanel>
      ) : (
        <>
          <InfoPanel
            tone="info"
            id="empties.how"
            title={`${rows.length} ${rows.length === 1 ? 'receipt has' : 'receipts have'} containers out`}
          >
            <p>
              Tap one to record what came back. You can settle part of it — a customer who brings
              nine of twelve bottles is the normal case, not an error.
            </p>
            <p>
              If you are holding a deposit, you decide there and then how much of it to keep for
              what did not come back. There is no fixed rate, because you did not agree one.
            </p>
          </InfoPanel>

          <ul className={styles.list}>
            {rows.map((r) => (
              <li key={r.sale_id}>
                <button
                  type="button"
                  className={styles.card}
                  onClick={() => {
                    /*
                      The ROW travels as an object; the push carries only its id.

                      `nav.push` never carries a record — the settle page reads it back from the
                      database when nothing was provided, which is what makes a reload and a deep
                      link work.
                    */
                    nav.provideObject('receiptEmpties', () => r, { global: true, scope: 'sell' });
                    void nav.push('empties_settle_page', { id: r.sale_id });
                  }}
                >
                  <span className={styles.head}>
                    <span className={styles.who}>{r.customer_name}</span>
                    <span className={styles.when}>
                      {new Date(r.occurred_at).toLocaleDateString()}
                    </span>
                  </span>
                  <span className={styles.pools}>
                    {r.expected
                      .map((e) => `${Number(e.units)} ${e.category}`)
                      .join(' · ')}
                  </span>
                  <br />
                  {Number(r.held) > 0 ? (
                    <span className={styles.held}>Holding {formatMoney(Number(r.held))}</span>
                  ) : (
                    <span className={styles.trust}>No deposit taken — on trust</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

    </PageScaffold>
  );
}

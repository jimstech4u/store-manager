'use client';

import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { InfoPanel } from '@/components/ui/Explain';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useDepositCustomers, type DepositCustomer } from '@/lib/stacks/customer-ledgers';
import { formatMoney } from '@/lib/format';
import styles from './deposits-page.module.css';

/**
 * Money the shop is holding that is not its own.
 *
 * A screen of its own, and separate from empties on purpose. The old model made a deposit a
 * QUANTITY OF CONTAINERS at a rate, so the two could not be looked at apart — and "I am holding
 * twenty thousand for Daniel" could not be said at all, because it is not a number of crates.
 *
 * Cleared accounts stay listed, for the same reason they do on the empties screen: somebody opens
 * this asking "did we give it back?", and a list of only the outstanding ones answers by omission,
 * which is not an answer.
 */
export default function DepositsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { rows } = useDepositCustomers(store?.id ?? null);
  /*
   * SEARCHING HAPPENS IN THE VIEWER, not in a box on the page.
   *
   * This had a plain `SearchField` filtering the list in place, which is the arrangement every
   * other list here moved away from: an in-page box is cramped on a phone, has nowhere to put a
   * "nothing matched" state, and cannot page a result set. `search-viewer` is the shop's own
   * component and brings all three — the stock screen has worked this way for a while.
   */
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  /** Matched here so the first keystroke is answered from what is already loaded. */
  const matching = (text: string) => {
    const q = text.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.phone ?? '').includes(q));
  };

  // What the shop is holding altogether. The figure an owner wants before anything else, because
  // it is a liability sitting in the drawer.
  const total = rows.reduce((sum, r) => sum + r.held, 0);
  const holding = rows.filter((r) => r.held > 0);

  return (
    <PageScaffold onBack={goBack} title="Deposits" subtitle="Money you are holding">
      <div className={styles.headline}>
        <span className={styles.headlineLabel}>Held altogether</span>
        <span className={styles.headlineValue}>{formatMoney(total)}</span>
        <span className={styles.headlineNote}>
          for {holding.length} {holding.length === 1 ? 'customer' : 'customers'}
        </span>
      </div>

      <InfoPanel id="deposits.list" tone="info" title="This is not your money yet">
        A deposit comes back when they settle, or you keep it and say why. Keeping it is income and
        is recorded as such — giving it back is not.
      </InfoPanel>

      <SearchLauncher label="Search who you are holding money for" placeholder="Search a name or a number" onOpen={searchOps.open} />

      <SearchSheet<DepositCustomer>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search a name or a number"
        onInitialData={matching}
        localDataDeps={[rows]}
        queryData={async (_cursor, text) => ({ data: matching(text) })}
        keyOf={(r) => r.customerId}
        emptyText="Try part of the name, or the number they are saved under."
        renderRow={(r) => (
          <button
            type="button"
            className={styles.row}
            onClick={async () => {
              await nav.push('deposit_customer_page', { id: r.customerId });
              searchOps.close();
            }}
          >
            <span className={styles.who}>
              <span className={styles.name}>{r.name}</span>
              {r.phone ? <span className={styles.phone}>{r.phone}</span> : null}
            </span>
            <span className={styles.amount}>
              {r.held > 0 ? (
                <span className={styles.held}>{formatMoney(r.held)}</span>
              ) : (
                <span className={styles.clear}>settled</span>
              )}
            </span>
          </button>
        )}
      />

      {rows.length === 0 ? (
        <p className={styles.empty}>
          No deposits taken yet. They appear here as soon as you take one.
        </p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.customerId}>
              <button
                type="button"
                className={styles.row}
                onClick={() => void nav.push('deposit_customer_page', { id: r.customerId })}
              >
                <span className={styles.who}>
                  <span className={styles.name}>{r.name}</span>
                  {r.phone ? <span className={styles.phone}>{r.phone}</span> : null}
                </span>

                <span className={styles.amount}>
                  {r.held > 0 ? (
                    <span className={styles.held}>{formatMoney(r.held)}</span>
                  ) : (
                    <span className={styles.clear}>settled</span>
                  )}
                  {r.retained > 0 && (
                    <span className={styles.kept}>{formatMoney(r.retained)} kept</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PageScaffold>
  );
}

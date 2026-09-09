'use client';

import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { InfoPanel } from '@/components/ui/Explain';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useEmptiesCustomers, type EmptiesCustomer } from '@/lib/stacks/customer-ledgers';
import { formatQty } from '@/lib/format';
import styles from './empties-page.module.css';

/**
 * Who is holding the shop's containers.
 *
 * A LIST OF CUSTOMERS, not of receipts — and that is the change. It used to list every receipt with
 * something still out, which is how the obligation was RECORDED but not how anybody thinks about
 * it: a customer who took crates on four visits owes one pile of crates, and settling it receipt by
 * receipt made a seller find the right receipt before they could count what was on the floor in
 * front of them.
 *
 * Cleared accounts stay on the list. "Did Daniel bring those crates back?" is a question somebody
 * arrives with, and a list of only the outstanding ones cannot answer it.
 */
export default function EmptiesPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { rows } = useEmptiesCustomers(store?.id ?? null);
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

  const stillOut = rows.filter((r) => r.stillOut > 0);

  return (
    <PageScaffold onBack={goBack} title="Empties" subtitle="Who is holding your containers">
      <InfoPanel
        id="empties.list"
        tone="info"
        title={
          stillOut.length === 0
            ? 'Nothing is out'
            : `${stillOut.length} ${stillOut.length === 1 ? 'customer has' : 'customers have'} containers`
        }
      >
        Counted in the shape they left in — crates as crates, bottles as bottles. Open somebody to
        record what came back, or to write off what will not.
      </InfoPanel>

      <SearchLauncher label="Search who is holding your containers" placeholder="Search a name or a number" onOpen={searchOps.open} />

      {/*
        The whole list browses; searching happens in the viewer's own sheet, which owns the empty
        state and the paging. The page does not switch itself between "browse" and "results".
      */}
      <SearchSheet<EmptiesCustomer>
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
              // Navigate first, then close — see money-page for why the order matters.
              await nav.push('empties_customer_page', { id: r.customerId });
              searchOps.close();
            }}
          >
            <span className={styles.who}>
              <span className={styles.name}>{r.name}</span>
              {r.phone ? <span className={styles.phone}>{r.phone}</span> : null}
            </span>
            <span className={styles.owed}>
              {r.stillOut > 0 ? (
                <span className={styles.owedQty}>{formatQty(r.stillOut)}</span>
              ) : (
                <span className={styles.clear}>all back</span>
              )}
            </span>
          </button>
        )}
      />

      {rows.length === 0 ? (
        <p className={styles.empty}>
          No containers have gone out yet. They will appear here as soon as somebody takes some.
        </p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.customerId}>
              <button
                type="button"
                className={styles.row}
                onClick={() =>
                  /*
                   * An id and an intent. The record itself is read on the page that shows it — it
                   * is a ledger, it changes as the seller works, and handing over a snapshot taken
                   * on this screen is how somebody settles against a figure that has moved.
                   */
                  void nav.push('empties_customer_page', { id: r.customerId })
                }
              >
                <span className={styles.who}>
                  <span className={styles.name}>{r.name}</span>
                  {r.phone ? <span className={styles.phone}>{r.phone}</span> : null}
                </span>

                <span className={styles.owed}>
                  {r.stillOut > 0 ? (
                    <>
                      <span className={styles.owedQty}>{formatQty(r.stillOut)}</span>
                      <span className={styles.owedNote}>
                        across {r.shapesOut} {r.shapesOut === 1 ? 'shape' : 'shapes'}
                      </span>
                    </>
                  ) : (
                    /* Said rather than left blank: a cleared account is an answer, not an absence. */
                    <span className={styles.clear}>all back</span>
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

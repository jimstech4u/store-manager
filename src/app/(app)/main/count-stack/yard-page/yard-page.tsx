'use client';

import { useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { ClipboardCheckIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { useYard, type YardGroupRow, type YardRow } from '@/lib/stacks/yard';
import { formatQty } from '@/lib/format';
import styles from './yard-page.module.css';

/**
 * What is standing in the shop's OWN yard.
 *
 * The third pile, and the one that had no screen. A container is with a customer, with a supplier,
 * or here — and the first two have had a list for a while while the physical stack by the back door
 * could only be counted through the product form, once, when an item was first created.
 *
 * NOTHING IS SHOWN AS A NUMBER UNTIL SOMEBODY HAS COUNTED IT. Before 0128 this page's figures would
 * have read "Goldberg crates: −4,587" — the movements alone, with no starting position under them,
 * in a shop that has never been short of a crate. A position nobody has established is not a
 * position, and the honest word for it is "not counted yet".
 */
export default function YardPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { shapes, groups, reload } = useYard(store?.id ?? null);

  /*
   * WHICH WAY THE SHOP COUNTS, which is a way of reading as much as a way of counting.
   *
   * Defaulting to groups because that is what a distributor's yard actually is: one stack of NBL
   * crates, not six stacks sorted by which beer was in them. The shape view is there for a shop
   * that does keep them apart, and for anybody checking a single item.
   */
  const [grain, setGrain] = useState<'group' | 'shape'>('group');

  useLiveRefresh(nav, reload);

  const counted = useMemo(
    () => groups.filter((g) => g.countedGrain !== null).length,
    [groups],
  );
  const uncounted = groups.length - counted;

  if (!store) return null;

  const say = (n: number | null, one: string, many: string) =>
    n === null ? null : `${formatQty(n)} ${Math.abs(n) === 1 ? one : many}`;

  const rowsForGrain: (YardGroupRow | YardRow)[] = grain === 'group' ? groups : shapes;

  return (
    <PageScaffold
      onBack={goBack}
      title="Your yard"
      subtitle="The empties standing here, not the ones out with people"
    >
      <InfoPanel
        id="yard.what"
        tone="info"
        title="This is your own stack, nobody else's"
      >
        Crates and bottles standing in your yard right now. What a customer is still holding is on
        the Empties screen, and what is with a brewery is on their account — those are things people
        owe, and this is the pile you can walk out and look at.
      </InfoPanel>

      {uncounted > 0 && (
        <InfoPanel tone="warning" title={`${uncounted} of these have never been counted`}>
          Until somebody counts a stack there is nothing to add or take away from, so it has no
          figure. Count it once and every crate in and out afterwards keeps it right.
        </InfoPanel>
      )}

      <div className={styles.actions}>
        <Button size="large" fullWidth onClick={() => void nav.push('yard_count_page')}>
          <ClipboardCheckIcon /> Count the yard
        </Button>
      </div>

      {/*
        HOW IT IS STACKED, not a filter.

        A group total and a shape total are different facts about the same yard, and a shop that
        counts by group genuinely cannot answer the shape question. Switching here changes which
        question is being asked.
      */}
      <div className={styles.tabs} role="tablist" aria-label="How your yard is stacked">
        <button
          type="button"
          role="tab"
          aria-selected={grain === 'group'}
          className={`${styles.tab} ${grain === 'group' ? styles.tabOn : ''}`}
          onClick={() => setGrain('group')}
        >
          By maker
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={grain === 'shape'}
          className={`${styles.tab} ${grain === 'shape' ? styles.tabOn : ''}`}
          onClick={() => setGrain('shape')}
        >
          Item by item
        </button>
      </div>

      {rowsForGrain.length === 0 ? (
        <InfoPanel tone="info" title="Nothing comes back yet">
          When you tick &ldquo;this comes back&rdquo; on an item&rsquo;s shape, its crates and
          bottles appear here to be counted.
        </InfoPanel>
      ) : (
        <ul className={styles.rows}>
          {rowsForGrain.map((r) => {
            const isGroup = 'groupId' in r && 'shapes' in r;
            const key = isGroup
              ? `${(r as YardGroupRow).groupId}-${(r as YardGroupRow).storeUnitId}`
              : (r as YardRow).productUnitId;
            const name = isGroup
              ? `${(r as YardGroupRow).groupName} ${r.unitPlural.toLowerCase()}`
              : `${(r as YardRow).productName} ${r.unitPlural.toLowerCase()}`;

            const moved =
              r.inFromCustomers - r.outToCustomers + r.inFromSuppliers - r.outToSuppliers;

            return (
              <li key={key} className={styles.row}>
                <span className={styles.name}>
                  {name}
                  {r.countedGrain === 'group' && !isGroup && (
                    <span className={styles.note}>
                      counted as part of {(r as YardRow).groupName}
                    </span>
                  )}
                  {r.countedAt && (
                    <span className={styles.note}>
                      counted {new Date(r.countedAt).toLocaleDateString()}
                      {moved !== 0 && `, ${moved > 0 ? '+' : ''}${formatQty(moved)} since`}
                    </span>
                  )}
                </span>

                <span className={styles.figure}>
                  {r.inYard === null ? (
                    /*
                     * THE HONEST ANSWER, and the reason this migration existed.
                     *
                     * Either nobody has counted this stack, or it was counted as part of a maker's
                     * pile and this row genuinely does not know its own share. Both are "we cannot
                     * say", and both used to produce a confident number.
                     */
                    <span className={styles.unknown}>
                      {r.countedGrain === 'group' ? 'in the maker’s total' : 'not counted yet'}
                    </span>
                  ) : (
                    <span className={r.inYard < 0 ? styles.short : styles.have}>
                      {say(r.inYard, r.unitName.toLowerCase(), r.unitPlural.toLowerCase())}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {rowsForGrain.some((r) => (r.inYard ?? 0) < 0) && (
        <InfoPanel tone="warning" title="One of these is below nothing">
          More has gone out than the count and the records can account for. Usually it means crates
          left without being recorded, or the count was taken before a load went back. Count that
          stack again — the new count replaces the old one and the history keeps both.
        </InfoPanel>
      )}
    </PageScaffold>
  );
}

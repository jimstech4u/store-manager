'use client';

import { useCallback, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import {
  expiringStock,
  writeOffExpired,
  WINDOWS,
  type ExpiringLayer,
} from '@/lib/stacks/expiry';
import { formatMoney, formatQty, messageOf } from '@/lib/format';
import styles from './expiry-page.module.css';

/**
 * What is going off, soonest first.
 *
 * PER DELIVERY, which is the whole point. Ten that came cheap and go off on Friday and forty dearer
 * ones good until July are two different piles of the same item, and a screen that averaged them
 * would tell a shop the wrong thing twice: it would hide the Friday problem and slander the July
 * stock. `stock_layers` has kept deliveries apart since 0061; 0130 gave each one its date.
 *
 * TWO LISTS, NOT ONE, because they are two different jobs. Stock that has passed comes OFF the
 * shelf; stock that is close gets SOLD first. Merging them into "expiring" makes a shop scroll a
 * list looking for the rows that need a bin rather than a discount.
 */
export default function ExpiryPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  /*
   * ONE dialog, and the row it was opened for held beside it.
   *
   * A `<ConfirmDialog>` rendered inside the list would mount one per row, and each would carry its
   * own copy of the controller — so pressing confirm on the fourth row would be answered by the
   * first dialog to notice. Every confirmation on this site is a dialog rather than a
   * `window.confirm`, and one dialog for the page is the shape that keeps working.
   */
  const confirm = useConfirm();
  const [pending, setPending] = useState<ExpiringLayer | null>(null);

  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(() => expiringStock(store!.id, days), [store, days]);
  const area = useLoadArea<ExpiringLayer[]>(read, [store?.id ?? '', String(days)], {
    onFail: showProblem,
    whenNot: !store,
  });

  useLiveRefresh(nav, area.reload);

  if (!store) return null;

  const takeOff = async (layer: ExpiringLayer) => {
    setBusy(layer.layerId);
    try {
      await writeOffExpired({
        layerId: layer.layerId,
        reason: `Out of date ${layer.expiresOn}`,
      });
      area.reload();
    } catch (e) {
      showProblem(messageOf(e, 'Could not write that off.'));
    } finally {
      setBusy(null);
    }
  };

  const said = (l: ExpiringLayer) => {
    if (l.daysLeft < 0) {
      const n = Math.abs(l.daysLeft);
      return `${n} ${n === 1 ? 'day' : 'days'} ago`;
    }
    if (l.daysLeft === 0) return 'today';
    return `in ${l.daysLeft} ${l.daysLeft === 1 ? 'day' : 'days'}`;
  };

  const renderRow = (l: ExpiringLayer, gone: boolean) => (
    <li key={l.layerId} className={styles.row}>
      <span className={styles.name}>
        {l.productName}
        <span className={styles.detail}>
          {formatQty(l.remaining)} left of this delivery
          {l.supplier ? ` · from ${l.supplier}` : ''}
        </span>
        <span className={styles.detail}>
          Came in {new Date(l.receivedAt).toLocaleDateString()} at{' '}
          {formatMoney(l.unitCost)} each
        </span>
        {gone && can('stock.adjust') && (
          <span className={styles.rowAction}>
            <Button
              variant="secondary"
              onClick={() => {
                setPending(l);
                confirm.open();
              }}
              disabled={busy === l.layerId}
            >
              {busy === l.layerId ? 'Taking it off…' : 'Take it off the shelf'}
            </Button>
          </span>
        )}
      </span>
      <span className={styles.when}>
        <span className={gone ? styles.gone : l.daysLeft <= 7 ? styles.close : styles.fine}>
          {said(l)}
        </span>
        <span className={styles.value}>{formatMoney(l.valueAtCost)}</span>
      </span>
    </li>
  );

  return (
    <PageScaffold onBack={goBack} title="Going off" subtitle="Dated stock, soonest first">
      <ProblemDialog problem={problem} title="Could not read what is going off" />

      <ConfirmDialog
        controller={confirm}
        title="Write this off?"
        message={
          pending
            ? `${formatQty(pending.remaining)} of ${pending.productName} comes off the shelf and ` +
              `is recorded as damage worth ${formatMoney(pending.valueAtCost)}. The delivery it ` +
              `came from keeps its history.`
            : undefined
        }
        confirmText="Write it off"
        onConfirm={() => {
          if (pending) void takeOff(pending);
        }}
      />

      <InfoPanel id="expiry.what" tone="info" title="Each delivery keeps its own date">
        The same item can arrive twice in a month at two prices with two dates. What you see here is
        each delivery on its own, because that is what is actually sitting on the shelf — and what
        gets sold first.
      </InfoPanel>

      {/* How far ahead to look. Anything already past shows whatever the window. */}
      <div className={styles.windows} role="tablist" aria-label="How far ahead to look">
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            role="tab"
            aria-selected={days === w}
            className={`${styles.window} ${days === w ? styles.windowOn : ''}`}
            onClick={() => setDays(w)}
          >
            {w} days
          </button>
        ))}
      </div>

      <LoadArea area={area} what="what is going off">
        {(rows) => {
          const gone = rows.filter((r) => r.daysLeft < 0);
          const soon = rows.filter((r) => r.daysLeft >= 0);
          return (
            <>
              {gone.length > 0 && (
                <>
                  <h2 className={styles.section}>Already out of date</h2>
                  <InfoPanel tone="danger" title="This cannot be sold">
                    Take it off the shelf so your stock figures stop counting it. It is recorded as
                    damage at what it cost, which is what it really was.
                  </InfoPanel>
                  <ul className={styles.rows}>{gone.map((l) => renderRow(l, true))}</ul>
                </>
              )}

              <h2 className={styles.section}>
                {gone.length > 0 ? 'Coming up' : `Going off within ${days} days`}
              </h2>
              {soon.length === 0 ? (
                <p className={styles.none}>
                  Nothing dated goes off in the next {days} days. Anything with no date on it never
                  appears here — put a date on a delivery line when it matters.
                </p>
              ) : (
                <ul className={styles.rows}>{soon.map((l) => renderRow(l, false))}</ul>
              )}
            </>
          );
        }}
      </LoadArea>
    </PageScaffold>
  );
}

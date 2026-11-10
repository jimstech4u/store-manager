'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { CheckIcon, CloseIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { useDraftOrders } from '@/lib/stacks/draft-orders';
import { stockInShapes, useSellingUnits, type SellingUnit } from '@/lib/stacks/selling-units';
import {
  countedByWords,
  countsChanged,
  useTodaysCounts,
  useUncountedToday,
} from '@/lib/stacks/count-gate';
import { countFromTill } from '@/lib/stacks/mid-sale';
import { messageOf } from '@/lib/format';
import styles from './count-gate-page.module.css';

/** An item on this sale that has not been counted today, with every shape the shop names for it. */
interface Uncounted {
  productId: string;
  productName: string;
  shapes: SellingUnit[];
}

/** One counted item, listed until the count is recorded. */
interface Line {
  productId: string;
  productName: string;
  base: number;
  said: string;
}

/**
 * Counting the shelf before an item can be sold today.
 *
 * A GATE, NOT A SUGGESTION. It was offered and skippable, and a sale could be left open overnight
 * and settled the next day against a shelf nobody had counted. The till pushes this page whenever
 * the open sale holds something not counted today — when the sale is opened, and whenever an item
 * is added — and Take payment will not settle until nothing is left here.
 *
 * ONE CHECKLIST (10 Nov). Every item still to count is a row, in the order it is on the sale, with
 * a bar saying how far along the count is. Tapping a row opens it in place — a box for each shape
 * the shop names (crates and loose bottles, the way it is stacked) and Add — and a counted row shows
 * its figure with a tick until it is recorded. It used to be a button that opened a sheet to choose
 * the item, then a form: two taps per item and never the whole job in view. Only one row is open at
 * a time, so it is never a wall of boxes, one per item.
 *
 * `focus` in the push names the item just added, so it arrives already chosen.
 */
export default function CountGatePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const { activeOrder } = useDraftOrders(store?.id ?? null);
  const {
    byProduct,
    loaded: unitsLoaded,
    error: unitsError,
    reload: reloadUnits,
  } = useSellingUnits(store?.id ?? null);

  const lineIds = useMemo(
    () => (activeOrder?.lines ?? []).map((l) => l.productId),
    [activeOrder?.lines],
  );
  const {
    uncounted,
    checked,
    error: countsError,
    reload: reloadCounts,
  } = useUncountedToday(store?.id ?? null, lineIds);
  /*
   * RE-ASKED WHENEVER THIS PAGE COMES BACK INTO VIEW.
   *
   * Another device may have counted the item while this receipt sat open, or the day may have turned
   * over. The server's answer on resume is the one that counts — never what this device remembered.
   */
  useLiveRefresh(nav, reloadCounts);

  /*
   * Items another device counted first. Not a failure: the item IS counted, which is all the gate
   * asks — this figure just was not the one recorded, and the seller should know that.
   */
  const [countedElsewhere, setCountedElsewhere] = useState<string[]>([]);

  /*
   * WHAT IS ALREADY COUNTED ON THIS SALE, and by whom.
   *
   * An item another till counted this morning is not asked about here — the server already has its
   * count — but the seller should be able to see that it was, rather than wonder why it is missing.
   */
  const { byProduct: todays } = useTodaysCounts(store?.id ?? null, lineIds);
  const countedOnSale = useMemo(() => {
    const seen = new Set<string>();
    return (activeOrder?.lines ?? []).flatMap((l) => {
      const c = todays.get(l.productId);
      if (!c || seen.has(l.productId) || uncounted.includes(l.productId)) return [];
      seen.add(l.productId);
      return [{ productId: l.productId, productName: l.productName, count: c }];
    });
  }, [activeOrder?.lines, todays, uncounted]);

  /* Why the till sent the seller here — said in the lead, so the page is not a surprise. */
  const why = (location?.params?.why as string | undefined) ?? null;

  const [lines, setLines] = useState<Line[]>([]);

  /* STILL TO COUNT: on the sale, not counted today, and not already added to this form. */
  const remaining = useMemo<Uncounted[]>(
    () =>
      uncounted
        .filter((id) => !lines.some((l) => l.productId === id))
        .map((id) => ({
          productId: id,
          productName:
            activeOrder?.lines.find((l) => l.productId === id)?.productName ?? 'This item',
          shapes: [...(byProduct.get(id) ?? [])].sort((a, b) => b.baseQty - a.baseQty),
        })),
    [uncounted, lines, activeOrder?.lines, byProduct],
  );

  /* EVERY ITEM TO COUNT, counted on this form or not — the checklist's rows. */
  const toCount = useMemo<Uncounted[]>(
    () =>
      uncounted.map((id) => ({
        productId: id,
        productName:
          activeOrder?.lines.find((l) => l.productId === id)?.productName ?? 'This item',
        shapes: [...(byProduct.get(id) ?? [])].sort((a, b) => b.baseQty - a.baseQty),
      })),
    [uncounted, activeOrder?.lines, byProduct],
  );

  const [chosen, setChosen] = useState<Uncounted | null>(null);
  const [byShape, setByShape] = useState<Record<string, string>>({});
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * THE ITEM JUST ADDED ARRIVES CHOSEN — and on opening, the first one still to count.
   *
   * Once, when nothing is chosen yet, so picking something else is never overridden.
   */
  const focus = (location?.params?.focus as string | undefined) ?? null;
  useEffect(() => {
    if (chosen || remaining.length === 0) return;
    const first = remaining.find((r) => r.productId === focus) ?? remaining[0];
    setChosen(first);
    setByShape({});
    // Only when the list first becomes available or empties of the chosen item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining.length, focus]);

  if (!store) return null;

  /* A BLANK IS NOT A NOUGHT: a box left empty says nothing, and a typed 0 is a count. */
  const said = (v: string | undefined) =>
    v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;

  const addChosen = () => {
    if (!chosen) return;
    const shapes = chosen.shapes.length > 0 ? chosen.shapes : [];
    const base =
      shapes.length > 0
        ? shapes.reduce((sum, u) => sum + (Number(byShape[u.productUnitId]) || 0) * u.baseQty, 0)
        : Number(byShape.base) || 0;
    const words =
      shapes.length > 0
        ? stockInShapes(shapes.map((u) => ({ ...u, onHandBase: base })))
        : String(base);
    setLines((prev) => [
      ...prev.filter((l) => l.productId !== chosen.productId),
      { productId: chosen.productId, productName: chosen.productName, base, said: words },
    ]);
    // On to the next one still to count, already open — counting a sale is Add, Add, Record.
    setChosen(remaining.find((r) => r.productId !== chosen.productId) ?? null);
    setByShape({});
  };

  const canAdd =
    !!chosen &&
    (chosen.shapes.length > 0
      ? chosen.shapes.some((u) => said(byShape[u.productUnitId]))
      : said(byShape.base));

  const shapesOf = (id: string) =>
    [...(byProduct.get(id) ?? [])].sort((a, b) => b.baseQty - a.baseQty);

  const save = async () => {
    setState('busy');
    setFailure(null);
    try {
      const elsewhere: string[] = [];
      for (const l of lines) {
        try {
          // In base units — the multiplication was done when the line was added.
          await countFromTill(l.productId, l.base);
        } catch (e) {
          /*
           * ONE COUNT PER ITEM PER DAY, decided by the server.
           *
           * `unique_violation` means another till counted this item first — possibly seconds ago, on
           * another receipt. The item is counted, so the gate is satisfied; this figure is not the
           * one recorded, and the seller is told so rather than shown an error.
           */
          if ((e as { code?: string }).code === '23505') {
            elsewhere.push(l.productId);
            continue;
          }
          throw e;
        }
      }
      setCountedElsewhere(elsewhere);
      // Every screen asking "what is still uncounted today" re-asks: the till, and Take payment.
      countsChanged();
      setState('idle');
      setLines([]);
      /*
       * Back to the sale only when nothing is left. With items still to count the page stays, and
       * the list it offers re-reads itself from what was just recorded.
       */
      if (remaining.length === 0 && elsewhere.length === 0) void nav.pop();
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'That count could not be recorded.'));
    }
  };

  const total = remaining.length + lines.length;

  /*
   * "Everything on this sale is counted" was drawn before the server had said so — the uncounted
   * list starts empty — and the boxes had no shapes to draw until the item's units arrived.
   */
  const status: PageStatus = !checked
    ? countsError
      ? { state: 'error', what: 'what still needs counting', error: countsError, onRetry: reloadCounts }
      : { state: 'loading', what: 'what still needs counting' }
    : !unitsLoaded
      ? unitsError
        ? { state: 'error', what: 'what they are counted in', error: unitsError, onRetry: reloadUnits }
        : { state: 'loading', what: 'what they are counted in' }
      : { state: 'ready' };

  return (
    <PageScaffold
      layout="record"
      onBack={goBack}
      title="Count before selling"
      subtitle="What is on the shelf right now"
    >
      {/*
        SAID ON THE PAGE, because it is a fact about what was recorded rather than a failure to be
        dismissed — the page stays open so the seller reads it before going back to the sale.
      */}
      {countedElsewhere.length > 0 && (
        <InfoPanel tone="info" title="Somebody counted first">
          {countedElsewhere
            .map((id) => {
              const c = todays.get(id);
              const name =
                activeOrder?.lines.find((l) => l.productId === id)?.productName ?? 'An item';
              return c ? `${name} was counted ${countedByWords(c)}` : `${name} was already counted`;
            })
            .join('. ')}
          . That count stands and yours was not recorded — nothing else needs doing.
        </InfoPanel>
      )}

      <PageState status={status}>
        {() => (
          <>
      {total === 0 ? (
        <InfoPanel tone="success" title="Everything on this sale is counted">
          There is nothing left to count today. Go back and carry on with the sale.
        </InfoPanel>
      ) : (
        <>
          <p className={styles.lead}>
            Count the shelf before {total === 1 ? 'it goes' : 'they go'} out, so the day starts from
            a figure somebody checked.{' '}
            {why === 'share'
              ? 'The order can be shared once everything on it is counted.'
              : why === 'pay'
                ? 'Payment can be taken once everything on it is counted.'
                : `The sale cannot be settled until ${total === 1 ? 'it is' : 'they are'}.`}{' '}
            Each item is counted once a day — if another till gets there first, its count stands.
          </p>

          {/* How far along: the whole job, in one line. */}
          <div className={styles.progress} aria-label="How far along">
            <p className={styles.progressText}>
              <strong>{lines.length}</strong> of {total} counted
            </p>
            <div className={styles.progressBar}>
              <span style={{ width: `${Math.round((lines.length / total) * 100)}%` }} />
            </div>
          </div>

          <ol className={styles.checklist}>
            {toCount.map((item) => {
              const line = lines.find((l) => l.productId === item.productId);
              const open = chosen?.productId === item.productId;

              /* Counted on this form, waiting to be recorded. */
              if (line && !open) {
                return (
                  <li key={item.productId} className={`${styles.item} ${styles.itemDone}`}>
                    <span className={styles.itemTick} aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span className={styles.itemBody}>
                      <span className={styles.itemName}>{item.productName}</span>
                      <span className={styles.itemMeta}>{line.said}</span>
                    </span>
                    <button
                      type="button"
                      className={styles.itemAgain}
                      onClick={() => {
                        setChosen(item);
                        setByShape({});
                      }}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      className={styles.lineRemove}
                      onClick={() => setLines((prev) => prev.filter((x) => x.productId !== item.productId))}
                      aria-label={`Take ${item.productName} off the count`}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                );
              }

              /* Open: how many, in the item's own shapes — on the page, never in a sheet. */
              if (open && chosen) {
                return (
                  <li key={item.productId} className={`${styles.item} ${styles.itemOpen}`}>
                    <div className={styles.composerHead}>
                      <p className={styles.composerWho}>{chosen.productName}</p>
                    </div>

                    <div className={styles.shapeBoxes}>
                      {chosen.shapes.length > 0 ? (
                        chosen.shapes.map((u) => (
                          <Field
                            key={u.productUnitId}
                            label={u.plural}
                            numeric
                            whole={u.wholeDigit}
                            value={byShape[u.productUnitId] ?? ''}
                            onChange={(e) =>
                              setByShape((prev) => ({ ...prev, [u.productUnitId]: e.target.value }))
                            }
                            placeholder="0"
                            hint={u.baseQty > 1 ? `one is ${u.baseQty}` : undefined}
                          />
                        ))
                      ) : (
                        <Field
                          label="How many"
                          numeric
                          value={byShape.base ?? ''}
                          onChange={(e) => setByShape({ base: e.target.value })}
                          placeholder="0"
                        />
                      )}
                    </div>

                    <p className={styles.composerWhy}>
                      Count every shape you see — full crates and the loose ones. Leave a box blank
                      only if there are none of that shape.
                    </p>

                    <div className={styles.composerActions}>
                      <Button variant="secondary" onClick={() => setChosen(null)}>
                        Cancel
                      </Button>
                      <Button disabled={!canAdd} onClick={addChosen}>
                        {line ? 'Change the count' : 'Add'}
                      </Button>
                    </div>
                  </li>
                );
              }

              /* Still to count: the whole row opens it. */
              return (
                <li key={item.productId} className={styles.item}>
                  <button
                    type="button"
                    className={styles.itemRow}
                    onClick={() => {
                      setChosen(item);
                      setByShape({});
                    }}
                  >
                    <span className={styles.itemDot} aria-hidden="true" />
                    <span className={styles.itemBody}>
                      <span className={styles.itemName}>{item.productName}</span>
                      <span className={styles.itemMeta}>
                        {item.shapes.length > 0
                          ? `In ${item.shapes.map((u) => u.plural.toLowerCase()).join(' and ')}`
                          : 'Not counted today'}
                      </span>
                    </span>
                    <span className={styles.itemGo}>Count</span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
          <div className={styles.pageActions}>
            <Button variant="secondary" onClick={() => void nav.pop()} disabled={state === 'busy'}>
              Not now
            </Button>
            <AsyncAction state={state} problem={failure} label="Recording the count">
              <Button disabled={lines.length === 0} onClick={() => void save()}>
                {lines.length === 0
                  ? 'Nothing counted yet'
                  : `Record ${lines.length} ${lines.length === 1 ? 'count' : 'counts'}`}
              </Button>
            </AsyncAction>
          </div>

          {remaining.length > 0 && lines.length > 0 && (
            <InfoPanel tone="warning" title={`${remaining.length} still to count`}>
              You can record what you have counted now, but the sale will not settle until every item
              on it is counted.
            </InfoPanel>
          )}
        </>
      )}

      {countedOnSale.length > 0 && (
        <section className={styles.counted} aria-label="Already counted today">
          {/*
            COUNTED, SO NOT ASKED AGAIN. Mid-sale a shelf is counted once a day by whoever reaches it
            first — a second figure from a till, with a customer waiting, is how a count becomes a
            guess. Walking the shelf again is a manager's job, on the item's own screen.
          */}
          <h2 className={styles.countedHead}>Already counted today</h2>
          <ul className={styles.lineList}>
            {countedOnSale.map((c) => {
              const shapes = shapesOf(c.productId);
              return (
                <li key={c.productId} className={styles.lineRow}>
                  <span className={styles.countedText}>
                    <strong>{c.productName}</strong> ·{' '}
                    {shapes.length > 0
                      ? stockInShapes(shapes.map((u) => ({ ...u, onHandBase: c.count.countedBase })))
                      : c.count.countedBase}
                    <span className={styles.countedWho}>
                      {countedByWords(c.count)}
                      {c.count.edits > 0 ? ` · corrected by ${c.count.lastEditedBy}` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
          </>
        )}
      </PageState>

    </PageScaffold>
  );
}

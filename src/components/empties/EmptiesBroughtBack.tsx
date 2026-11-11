'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { Qty } from '@/components/ui/Qty';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { rollUpOwed, settleLine, type OwedLine, type OwedRow } from '@/lib/empties-rollup';
import {
  emptiesOwed,
  LEDGERS_SCOPE,
  returnOwedRow,
  saleEmptiesOwed,
} from '@/lib/stacks/customer-ledgers';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { messageOf } from '@/lib/format';
import { saleEmpties, setSaleEmptiesBack, type SaleContainer } from '@/lib/stacks/sale-empties';
import { ContainersBack } from './ContainersBack';
import styles from './EmptiesBroughtBack.module.css';

/**
 * EMPTIES BROUGHT BACK — every line a customer still holds, each settled where it is read.
 *
 * "some customers bring their empties as they come back to buy ... settle empties before we even
 * print, so the receipt will not carry 'still with you' if they brought it already ... a button like
 * brought all ... and each line can have settle and partial; on settle we confirm with a dialog, on
 * partial push the page."
 *
 * One block, used where the shop meets the question:
 *
 *   ON A JUST-SETTLED RECEIPT, before it is printed or shared. `atSale` dates what comes back at
 *   the sale's own moment and points it at the sale — the receipt reads "still with you" as at
 *   the sale, so crates carried in to the counter must be back by then, or the paper says the
 *   customer still has what is standing in the yard.
 *
 *   ON THE ACCOUNT, any day. No `atSale`: dated now.
 *
 * ALL BACK asks first, in a dialog — it clears a whole line. PART pushes the empties page, which
 * already knows how to take some crates and a few loose bottles.
 */
export function EmptiesBroughtBack({
  storeId,
  customerId,
  forSale = null,
  title = 'Did they bring any back?',
  onRecorded,
  onAsking,
}: {
  storeId: string;
  customerId: string;
  /**
   * ONE SALE'S CONTAINERS ONLY — on its receipt.
   *
   * "the empties to be settled before the receipt is just the qty that sale contributed, not the
   * whole empties the customer has." What comes back is recorded against the sale; once the sale's
   * own are all back the block has nothing to say and is not drawn.
   *
   * `occurredAt` is the sale's moment when this is asked AT THE COUNTER (a fresh receipt), so the
   * paper's "still with you" — read as at the sale — is true. Null on an older receipt: dated now.
   */
  forSale?: { id: string; occurredAt: string | null } | null;
  title?: string;
  /** After anything is recorded — the receipt re-reads, so the paper says the new figure. */
  onRecorded?: () => void;
  /**
   * Told how many kinds of container the question is still about — 0 once they are all back, null
   * until it is known. The receipt waits on it before printing by itself, so "still with you" on
   * the paper is the answer, not the question.
   */
  onAsking?: (kinds: number | null) => void;
}) {
  const nav = useNav();
  const problem = useProblem();

  /*
   * AND WHAT THEY HAD FROM BEFORE, when they bring that too.
   *
   * "When settling empties we only see buttons for that particular sale, with no outstanding. Maybe a
   * checkbox that loads the old ones if they brought them." On a receipt the block starts with this
   * sale's own containers; ticked, it lists everything they hold — what this sale sent out and what
   * was already out — and settles any of it here, at the sale's moment, so the paper is true.
   */
  const [withOlder, setWithOlder] = useState(false);
  const bySale = Boolean(forSale) && !withOlder;

  const area = useLoadArea<OwedRow[]>(
    () => (bySale ? saleEmptiesOwed(forSale!.id) : emptiesOwed(customerId)),
    [customerId, forSale?.id, bySale],
    {
      key: bySale ? `sale-empties-owed:${forSale!.id}` : `empties-owed:${customerId}`,
      scope: LEDGERS_SCOPE,
      onFail: problem.show,
    },
  );
  // Everything they hold, to know whether there is anything older to offer.
  const all = useLoadArea<OwedRow[]>(() => emptiesOwed(customerId), [customerId], {
    key: `empties-owed:${customerId}`,
    scope: LEDGERS_SCOPE,
    whenNot: !forSale,
  });
  const rows = useMemo(
    () => (area.data ?? []).filter((r) => r.owed > 0 && (r.side ?? 'they_hold') === 'they_hold'),
    [area.data],
  );
  const heldInAll = useMemo(
    () =>
      (all.data ?? [])
        .filter((r) => r.owed > 0 && (r.side ?? 'they_hold') === 'they_hold')
        .reduce((sum, r) => sum + r.owed * r.baseQty, 0),
    [all.data],
  );
  const heldBySale = useMemo(
    () => (bySale ? rows.reduce((sum, r) => sum + r.owed * r.baseQty, 0) : 0),
    [bySale, rows],
  );
  const hasOlder = Boolean(forSale) && (withOlder || heldInAll - heldBySale > 1e-6);
  const lines = useMemo(() => rollUpOwed(rows), [rows]);
  const askingRef = useRef(onAsking);
  askingRef.current = onAsking;
  const asked = area.data === null ? null : lines.length;
  // (On a receipt this is also told from `sale_empties` below, once that has been read.)
  useEffect(() => {
    askingRef.current?.(asked);
  }, [asked]);

  /* Mounted means asked — see ConfirmDialog. Which question: one line, or everything. */
  const [asking, setAsking] = useState<{ line: OwedLine | null } | null>(null);
  const dialog = useConfirm();
  const [busy, setBusy] = useState(false);

  const record = async (which: OwedLine[]) => {
    setBusy(true);
    try {
      for (const line of which) {
        for (const part of settleLine(line, rows)) {
          await returnOwedRow({
            storeId,
            customerId,
            row: part.row,
            direction: 'returned',
            qty: part.qty,
            reason: forSale ? 'Brought back against this receipt' : 'Brought back',
            occurredAt: forSale?.occurredAt ?? null,
            refTable: forSale ? 'sales' : null,
            refId: forSale?.id ?? null,
          });
        }
      }
      accountsChanged();
      area.reload();
      all.reload();
      onRecorded?.();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const words = (l: OwedLine) => `${l.said} ${l.label} ${l.unit.toLowerCase()}`;

  /*
   * THIS RECEIPT'S OWN CONTAINERS (0280): out, and back with − and +. All back is one tap, and so is
   * None back — "they did not bring those back after all" — because the − goes below what was
   * recorded, which is the undo. The block stays on the receipt once all is back, so it can be.
   */
  const saleArea = useLoadArea<SaleContainer[]>(() => saleEmpties(forSale!.id), [forSale?.id], {
    key: `sale-empties:${forSale?.id ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    whenNot: !forSale,
    onFail: problem.show,
  });
  const [targets, setTargets] = useState<Record<string, number>>({});
  /** What the last save did, said under the buttons, and what it was before — for its Undo. */
  const [saved, setSaved] = useState<{ said: string; before: Record<string, number> } | null>(null);
  useEffect(() => setTargets({}), [saleArea.data]);
  const containers = saleArea.data ?? [];
  const rowsBack = containers.map((c) => ({
    id: c.productUnitId,
    name: c.productName,
    unitName: c.unitName,
    unitPlural: c.unitPlural,
    out: c.wentOut,
    back: targets[c.productUnitId] ?? c.cameBack,
    max: Math.max(c.wentOut, c.cameBack),
    was: c.cameBack,
  }));
  const changes = rowsBack.filter((r) => Math.abs(r.back - r.was) > 1e-9);
  const saveBack = async (wanted: Record<string, number>) => {
    if (!forSale) return;
    const units = containers
      .filter((c) => wanted[c.productUnitId] !== undefined && Math.abs(wanted[c.productUnitId] - c.cameBack) > 1e-9)
      .map((c) => ({ productUnitId: c.productUnitId, qty: wanted[c.productUnitId] }));
    if (units.length === 0) return;
    setBusy(true);
    try {
      await setSaleEmptiesBack(forSale.id, units, { atSale: Boolean(forSale.occurredAt) });
      // Said in words: what came back now, and what is still with them.
      const after = containers.map((c) => ({ c, back: wanted[c.productUnitId] ?? c.cameBack }));
      const back = after.reduce((n, x) => n + Math.min(x.back, x.c.wentOut), 0);
      const left = after.reduce((n, x) => n + Math.max(x.c.wentOut - x.back, 0), 0);
      const unit = (containers[0]?.unitPlural || 'containers').toLowerCase();
      setSaved({
        said: left <= 0 ? `Saved: all came back` : back <= 0 ? `Saved: none came back · ${left} ${unit} still with them` : `Saved: ${back} back · ${left} ${unit} still with them`,
        before: Object.fromEntries(containers.map((c) => [c.productUnitId, c.cameBack])),
      });
      saleArea.reload();
      area.reload();
      all.reload();
      onRecorded?.();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  if (forSale && !withOlder) {
    // Nothing went out with it and nothing older is out: nothing to ask.
    if (saleArea.data !== null && containers.length === 0 && !hasOlder) return null;
    const stillOut = rowsBack.reduce((n, r) => n + Math.max(r.out - r.back, 0), 0);
    return (
      <section className={styles.block} aria-label={title}>
        <ProblemDialog problem={problem} title="Not recorded" />
        <h2 className={styles.head}>{stillOut > 0 || containers.length === 0 ? title : 'Empties — all back'}</h2>
        {hasOlder && (
          <label className={styles.older}>
            <input type="checkbox" checked={withOlder} onChange={(e) => setWithOlder(e.target.checked)} />
            <span>Include what they had from before</span>
          </label>
        )}
        <LoadArea area={saleArea} what="this receipt's empties" compact>
          {() =>
            containers.length === 0 ? null : (
              <>
                <ContainersBack
                  rows={rowsBack}
                  saving={busy}
                  onChange={(id, back) => {
                    setSaved(null);
                    setTargets((t) => ({ ...t, [id]: back }));
                  }}
                  onAll={(wanted) => void saveBack(wanted)}
                  status={
                    saved && changes.length === 0 ? (
                      <>
                        <span>✓ {saved.said}</span>
                        <button type="button" disabled={busy} onClick={() => void saveBack(saved.before)}>
                          Undo
                        </button>
                      </>
                    ) : null
                  }
                />
                {changes.length > 0 && (
                  <div className={styles.saveRow}>
                    <Button variant="secondary" size="small" disabled={busy} onClick={() => setTargets({})}>
                      Cancel
                    </Button>
                    <Button
                      size="small"
                      busy={busy}
                      busyLabel="Saving"
                      onClick={() => void saveBack(Object.fromEntries(rowsBack.map((r) => [r.id, r.back])))}
                    >
                      Save {changes.length === 1 ? 'this change' : `${changes.length} changes`}
                    </Button>
                  </div>
                )}
              </>
            )
          }
        </LoadArea>
      </section>
    );
  }

  // On a receipt, a sale whose containers are all back — and nothing older out — has nothing to ask.
  if (forSale && area.data !== null && lines.length === 0 && !hasOlder) return null;

  return (
    <section className={styles.block} aria-label={title}>
      <ProblemDialog problem={problem} title="Not recorded" />
      <h2 className={styles.head}>{title}</h2>
      {hasOlder && (
        <label className={styles.older}>
          <input
            type="checkbox"
            checked={withOlder}
            onChange={(e) => setWithOlder(e.target.checked)}
          />
          <span>Include what they had from before</span>
        </label>
      )}
      <LoadArea area={area} what="what they are holding" compact>
        {() =>
          lines.length === 0 ? (
            <p className={styles.note}>Nothing of yours is with them.</p>
          ) : (
            <>
              <ul className={styles.list}>
                {lines.map((l, i) => (
                  <li key={`${l.label}-${l.unit}-${i}`} className={styles.row}>
                    <span className={styles.what}>
                      {/* The part set smaller than the whole, the way the empties list sets it. */}
                      <strong><Qty value={l.qty} /></strong> {l.label} {l.unit.toLowerCase()}
                      {l.products.length > 1 && (
                        <span className={styles.from}>{l.products.join(' + ')}</span>
                      )}
                    </span>
                    <span className={styles.actions}>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => setAsking({ line: l })}
                      >
                        All back
                      </Button>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void nav.push('empties_record_page', {
                            id: customerId,
                            line: String(i),
                            ...(forSale ? { sale: forSale.id } : {}),
                            ...(forSale?.occurredAt ? { at: 'sale' } : {}),
                            ...(forSale && withOlder ? { all: '1' } : {}),
                          })
                        }
                      >
                        Part
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              {lines.length > 1 && (
                <Button
                  variant="secondary"
                  fullWidth
                  busy={busy}
                  busyLabel="Recording"
                  onClick={() => setAsking({ line: null })}
                >
                  They brought everything back
                </Button>
              )}
            </>
          )
        }
      </LoadArea>

      {asking && (
        <ConfirmDialog
          controller={dialog}
          tone="primary"
          title={asking.line ? `All ${words(asking.line)} back?` : 'Everything back?'}
          message={
            asking.line
              ? `${words(asking.line)} come off what they hold${forSale ? ', against this receipt' : ''}.`
              : `${lines.map(words).join(', ')} come off what they hold${forSale ? ', against this receipt' : ''}.`
          }
          confirmText="Yes, they are back"
          onDismiss={() => setAsking(null)}
          onConfirm={() => void record(asking.line ? [asking.line] : lines)}
        />
      )}
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { rollUpOwed, settleLine, type OwedLine, type OwedRow } from '@/lib/empties-rollup';
import {
  emptiesOwed,
  LEDGERS_SCOPE,
  recordEmpties,
  saleEmptiesOwed,
} from '@/lib/stacks/customer-ledgers';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { messageOf } from '@/lib/format';
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
}) {
  const nav = useNav();
  const problem = useProblem();

  const area = useLoadArea<OwedRow[]>(
    () => (forSale ? saleEmptiesOwed(forSale.id) : emptiesOwed(customerId)),
    [customerId, forSale?.id],
    {
      key: forSale ? `sale-empties-owed:${forSale.id}` : `empties-owed:${customerId}`,
      scope: LEDGERS_SCOPE,
      onFail: problem.show,
    },
  );
  const rows = useMemo(
    () => (area.data ?? []).filter((r) => r.owed > 0 && (r.side ?? 'they_hold') === 'they_hold'),
    [area.data],
  );
  const lines = useMemo(() => rollUpOwed(rows), [rows]);

  /* Mounted means asked — see ConfirmDialog. Which question: one line, or everything. */
  const [asking, setAsking] = useState<{ line: OwedLine | null } | null>(null);
  const dialog = useConfirm();
  const [busy, setBusy] = useState(false);

  const record = async (which: OwedLine[]) => {
    setBusy(true);
    try {
      for (const line of which) {
        for (const part of settleLine(line, rows)) {
          await recordEmpties({
            storeId,
            customerId,
            productUnitId: part.productUnitId,
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
      onRecorded?.();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const words = (l: OwedLine) => `${l.said} ${l.label} ${l.unit.toLowerCase()}`;

  // On a receipt, a sale whose containers are all back has nothing to ask.
  if (forSale && area.data !== null && lines.length === 0) return null;

  return (
    <section className={styles.block} aria-label={title}>
      <ProblemDialog problem={problem} title="Not recorded" />
      <h2 className={styles.head}>{title}</h2>
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
                      <strong>{l.said}</strong> {l.label} {l.unit.toLowerCase()}
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

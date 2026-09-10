'use client';

import { useCallback, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { PlusIcon } from '@/components/ui/Icon';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, formatQty } from '@/lib/format';
import styles from './suppliers-page.module.css';

interface SupplierAccount {
  id: string;
  name: string;
  phone: string | null;
  owed: number;
  deliveries: number;
  emptiesOut: number;
  lastAt: string | null;
}

/**
 * Who the shop buys from, and where it stands with each of them.
 *
 * The mirror of the People screen. A shop keeps a ledger for everybody it sells to — what they owe,
 * what they paid, what of the shop's they are holding — and kept nothing at all for the people it
 * buys from, though the relationship is the same one seen from the other side.
 *
 * WHAT IS OWED IS THE HEADLINE, because that is the question somebody opens this asking. Containers
 * sit beside it rather than being folded in: money and crates settle separately, on different days,
 * and one figure covering both is a figure nobody can act on.
 */
export default function SuppliersPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const read = useCallback(async (): Promise<SupplierAccount[]> => {
    const { data, error } = await getSupabase().rpc('suppliers_with_accounts', {
      p_store_id: store!.id,
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      phone: (r.phone as string | null) ?? null,
      owed: Number(r.owed) || 0,
      deliveries: Number(r.deliveries) || 0,
      emptiesOut: Number(r.empties_out) || 0,
      lastAt: (r.last_at as string | null) ?? null,
    }));
  }, [store]);

  const area = useLoadArea<SupplierAccount[]>(read, [store?.id], {
    onFail: showProblem,
    whenNot: !store,
  });

  // Coming back from a delivery or a payment, the figures have moved. No polling: the lifecycle
  // says when somebody is actually looking.
  useLiveRefresh(nav, () => area.reload());

  const [showing] = useState(true);
  const rows = area.data ?? [];
  const owedTotal = rows.reduce((sum, r) => sum + Math.max(r.owed, 0), 0);

  return (
    <PageScaffold onBack={goBack} title="Suppliers" subtitle="Who you buy from, and where you stand">
      <ProblemDialog problem={problem} title="Could not read your suppliers" />

      {rows.length > 0 && (
        <div className={styles.headline}>
          <span className={styles.headlineLabel}>You owe altogether</span>
          <span className={styles.headlineValue}>{formatMoney(owedTotal)}</span>
          <span className={styles.headlineNote}>
            across {rows.filter((r) => r.owed > 0).length} of {rows.length}
          </span>
        </div>
      )}

      <div className={styles.actions}>
        <Button fullWidth onClick={() => void nav.push('supplier_form_page')}>
          <PlusIcon /> Add a supplier
        </Button>
      </div>

      {showing && (
        <LoadArea area={area} what="your suppliers">
          {(list) =>
            list.length === 0 ? (
              <InfoPanel tone="info" title="No suppliers yet">
                They appear here as soon as you record a delivery from one, or add one above.
              </InfoPanel>
            ) : (
              <ul className={styles.list}>
                {list.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={styles.row}
                      onClick={() => void nav.push('supplier_account_page', { id: s.id })}
                    >
                      <span className={styles.who}>
                        <span className={styles.name}>{s.name}</span>
                        <span className={styles.meta}>
                          {s.deliveries === 0
                            ? 'no deliveries yet'
                            : `${s.deliveries} ${s.deliveries === 1 ? 'delivery' : 'deliveries'}`}
                          {s.emptiesOut > 0 && ` · ${formatQty(s.emptiesOut)} containers back`}
                        </span>
                      </span>

                      <span className={styles.amount}>
                        {s.owed > 0 ? (
                          <span className={styles.owed}>{formatMoney(s.owed)}</span>
                        ) : s.owed < 0 ? (
                          /* They owe the shop — a rebate, an overpayment. Said, not hidden. */
                          <span className={styles.credit}>
                            {formatMoney(Math.abs(s.owed))} back
                          </span>
                        ) : (
                          <span className={styles.settled}>settled</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadArea>
      )}
    </PageScaffold>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './review-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { BoxIcon, CheckIcon, CloseIcon, PeopleIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatQty, pluralUnit } from '@/lib/format';

interface PendingProduct {
  id: string;
  name: string;
  base_unit: string;
  on_hand: string;
  created_at: string;
}

interface PendingCustomer {
  id: string;
  name: string;
  phone: string;
  created_at: string;
}

interface PendingStock {
  id: string;
  product: string;
  kind: string;
  qty: string;
  balance_before: string;
  balance_after: string;
  occurred_at: string;
}

interface Queue {
  products: PendingProduct[];
  customers: PendingCustomer[];
  stock_entries: PendingStock[];
}

const KIND_LABEL: Record<string, string> = {
  opening: 'First count',
  adjustment: 'Adjustment',
  damage: 'Damaged',
  repack_loss: 'Lost repacking',
};

/**
 * The review queue.
 *
 * The other half of "anyone can add what they need". Staff keep the shop moving; a manager
 * confirms afterwards. Without this screen the pending state would just be an invisible label
 * nobody ever cleared.
 *
 * Written to be understood by someone who has never used software like this. Every item says
 * what it is, who is asking, and what confirming will do — because "confirm" on its own is a
 * word people click without knowing what they agreed to.
 */
export default function ReviewPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  const [queue, setQueue] = useState<Queue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!store) return;
    const { data, error: err } = await getSupabase().rpc('pending_review', {
      p_store_id: store.id,
    });
    if (err) {
      setError(err.message);
      return;
    }
    setQueue(data as unknown as Queue);
  }, [store]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not do that');
    } finally {
      setBusy(null);
    }
  };

  if (!store) return null;

  if (!can('records.confirm')) {
    return (
      <PageScaffold onBack={goBack} title="Waiting for approval">
        <InfoPanel tone="info" title="A manager handles this">
          Anything you add is saved and usable straight away. A manager or the owner checks it
          afterwards — you do not need to wait for them before serving a customer.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (!queue) return <FullPageMessage title="Loading" tone="loading" />;

  const total =
    queue.products.length + queue.customers.length + queue.stock_entries.length;

  return (
    <PageScaffold
      onBack={goBack}
      title="Waiting for you"
      subtitle={total === 0 ? 'Nothing to check' : `${total} to check`}
    >
      {error && (
        <InfoPanel tone="danger" title="Could not do that">
          {error}
        </InfoPanel>
      )}

      {total === 0 ? (
        <InfoPanel tone="success" title="All caught up">
          When your staff add a product, a customer, or enter stock, it will appear here for you
          to check.
        </InfoPanel>
      ) : (
        <InfoPanel tone="info" title="What this is">
          Your staff added these while serving customers, so nobody had to wait. They are already
          working — checking them just confirms the details are right.
          <Explain label="What happens when I confirm?">
            <p>
              Nothing changes about the sales that already used them. Confirming records that you
              have seen the item and agree with it, so the entry stops being flagged as unchecked.
            </p>
            <p style={{ marginTop: 'var(--space-3)' }}>
              For stock, saying <strong>the amount is wrong</strong> does not erase what was
              entered — it adds a correction on top, so the history still shows what was claimed
              and what you changed it to.
            </p>
          </Explain>
        </InfoPanel>
      )}

      {/* ── Products ────────────────────────────────────────────────────────────── */}
      {queue.products.length > 0 && (
        <>
          <h2 className={styles.section}>
            <BoxIcon /> New products
          </h2>
          <p className={styles.sectionNote}>Items your staff started selling.</p>

          <ul className={styles.list}>
            {queue.products.map((p) => (
              <li className={styles.card} key={p.id}>
                <div className={styles.cardMain}>
                  <p className={styles.cardName}>{p.name}</p>
                  <p className={styles.cardMeta}>
                    {formatQty(p.on_hand)} {pluralUnit(p.base_unit, Number(p.on_hand))} in stock ·
                    added {formatDateTime(p.created_at)}
                  </p>
                </div>
                <Button
                  size="small"
                  busy={busy === p.id}
                  onClick={() =>
                    run(p.id, async () => {
                      const { error: e } = await getSupabase().rpc('confirm_product', {
                        p_product_id: p.id,
                      });
                      if (e) throw e;
                    })
                  }
                >
                  <CheckIcon /> Looks right
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Customers ───────────────────────────────────────────────────────────── */}
      {queue.customers.length > 0 && (
        <>
          <h2 className={styles.section}>
            <PeopleIcon /> New customers
          </h2>
          <p className={styles.sectionNote}>People your staff added, usually to sell on credit.</p>

          <ul className={styles.list}>
            {queue.customers.map((c) => (
              <li className={styles.card} key={c.id}>
                <div className={styles.cardMain}>
                  <p className={styles.cardName}>{c.name}</p>
                  <p className={styles.cardMeta}>
                    {c.phone} · added {formatDateTime(c.created_at)}
                  </p>
                </div>
                <Button
                  size="small"
                  busy={busy === c.id}
                  onClick={() =>
                    run(c.id, async () => {
                      const { error: e } = await getSupabase().rpc('confirm_customer', {
                        p_customer_id: c.id,
                      });
                      if (e) throw e;
                    })
                  }
                >
                  <CheckIcon /> Looks right
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Stock ───────────────────────────────────────────────────────────────── */}
      {queue.stock_entries.length > 0 && (
        <>
          <h2 className={styles.section}>Stock entered</h2>
          <p className={styles.sectionNote}>
            Counts and changes your staff recorded. Each shows what the stock was before and
            after.
          </p>

          <ul className={styles.list}>
            {queue.stock_entries.map((s) => (
              <li className={styles.card} key={s.id}>
                <div className={styles.cardMain}>
                  <p className={styles.cardName}>{s.product}</p>
                  <p className={styles.cardMeta}>
                    {KIND_LABEL[s.kind] ?? s.kind} · {formatDateTime(s.occurred_at)}
                  </p>

                  {/* The trace, in words. A signed delta is not something a shop owner should
                      have to decode. */}
                  <div className={styles.trace}>
                    <span className={styles.traceStep}>{formatQty(s.balance_before)}</span>
                    <span className={styles.traceArrow} aria-hidden="true">
                      →
                    </span>
                    <span className={styles.traceDelta}>
                      {Number(s.qty) > 0 ? '+' : '−'}
                      {formatQty(Math.abs(Number(s.qty)))}
                    </span>
                    <span className={styles.traceArrow} aria-hidden="true">
                      →
                    </span>
                    <span className={styles.traceStep}>{formatQty(s.balance_after)}</span>
                  </div>
                </div>

                <div className={styles.cardActions}>
                  <Button
                    size="small"
                    busy={busy === s.id}
                    onClick={() =>
                      run(s.id, async () => {
                        const { error: e } = await getSupabase().rpc('review_movement', {
                          p_movement_id: s.id,
                          p_accepted: true,
                        });
                        if (e) throw e;
                      })
                    }
                  >
                    <CheckIcon /> Correct
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy === s.id}
                    onClick={() =>
                      run(s.id, async () => {
                        const { error: e } = await getSupabase().rpc('review_movement', {
                          p_movement_id: s.id,
                          p_accepted: false,
                          p_note: 'not accepted on review',
                        });
                        if (e) throw e;
                      })
                    }
                  >
                    <CloseIcon /> Wrong
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <WorkedExample
            label="What “wrong” does"
            rows={[
              { label: 'Staff entered', value: '240 pieces' },
              { label: 'You mark it wrong', value: 'a correction of −240 is added' },
              { label: 'History still shows', value: 'both entries', emphasis: true },
            ]}
            note="Nothing is deleted, so anyone looking later can see exactly what happened."
          />
        </>
      )}
    </PageScaffold>
  );
}

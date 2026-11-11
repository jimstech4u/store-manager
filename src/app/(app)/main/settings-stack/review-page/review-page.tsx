'use client';

import { useMemo, useState } from 'react';
import styles from './review-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CheckIcon, CloseIcon } from '@/components/ui/Icon';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useResource } from '@/lib/stacks/resource';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { useSayInShapes } from '@/lib/stacks/selling-units';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useNav } from '@academix-admin/navigation-stack';
import { useStackBack } from '@/hooks/useStackBack';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, messageOf } from '@/lib/format';

interface PendingProduct {
  id: string;
  name: string;
  base_unit: string;
  on_hand: string;
  created_at: string;
  made_by: string | null;
  made_by_name: string | null;
}

interface PendingCustomer {
  id: string;
  name: string;
  phone: string;
  created_at: string;
  made_by: string | null;
  made_by_name: string | null;
}

interface PendingStock {
  id: string;
  product_id: string;
  product: string;
  kind: string;
  qty: string;
  balance_before: string;
  balance_after: string;
  note: string | null;
  created_by: string | null;
  made_by_name: string | null;
  occurred_at: string;
}

interface Queue {
  products: PendingProduct[];
  customers: PendingCustomer[];
  stock_entries: PendingStock[];
}

type Kind = 'stock' | 'customer' | 'item';
type Tab = 'all' | Kind;

/** One thing to check, whatever it is: the page lists them side by side. */
interface Entry {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  when: string;
  /** null: written by Store Manager itself (a fix, a count difference), not by a person. */
  who: string | null;
  whoName: string;
  stock?: PendingStock;
  product?: PendingProduct;
  customer?: PendingCustomer;
}

const KIND_LABEL: Record<string, string> = {
  opening: 'First count',
  adjustment: 'Adjustment',
  damage: 'Damaged',
  repack_loss: 'Lost repacking',
};

const TAB_LABEL: Record<Tab, string> = { all: 'All', stock: 'Stock', customer: 'Customers', item: 'Items' };
const SYSTEM = 'system';
const PAGE = 50;

/**
 * WAITING FOR YOU — what somebody who may not vouch has added, for somebody who may.
 *
 * "Olanike is the admin but it needs the role again to approve what the admin did." The queue sent
 * every count and customer back to whoever made it, so the owner's own 742 entries waited on the
 * owner. Since 0278 the server leaves out anything made by a person who may confirm (making it IS
 * their word) and names the maker of everything else, which is what a checker needs first: whose
 * work am I looking at.
 *
 * So the page is an inbox, worked down: by kind and by person, newest first, each row saying what it
 * is, who made it and when, with its own Confirm — and a selection, because a manager who has looked
 * at twenty counts from one worker says so once (`confirm_reviews`), not twenty times. "Wrong" stays
 * one at a time and asks first: it puts stock back.
 */
export default function ReviewPage() {
  const { store } = useAuth();
  const say = useSayInShapes(store?.id ?? null);
  const nav = useNav();
  const goBack = useStackBack();
  const { can, canOpen } = usePermission();
  const mayConfirm = can('records.confirm');

  // v3: rows carry who made them (0278).
  const res = useResource<Queue>({
    key: `review:v3:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(store) && mayConfirm,
    read: async () => {
      const { data, error } = await getSupabase().rpc('pending_review', { p_store_id: store!.id });
      if (error) throw error;
      return data as unknown as Queue;
    },
  });
  const queue = res.data;

  const [tab, setTab] = useState<Tab>('all');
  const [person, setPerson] = useState<string>('all');
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const problem = useProblem();
  const [rejecting, setRejecting] = useState<PendingStock | null>(null);
  const rejectDialog = useConfirm();
  const [confirmingMany, setConfirmingMany] = useState<Entry[] | null>(null);
  const manyDialog = useConfirm();

  const entries = useMemo<Entry[]>(() => {
    if (!queue) return [];
    const name = (n: string | null, who: string | null) => (who ? (n ?? 'Someone').split('@')[0] : 'Store Manager');
    const all: Entry[] = [
      ...queue.stock_entries.map((s) => ({
        key: `stock:${s.id}`, kind: 'stock' as const, id: s.id, name: s.product, when: s.occurred_at,
        who: s.created_by, whoName: name(s.made_by_name, s.created_by), stock: s,
      })),
      ...queue.customers.map((c) => ({
        key: `customer:${c.id}`, kind: 'customer' as const, id: c.id, name: c.name, when: c.created_at,
        who: c.made_by, whoName: name(c.made_by_name, c.made_by), customer: c,
      })),
      ...queue.products.map((p) => ({
        key: `item:${p.id}`, kind: 'item' as const, id: p.id, name: p.name, when: p.created_at,
        who: p.made_by, whoName: name(p.made_by_name, p.made_by), product: p,
      })),
    ];
    return all.sort((a, b) => b.when.localeCompare(a.when));
  }, [queue]);

  // Who made what is waiting, with how much: the chips.
  const people = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const e of entries) {
      const k = e.who ?? SYSTEM;
      m.set(k, { name: e.whoName, count: (m.get(k)?.count ?? 0) + 1 });
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [entries]);

  const byPerson = entries.filter((e) => person === 'all' || (e.who ?? SYSTEM) === person);
  const count = (k: Tab) => (k === 'all' ? byPerson.length : byPerson.filter((e) => e.kind === k).length);
  const visible = byPerson.filter((e) => tab === 'all' || e.kind === tab);
  const page = visible.slice(0, shown);
  const pickedHere = visible.filter((e) => picked.has(e.key));
  const allPicked = visible.length > 0 && pickedHere.length === visible.length;

  /** Off the list here at once; the server's word follows on the next read. */
  const takeOut = (gone: Entry[]) => {
    const keys = new Set(gone.map((e) => e.key));
    res.set((q) => ({
      products: (q?.products ?? []).filter((r) => !keys.has(`item:${r.id}`)),
      customers: (q?.customers ?? []).filter((r) => !keys.has(`customer:${r.id}`)),
      stock_entries: (q?.stock_entries ?? []).filter((r) => !keys.has(`stock:${r.id}`)),
    }));
    setPicked((p) => {
      const next = new Set(p);
      for (const k of keys) next.delete(k);
      return next;
    });
  };

  const confirm = async (list: Entry[], key: string) => {
    if (!store || list.length === 0) return;
    setBusy(key);
    try {
      const ids = (k: Kind) => list.filter((e) => e.kind === k).map((e) => e.id);
      const { error } = await getSupabase().rpc('confirm_reviews', {
        p_store_id: store.id,
        p_products: ids('item'),
        p_customers: ids('customer'),
        p_movements: ids('stock'),
      });
      if (error) throw error;
      takeOut(list);
    } catch (e) {
      problem.show(messageOf(e, 'Could not confirm that'));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (s: PendingStock) => {
    setBusy(`stock:${s.id}`);
    try {
      const { error } = await getSupabase().rpc('review_movement', {
        p_movement_id: s.id,
        p_accepted: false,
        p_note: 'not accepted on review',
      });
      if (error) throw error;
      takeOut(entries.filter((e) => e.key === `stock:${s.id}`));
    } catch (e) {
      problem.show(messageOf(e, 'Could not undo that'));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!store) return null;

  const status: PageStatus = !mayConfirm
    ? {
        state: 'empty',
        title: 'A manager handles this',
        body: (
          <>
            Anything you add is saved and usable straight away. A manager or the owner checks it
            afterwards — you do not need to wait for them before serving a customer.
          </>
        ),
      }
    : queue
      ? { state: 'ready' }
      : res.error
        ? { state: 'error', what: 'what is waiting', error: res.error, onRetry: res.reload }
        : { state: 'loading', what: 'what is waiting' };

  const many = (list: Entry[]) => {
    const n = (k: Kind) => list.filter((e) => e.kind === k).length;
    return [
      n('stock') && `${n('stock')} stock ${n('stock') === 1 ? 'entry' : 'entries'}`,
      n('customer') && `${n('customer')} ${n('customer') === 1 ? 'customer' : 'customers'}`,
      n('item') && `${n('item')} ${n('item') === 1 ? 'item' : 'items'}`,
    ]
      .filter(Boolean)
      .join(', ');
  };

  return (
    <PageScaffold
      layout="record"
      onBack={goBack}
      title="Waiting for you"
      subtitle={!queue ? undefined : entries.length === 0 ? 'Nothing to check' : `${entries.length} to check`}
    >
      <ProblemDialog problem={problem} title="Could not do that" />

      {rejecting && (
        <ConfirmDialog
          controller={rejectDialog}
          title={`Undo this ${(KIND_LABEL[rejecting.kind] ?? rejecting.kind).toLowerCase()}?`}
          message={
            `${rejecting.product}: ${Number(rejecting.qty) > 0 ? 'takes' : 'puts'} ` +
            `${say(rejecting.product_id, Math.abs(Number(rejecting.qty)), 'piece')} ` +
            `${Number(rejecting.qty) > 0 ? 'back off' : 'back on'} the shelf, as though it never happened. ` +
            'Use this only if it did not happen. If the figure was just wrong, open the item and count it again instead.'
          }
          confirmText="Yes, undo it"
          tone="danger"
          onDismiss={() => setRejecting(null)}
          onConfirm={() => void reject(rejecting)}
        />
      )}

      {confirmingMany && (
        <ConfirmDialog
          controller={manyDialog}
          title={`Confirm ${confirmingMany.length}?`}
          message={
            `${many(confirmingMany)}, marked as checked by you. ` +
            'Nothing about the stock or the money changes: it records that you have looked and agree.'
          }
          confirmText={`Confirm ${confirmingMany.length}`}
          tone="primary"
          onDismiss={() => setConfirmingMany(null)}
          onConfirm={() => void confirm(confirmingMany, 'many')}
        />
      )}

      <PageState status={status}>
        {() =>
          queue && (
            <>
              {res.error && (
                <InfoPanel tone="danger" title="Could not refresh what is waiting">
                  {res.error}{' '}
                  <Button variant="secondary" size="small" onClick={res.reload}>
                    Try again
                  </Button>
                </InfoPanel>
              )}

              {entries.length === 0 ? (
                <InfoPanel tone="success" title="All caught up">
                  When someone who needs a manager&rsquo;s OK adds a customer or an item, or counts or
                  adjusts stock, it comes here. What you or a manager add is already your word, so it
                  does not.
                </InfoPanel>
              ) : (
                <>
                  <section className={styles.filters} aria-label="Which to show">
                    <div className={styles.tabs} role="tablist" aria-label="Kind">
                      {/* A kind with nothing waiting is not offered: four tabs did not fit a phone. */}
                      {(['all', 'stock', 'customer', 'item'] as Tab[])
                        .filter((t) => t === 'all' || t === tab || entries.some((e) => e.kind === t))
                        .map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="tab"
                          aria-selected={tab === t}
                          className={`${styles.tab} ${tab === t ? styles.tabOn : ''}`}
                          onClick={() => {
                            setTab(t);
                            setShown(PAGE);
                          }}
                        >
                          {TAB_LABEL[t]} <span className={styles.tabCount}>{count(t)}</span>
                        </button>
                      ))}
                    </div>

                    {people.length > 1 && (
                      <div className={styles.people} aria-label="Who made them">
                        {[['all', { name: 'Everyone', count: entries.length }] as const, ...people].map(([k, p]) => (
                          <button
                            key={k}
                            type="button"
                            aria-pressed={person === k}
                            className={`${styles.person} ${person === k ? styles.personOn : ''}`}
                            onClick={() => {
                              setPerson(k);
                              setShown(PAGE);
                            }}
                          >
                            {p.name} <span className={styles.personCount}>{p.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  <div className={styles.bar}>
                    <label className={styles.pickAll}>
                      <input
                        type="checkbox"
                        checked={allPicked}
                        onChange={() =>
                          setPicked((p) => {
                            const next = new Set(p);
                            for (const e of visible) {
                              if (allPicked) next.delete(e.key);
                              else next.add(e.key);
                            }
                            return next;
                          })
                        }
                      />
                      <span>
                        {pickedHere.length > 0 ? `${pickedHere.length} picked` : `Pick all ${visible.length}`}
                      </span>
                    </label>
                    <Button
                      size="small"
                      disabled={pickedHere.length === 0}
                      busy={busy === 'many'}
                      onClick={() => setConfirmingMany(pickedHere)}
                    >
                      <CheckIcon /> Confirm{pickedHere.length > 0 ? ` ${pickedHere.length}` : ''}
                    </Button>
                  </div>

                  <ul className={styles.list} aria-label="Waiting to be checked">
                    {page.map((e) => (
                      <li key={e.key} className={`${styles.row} ${picked.has(e.key) ? styles.rowPicked : ''}`}>
                        <input
                          type="checkbox"
                          className={styles.pick}
                          aria-label={`Pick ${e.name}`}
                          checked={picked.has(e.key)}
                          onChange={() => toggle(e.key)}
                        />

                        <div className={styles.main}>
                          <p className={styles.top}>
                            <span className={`${styles.kind} ${styles[`kind_${e.kind}`]}`}>
                              {e.stock ? KIND_LABEL[e.stock.kind] ?? e.stock.kind : e.kind === 'customer' ? 'New customer' : 'New item'}
                            </span>
                            <button
                              type="button"
                              className={styles.name}
                              onClick={() => {
                                if (e.stock) void nav.push('product_page', { id: e.stock.product_id });
                                else if (e.customer && canOpen('customer_edit_page')) void nav.push('customer_edit_page', { id: e.id });
                                else if (e.product && canOpen('product_form_page')) void nav.push('product_form_page', { id: e.id });
                              }}
                            >
                              {e.name}
                            </button>
                          </p>

                          {e.stock && (
                            <p className={styles.trace}>
                              <span>{say(e.stock.product_id, Number(e.stock.balance_before), 'piece')}</span>
                              <span aria-hidden="true" className={styles.arrow}>→</span>
                              <span className={Number(e.stock.qty) > 0 ? styles.up : styles.down}>
                                {Number(e.stock.qty) > 0 ? '+' : '−'}
                                {say(e.stock.product_id, Math.abs(Number(e.stock.qty)), 'piece')}
                              </span>
                              <span aria-hidden="true" className={styles.arrow}>→</span>
                              <strong>{say(e.stock.product_id, Number(e.stock.balance_after), 'piece')}</strong>
                            </p>
                          )}
                          {e.stock?.note && <p className={styles.note}>{e.stock.note}</p>}
                          {e.customer && <p className={styles.detail}>{e.customer.phone}</p>}
                          {e.product && (
                            <p className={styles.detail}>
                              {say(e.id, Number(e.product.on_hand), e.product.base_unit)} in stock · what it costs
                              and what it arrives in are not recorded yet
                            </p>
                          )}

                          <p className={styles.meta}>
                            <span className={styles.who}>{e.whoName}</span> · {formatDateTime(e.when)}
                          </p>
                        </div>

                        <div className={styles.actions}>
                          <Button size="small" busy={busy === e.key} disabled={busy === 'many'} onClick={() => void confirm([e], e.key)}>
                            <CheckIcon /> Confirm
                          </Button>
                          {e.stock && (
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={busy === e.key}
                              onClick={() => setRejecting(e.stock!)}
                            >
                              <CloseIcon /> Wrong
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>

                  {visible.length > shown && (
                    <div className={styles.more}>
                      <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                        Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}
                      </Button>
                    </div>
                  )}

                  <Explain label="What Confirm and Wrong do">
                    <p>
                      <strong>Confirm</strong> records that you have looked and agree. Nothing about the
                      sales, the stock or the money changes.
                    </p>
                    <p style={{ marginTop: 'var(--space-3)' }}>
                      <strong>Wrong</strong>, on stock, adds a correction that takes the entry back off
                      (or puts it back on) the shelf. Nothing is deleted: the history shows both what was
                      entered and that you undid it. If only the figure was off, open the item and count
                      it again instead.
                    </p>
                    <p style={{ marginTop: 'var(--space-3)' }}>
                      Only what was added by someone who needs a manager&rsquo;s OK comes here. What you
                      or a manager add is already your word.
                    </p>
                  </Explain>
                </>
              )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}

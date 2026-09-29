'use client';

import { useSayInShapes } from '@/lib/stacks/selling-units';
import { useState } from 'react';
import styles from './review-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { BoxIcon, CheckIcon, CloseIcon, PeopleIcon } from '@/components/ui/Icon';
import { useResource } from '@/lib/stacks/resource';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useNav } from '@academix-admin/navigation-stack';
import { useStackBack } from '@/hooks/useStackBack';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatQtySpoken, pluralUnit, messageOf } from '@/lib/format';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';

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
  product_id: string;
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
  const sayStore = useAuth().store;
  const say = useSayInShapes(sayStore?.id ?? null);
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can, canOpen } = usePermission();

  /*
   * The review queue in state-stack.
   *
   * Each item here opens the thing it is about — a sale, a count, a customer — so this page spends
   * its life being pushed off and returned to. `!queue` renders a full-page "Loading", which meant
   * every single trip back through the queue put a spinner over a list that was already correct.
   */
  /*
   * A RESOURCE. It kept its error inside the cached value and never re-read on the way back
   * (`revalidateOnMount: false`), so a queue somebody else had worked down stayed on screen; a first
   * read that failed left the page on "Loading" for good, because the page only knew ready or
   * loading. Now: shown at once from cache, re-read on every visit, kept through a failed refresh.
   */
  const res = useResource<Queue>({
    key: `review:v2:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(store),
    read: async () => {
      const { data, error: err } = await getSupabase().rpc('pending_review', {
        p_store_id: store!.id,
      });
      if (err) throw err;
      return data as unknown as Queue;
    },
  });
  const queue = res.data;
  const [busy, setBusy] = useState<string | null>(null);
  /*
   * An approval that failed, kept apart from a load that failed.
   *
   * Different lifetimes: a failed load belongs to the cached queue and is cleared by the next
   * successful read, while a failed approval belongs to the tap that caused it and should not
   * outlive this visit. Sharing one slot meant a stale "could not approve" reappeared, from cache,
   * over a queue that had since loaded perfectly.
   */
  /*
   * The LOAD error and the ATTEMPT error are different things and get different surfaces.
   *
   * A page that could not load has nothing on it and the message is its whole state — it stays.
   * A save that failed came back from work that was actually done, and a seller who does not
   * notice it presses the button again.
   */
  const actionError = useProblem();
  const error = res.error;
  /*
   * "WRONG" ASKS FIRST. It reverses the entry — an opening count marked wrong takes that stock off
   * the shelf — and it used to do so on one tap, with nothing to say what it would do.
   */
  const [rejecting, setRejecting] = useState<PendingStock | null>(null);
  const rejectDialog = useConfirm();

  /**
   * Take one row out of the queue, here, without asking for the queue again.
   *
   * `load()` re-read every pending record to learn that one had been dealt with — a round trip for
   * something this device had just done, with the approved row still on screen until it landed,
   * long enough to tap twice. A queue is exactly the list where that matters: the whole job is
   * working down it.
   */
  const takeOut = (kind: 'products' | 'customers' | 'stock_entries', id: string) => {
    if (!res.data) return;
    res.set((current) => ({
      products: (current?.products ?? []).filter((r) => kind !== 'products' || r.id !== id),
      customers: (current?.customers ?? []).filter((r) => kind !== 'customers' || r.id !== id),
      stock_entries: (current?.stock_entries ?? []).filter(
        (r) => kind !== 'stock_entries' || r.id !== id,
      ),
    }));
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: unknown) {
      actionError.show(messageOf(e, 'Could not do that'));
    } finally {
      setBusy(null);
    }
  };

  if (!store) return null;

  // One header; the body waits for the queue.
  const status: PageStatus = !can('records.confirm')
    ? {
        // Said inside the page's own header — it used to be a second page with a second header.
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
    : error
      ? { state: 'error', what: 'what is waiting', error, onRetry: res.reload }
      : { state: 'loading', what: 'what is waiting' };

  const total = queue
    ? queue.products.length + queue.customers.length + queue.stock_entries.length
    : 0;

  return (
    <PageScaffold
      onBack={goBack}
      title="Waiting for you"
      subtitle={!queue ? undefined : total === 0 ? 'Nothing to check' : `${total} to check`}
    >
      <PageState status={status}>
        {() =>
          queue && (
            <>
      <ProblemDialog problem={actionError} title="Could not do that" />

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
          onConfirm={() => {
            const s = rejecting;
            void run(s.id, async () => {
              const { error: e } = await getSupabase().rpc('review_movement', {
                p_movement_id: s.id,
                p_accepted: false,
                p_note: 'not accepted on review',
              });
              if (e) throw e;
              takeOut('stock_entries', s.id);
            });
          }}
        />
      )}

      {error && (
        <InfoPanel tone="danger" title="Could not refresh what is waiting">
          {error}{' '}
          <Button variant="secondary" size="small" onClick={res.reload}>
            Try again
          </Button>
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
                    {say(p.id, Number(p.on_hand), p.base_unit)} in stock ·
                    added {formatDateTime(p.created_at)}
                  </p>

                  {/*
                    WHAT IS ACTUALLY MISSING, said plainly.

                    Something added at a counter has the three things a seller had time for: a name,
                    a unit, a price. What it arrives in, what it cost, a cheaper price for buying
                    more — none of that is known, and approving it without filling any of it in
                    leaves an item that cannot be received against or costed. "Looks right" alone
                    invites exactly that, so the gap is named and the way to close it is beside it.
                  */}
                  <p className={styles.cardGap}>
                    Nothing has been recorded about what it costs you, or what it arrives in.
                  </p>
                </div>

                <div className={styles.cardActions}>
                  {canOpen('product_form_page') && (
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => void nav.push('product_form_page', { id: p.id })}
                    >
                      Fill in the rest
                    </Button>
                  )}
                  <Button
                    size="small"
                    busy={busy === p.id}
                    onClick={() =>
                      run(p.id, async () => {
                        const { error: e } = await getSupabase().rpc('confirm_product', {
                          p_product_id: p.id,
                        });
                        if (e) throw e;
                        takeOut('products', p.id);
                      })
                    }
                  >
                    <CheckIcon /> Looks right
                  </Button>
                </div>
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

                <div className={styles.cardActions}>
                  {/*
                    THE EDIT PAGE, which loads them. This opened the NEW-customer form with an id it
                    never reads, so "Check the details" showed an empty form and nothing to check.
                  */}
                  {canOpen('customer_edit_page') && (
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => void nav.push('customer_edit_page', { id: c.id })}
                    >
                      Check the details
                    </Button>
                  )}
                  <Button
                    size="small"
                    busy={busy === c.id}
                    onClick={() =>
                      run(c.id, async () => {
                        const { error: e } = await getSupabase().rpc('confirm_customer', {
                          p_customer_id: c.id,
                        });
                        if (e) throw e;
                        takeOut('customers', c.id);
                      })
                    }
                  >
                    <CheckIcon /> Looks right
                  </Button>
                </div>
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
                    <span className={styles.traceStep}>
                      {say(s.product_id, Number(s.balance_before), 'piece')}
                    </span>
                    <span className={styles.traceArrow} aria-hidden="true">
                      →
                    </span>
                    <span className={styles.traceDelta}>
                      {Number(s.qty) > 0 ? '+' : '−'}
                      {say(s.product_id, Math.abs(Number(s.qty)), 'piece')}
                    </span>
                    <span className={styles.traceArrow} aria-hidden="true">
                      →
                    </span>
                    <span className={styles.traceStep}>
                      {say(s.product_id, Number(s.balance_after), 'piece')}
                    </span>
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
                        // Off the list at once — it stayed until the next visit, so a tap looked
                        // like it had done nothing.
                        takeOut('stock_entries', s.id);
                      })
                    }
                  >
                    <CheckIcon /> Correct
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy === s.id}
                    onClick={() => setRejecting(s)}
                  >
                    <CloseIcon /> Wrong
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => void nav.push('product_page', { id: s.product_id })}
                  >
                    Open the item
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
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}

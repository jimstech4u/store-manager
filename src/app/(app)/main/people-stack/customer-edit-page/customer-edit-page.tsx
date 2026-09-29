'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useListNotifier } from '@/hooks/useListChannel';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import {
  accountsChanged,
  useCustomerAccount,
  type AccountEmpties,
} from '@/lib/stacks/customer-account';
import { formatQtySpoken, messageOf } from '@/lib/format';
import styles from './customer-edit-page.module.css';

/**
 * CHANGING WHAT A CUSTOMER IS CALLED.
 *
 * There was nowhere to do it. `update_customer` and `update_customer_phone` have both existed,
 * permission-checked, for as long as the customers have — no screen ever called either. So a name
 * typed wrong at the counter stayed wrong for ever, and the only way anybody found to change one
 * was to add a customer again on the same number, which RENAMED the first (0203) and put two
 * people's trade on one book.
 *
 * NOT THE ADD FORM. That form asks what a customer's opening position is: what they already owed
 * on the day the shop started its book, and whose crates were already out with them. Those are
 * one-time facts about a beginning, and re-asking them on an edit invites somebody to answer them
 * twice — which would double a debt. The three things that can genuinely be corrected later are
 * here, and nothing else is.
 *
 * WHAT A RECEIPT ALREADY PRINTED DOES NOT CHANGE. `sale_revisions` stores each version as a
 * document with the name as it stood, so a receipt issued to "Kadijat" still says Kadijat after
 * she is corrected to "Kadijat Bello". The shop asked for exactly that.
 */
export default function CustomerEditPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  const { store } = useAuth();

  /*
   * THE LISTS ARE TOLD WHAT CHANGED, rather than being made to read it all again.
   *
   * "I edit to be owing but card did not update in list that they owe ... even if server refresh
   * will say the same thing."
   *
   * Both lists that carry a customer deliberately never re-read on resume — `useListChannel`
   * exists so a shop that has paged through two hundred debtors is not dumped back at the top
   * every time it looks at one. The bargain is that the page making the change says which row it
   * touched, and this page never held up its end: it invalidated `account_derived`, which the
   * headline figures read, and neither list does.
   *
   * People carries the name and phone; Money carries the balance. Both move here, so both are
   * told.
   */
  const notifyPeople = useListNotifier<{
    id: string;
    display_name: string;
    business_name: string | null;
    phone: string;
    balance: string;
  }>('customers');
  const notifyDebtors = useListNotifier<{ id: string; balance: string }>('debtors');

  const customerId = (location?.params?.id as string | undefined) ?? null;

  /*
   * The account reader the rest of this tab uses, rather than a second one.
   *
   * It is a resource: a failed refresh keeps what was on screen instead of blanking it, which on
   * an edit form matters more than anywhere — a form that empties itself mid-typing saves the
   * emptiness.
   */
  const { account, history, loaded, error, reload } = useCustomerAccount(customerId);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [business, setBusiness] = useState('');
  const [busy, setBusy] = useState(false);

  /*
   * ── WHAT THEY HAD WHEN THE ACCOUNT OPENED ────────────────────────────────────
   *
   * "edit customer form did not load back inital balace input and empties to edit, which we can
   * still edit unless sales has been done just like product inital stock."
   *
   * The same rule, and the shop is right that it is the same rule. An opening figure is somebody's
   * statement about the day the book started; until they have traded, correcting a typo in it
   * should be typing over it. Once a sale exists the figure is load-bearing — every later balance
   * is measured from it — and it stops being editable here.
   *
   * WRITTEN AS A DIFFERENCE, never as an overwrite. These are ledgers: the balance is a backfilled
   * charge, the deposit is its own ledger, and `customer_empties` is append-only and refuses an
   * update outright. So a corrected figure is recorded as the movement that gets from the old one
   * to the new, which is also what keeps the correction legible afterwards.
   */
  const [owes, setOwes] = useState('');
  const [deposit, setDeposit] = useState('');

  /*
   * Seeded ONCE per customer, keyed by id rather than by a boolean.
   *
   * A flag set for the lifetime of the component is how the product form came to open a second
   * item holding the first one's boxes, and then save the blanks over real prices.
   */
  const seeded = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seeded.current === customerId || !account) return;
    seeded.current = customerId;
    setName(account.customer.name ?? '');
    setPhone(account.customer.phone ?? '');
    setBusiness(account.customer.business ?? '');
    setOwes(String(Number(account.balance) || 0));
    setDeposit(String(Number(account.deposits_held) || 0));
  }, [account, customerId]);

  /*
   * HAS ANYTHING ACTUALLY HAPPENED ON THIS ACCOUNT?
   *
   * `history` carries every event; a sale is the one that makes an opening figure permanent. Until
   * then the account is still just what somebody typed on the day it was created.
   */
  const hasTraded = (history ?? []).some((h) => h.kind === 'sale');

  const save = async () => {
    if (!customerId) return;
    if (name.trim() === '') {
      problem.show('A customer needs a name.');
      return;
    }
    setBusy(true);
    try {
      const supabase = getSupabase();
      const { error } = await supabase.rpc('update_customer', {
        p_customer_id: customerId,
        p_display_name: name.trim(),
        /*
         * An empty business name is a real answer — "they are a person, not a shop" — and
         * `update_customer` writes null for it rather than leaving the old one, which is what
         * lets somebody take a business name off. Null would mean "do not touch".
         */
        p_business_name: business.trim(),
        p_notes: null,
      });
      if (error) throw error;

      /*
       * The number is its own call because it is its own thing: it resolves to the IDENTITY, the
       * row that makes one person one person across every shop that knows them. Only sent when it
       * has actually changed — rewriting an identity nobody asked to change would touch a record
       * shared with other shops for no reason.
       */
      if (phone.trim() !== '' && phone.trim() !== (account?.customer.phone ?? '')) {
        const { error: phoneErr } = await supabase.rpc('update_customer_phone', {
          p_customer_id: customerId,
          p_phone: phone.trim(),
        });
        if (phoneErr) throw phoneErr;
      }

      /*
       * AND THE OPENING FIGURES, as the movement that corrects them.
       *
       * Only while nothing has traded, and only where the figure actually moved — a save that
       * re-states the same number must write nothing, or every visit to this screen would leave
       * another entry on the account.
       */
      if (!hasTraded && account && store) {
        const wasOwed = Number(account.balance) || 0;
        const nowOwed = Number(owes) || 0;
        if (Math.abs(nowOwed - wasOwed) > 0.005) {
          const { error: e1 } = await supabase.rpc('backfill_debtor', {
            p_store_id: store.id,
            p_customer_id: customerId,
            p_amount: nowOwed - wasOwed,
            p_as_of: new Date().toISOString().slice(0, 10),
            p_note: 'Opening balance corrected',
          });
          if (e1) throw e1;
        }

        const wasHeld = Number(account.deposits_held) || 0;
        const nowHeld = Number(deposit) || 0;
        if (Math.abs(nowHeld - wasHeld) > 0.005) {
          const up = nowHeld > wasHeld;
          const { error: e2 } = await supabase.rpc(
            up ? 'take_customer_deposit' : 'settle_customer_deposit',
            up
              ? {
                  p_store_id: store.id,
                  p_customer_id: customerId,
                  p_amount: nowHeld - wasHeld,
                  p_reason: 'Opening deposit corrected',
                  p_occurred_at: null,
                }
              : {
                  p_store_id: store.id,
                  p_customer_id: customerId,
                  p_amount: wasHeld - nowHeld,
                  p_keep: false,
                  p_reason: 'Opening deposit corrected',
                  p_occurred_at: null,
                },
          );
          if (e2) throw e2;
        }
      }

      /*
       * WHAT THE ROW NOW SAYS. The balance is read back rather than worked out here: the opening
       * figures are written as a difference through three ledgers, and a second opinion computed
       * on this screen is how two places come to disagree about one customer.
       */
      const { data: fresh } = await supabase.rpc('customer_balance', {
        p_store_customer_id: customerId,
      });
      const balance = String(fresh ?? account?.balance ?? '0');

      notifyPeople({
        type: 'patch',
        id: customerId,
        patch: {
          display_name: name.trim(),
          business_name: business.trim() || null,
          phone: phone.trim(),
          balance,
        },
      });
      notifyDebtors({ type: 'patch', id: customerId, patch: { balance } });

      accountsChanged();
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'Those details could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const status: PageStatus = !customerId
    ? { state: 'empty', title: 'No customer chosen', body: 'Open somebody from the people list.' }
    : account
      ? { state: 'ready' }
      : error
        ? { state: 'error', what: 'this customer', error, onRetry: reload }
        : !loaded
          ? { state: 'loading', what: 'this customer' }
          : {
              state: 'empty',
              title: 'That customer is not here',
              body: 'They may have been removed. Go back and open the list again.',
            };

  return (
    <PageScaffold onBack={goBack} title="Edit customer" subtitle="What this customer is called">
      <ProblemDialog problem={problem} title="Not saved" />

      <PageState status={status}>
        {() => (
          <>
                <Field
                  label="Name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Some"
                  autoFocus
                />

                <Field
                  label="Phone"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0803 000 0000"
                  hint="How the shop recognises them again."
                />

                <Field
                  label="Business name"
                  optional
                  value={business}
                  onChange={(e) => setBusiness(e.target.value)}
                  placeholder="Some Stores"
                />

                {/*
                  WHAT THEY HAD WHEN THE ACCOUNT OPENED.

                  Offered only while nothing has traded. After a sale these figures are
                  load-bearing — every later balance is measured from them — and the way to move
                  them is a payment, a charge or a return, each of which says what happened.
                */}
                {!hasTraded ? (
                  <>
                    <h2 className={styles.section}>What they had when you started</h2>
                    <p className={styles.sectionNote}>
                      Nothing has been sold to them yet, so this is still just what was typed on
                      the day. Correct it here.
                    </p>

                    <Field
                      label="They owe you"
                      numeric
                      prefix="₦"
                      value={owes}
                      onChange={(e) => setOwes(e.target.value)}
                      placeholder="0"
                      hint="From before you started keeping the book here. A minus figure means you owe them."
                    />

                    <Field
                      label="Deposit you are holding"
                      numeric
                      prefix="₦"
                      value={deposit}
                      onChange={(e) => setDeposit(e.target.value)}
                      placeholder="0"
                      hint="Money of theirs you are keeping against what they take away."
                    />

                    {/*
                      THE CONTAINERS ARE NOT RE-TYPED HERE.

                      They have their own screen, which knows what is owed in which shape, rolls
                      it up by maker, and refuses to take back more than is out. A second set of
                      boxes on this page would be a second answer to "what are they holding", and
                      the two would disagree from the first correction onwards.
                    */}
                    {(account?.empties ?? []).length > 0 && (
                      <p className={styles.sectionNote}>
                        They are holding{' '}
                        {(account?.empties ?? [])
                          .map(
                            (e: AccountEmpties) =>
                              `${formatQtySpoken(e.qty)} ${(Number(e.qty) === 1 ? e.unit : e.unit_plural).toLowerCase()} of ${e.product}`,
                          )
                          .join(', ')}
                        . Change that on their empties screen, where a return is recorded properly.
                      </p>
                    )}
                  </>
                ) : (
                  <p className={styles.sectionNote}>
                    They have traded with you, so what they owe and what you hold now move by
                    payments, charges and returns — each of which says what happened.
                  </p>
                )}

                <InfoPanel tone="info" title="Receipts already printed do not change">
                  Every version of a receipt keeps the name it was made out to, so what a customer
                  is holding still matches what the shop has. This changes what they are called
                  from here on.
                </InfoPanel>

            {/* The actions END the page rather than being pinned to its foot. */}
            <div className={styles.actions}>
              <Button variant="secondary" onClick={goBack} disabled={busy}>
                Cancel
              </Button>
              <Button busy={busy} busyLabel="Saving" onClick={() => void save()}>
                Save
              </Button>
            </div>
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}

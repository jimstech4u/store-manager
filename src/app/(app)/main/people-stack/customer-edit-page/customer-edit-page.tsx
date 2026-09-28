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
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged, useCustomerAccount } from '@/lib/stacks/customer-account';
import { messageOf } from '@/lib/format';
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

  const customerId = (location?.params?.id as string | undefined) ?? null;

  /*
   * The account reader the rest of this tab uses, rather than a second one.
   *
   * It is a resource: a failed refresh keeps what was on screen instead of blanking it, which on
   * an edit form matters more than anywhere — a form that empties itself mid-typing saves the
   * emptiness.
   */
  const { account, loaded, error, reload } = useCustomerAccount(customerId);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [business, setBusiness] = useState('');
  const [busy, setBusy] = useState(false);

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
  }, [account, customerId]);

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

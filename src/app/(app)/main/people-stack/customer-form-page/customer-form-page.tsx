'use client';

import { useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useListNotifier } from '@/hooks/useListChannel';
import styles from './customer-form-page.module.css';

/**
 * Saving somebody as a customer.
 *
 * A PAGE, because it is a form — and it was living inside the customer picker, which is a
 * selection viewer. A viewer is built to show a list you scroll and choose from: it has a search
 * box of its own, a drag handle, snap points, and a height that assumes a list. A form put inside
 * one inherits all of that and needs none of it, and the two fight over the keyboard on a phone.
 *
 * So the picker offers a button and this page holds the form. The picker closes on the way out —
 * a sheet left open underneath a pushed page is a sheet somebody comes back to and has to dismiss.
 *
 * WHAT COMES BACK travels through `provideObject`, the same way the product form returns what it
 * created. Whoever opened this publishes `onCustomerCreated` and gets the new customer handed to
 * them; nobody is obliged to, and without a listener this still saves — which is the part that
 * must not depend on anything.
 */
export default function CustomerFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  // The name is prefilled from whatever was typed into the picker's search: somebody who has just
  // typed "Irekanmi" and been told there is no such customer should not type it again.
  const prefill = (location?.params?.name as string | undefined) ?? '';

  const created = useObject<(customer: { id: string; name: string; phone: string }) => void>(
    'onCustomerCreated',
    { global: true, scope: 'people' },
  );

  const notifyPeople = useListNotifier<{
    id: string;
    display_name: string;
    business_name: string | null;
    phone: string;
    balance: string;
  }>('customers');

  const [name, setName] = useState(prefill);
  const [phone, setPhone] = useState('');
  const [business, setBusiness] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!store) return null;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { data, error } = await getSupabase().rpc('upsert_customer', {
        p_store_id: store.id,
        p_phone: phone.trim(),
        p_display_name: name.trim(),
      });
      if (error) throw error;

      const customer = { id: data as string, name: name.trim(), phone: phone.trim() };

      /*
       * The list is told about this one customer rather than asked to read itself again.
       *
       * Sent before leaving: the people screen may be the page underneath, and it should already
       * show them by the time the back animation finishes.
       */
      notifyPeople({
        type: 'upsert',
        row: {
          id: customer.id,
          display_name: customer.name,
          business_name: business.trim() || null,
          phone: customer.phone,
          balance: '0',
        },
      });

      if (created.isProvided) created.getter()?.(customer);
      await nav.pop();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That customer could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Add a customer"
      subtitle="Somebody you sell to more than once"
    >
      {problem && (
        <InfoPanel tone="danger" title="Not saved">
          {problem}
        </InfoPanel>
      )}

      <InfoPanel tone="info" title="When to save somebody">
        You only need this for people buying on credit, or regulars you want a history for. An
        ordinary cash sale needs no name at all.
      </InfoPanel>

      <Field
        label="Their name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Irekanmi"
        autoFocus
      />

      {/*
        REQUIRED, because the shop's own rule says so.
        *
        * `upsert_customer` resolves the number to a shared identity before it saves anything —
        * that is how the same person known to two shops, or recognised from a number typed
        * differently, ends up as one customer rather than two with the debt split between them.
        * Without a number there is nothing to resolve, and the database refuses.
      */}
      <Field
        label="Phone"
        required
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 000 0000"
        hint="How the shop recognises them again — and where a receipt can be sent."
      />

      <Field
        label="Business name"
        optional
        value={business}
        onChange={(e) => setBusiness(e.target.value)}
        placeholder="Their shop or company"
      />

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} disabled={!name.trim() || !phone.trim()} onClick={() => void save()}>
          Save customer
        </Button>
      </div>
    </PageScaffold>
  );
}

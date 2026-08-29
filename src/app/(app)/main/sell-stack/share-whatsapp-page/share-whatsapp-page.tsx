'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { toWhatsAppNumber } from '@/lib/whatsapp';
import styles from './share-whatsapp-page.module.css';

/**
 * Sending an order or a receipt to somebody on WhatsApp.
 *
 * A PAGE, because it holds a phone number that can be edited — and a number being typed needs the
 * keyboard room a page has and a sheet does not. It is also the last moment before something
 * leaves the shop and reaches a customer, which is worth a screen of its own rather than a
 * confirm-and-hope.
 *
 * THE NUMBER IS FILLED IN WHEN WE HAVE ONE. If the sale was recorded for somebody, that is almost
 * always who it is being sent to — but not always, and the number on file is often the one that
 * has changed. So it is a field, not a label: prefilled, editable, and perfectly happy to be
 * replaced with a number belonging to nobody in the book.
 *
 * AND WE OFFER TO REMEMBER IT. When a customer is attached and the number typed differs from the
 * one on file, updating it is the obviously right thing and is therefore ticked — a shop that has
 * just successfully reached somebody on a new number should not have to go and record that
 * separately. It is a checkbox rather than automatic because sending to a relative's phone is a
 * real thing, and silently overwriting the customer's own number would be wrong.
 */
export default function ShareWhatsAppPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const message = (location?.params?.message as string | undefined) ?? '';
  const customerId = (location?.params?.customerId as string | undefined) || null;
  const customerName = (location?.params?.customerName as string | undefined) ?? '';
  const known = (location?.params?.phone as string | undefined) ?? '';

  const [phone, setPhone] = useState(known);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const target = toWhatsAppNumber(phone);
  const changed = phone.trim() !== known.trim();

  const send = async () => {
    if (!target) {
      setProblem('That does not look like a phone number. Include the network code, like 0803…');
      return;
    }

    setBusy(true);
    setProblem(null);
    try {
      /*
       * Record the number BEFORE leaving.
       *
       * Opening WhatsApp takes the browser away, and on a phone this page may not be running when
       * it comes back. A number saved after the hand-off is a number that often never gets saved.
       */
      if (customerId && remember && changed) {
        const { error } = await getSupabase().rpc('update_customer_phone', {
          p_customer_id: customerId,
          p_phone: phone.trim(),
        });
        // Not fatal. The point of this screen is to reach somebody; failing to note their number
        // is worth saying, not worth stopping for.
        if (error) setProblem(`Sent, but their number could not be saved: ${error.message}`);
      }

      /*
       * `wa.me` rather than the app scheme.
       *
       * It works whether or not WhatsApp is installed — the browser hands over when it is, and
       * shows the web version when it is not — which matters on a shared shop phone where the app
       * may not be signed in.
       */
      window.open(`https://wa.me/${target}?text=${encodeURIComponent(message)}`, '_blank');

      // Straight back to what they were doing. The hand-off is the end of this screen's job.
      await nav.pop();
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;

  return (
    <PageScaffold
      onBack={goBack}
      title="Share on WhatsApp"
      subtitle={customerName || 'Send this to a phone number'}
    >
      {problem && (
        <InfoPanel tone="warning" title="Check this">
          {problem}
        </InfoPanel>
      )}

      <Field
        label="Phone number"
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 000 0000"
        hint={
          known
            ? 'Filled in from their record. Change it to send somewhere else.'
            : 'A Nigerian number, or one with its country code.'
        }
        autoFocus
      />

      {customerId && changed && (
        <label className={styles.remember}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            <strong>Save this as {customerName || 'their'} number</strong>
            <span className={styles.rememberHint}>
              Untick if this is somebody else&rsquo;s phone.
            </span>
          </span>
        </label>
      )}

      <div className={styles.preview}>
        <span className={styles.previewLabel}>What they will get</span>
        <p className={styles.previewBody}>{message}</p>
      </div>

      <Button size="large" fullWidth busy={busy} disabled={!target} onClick={() => void send()}>
        Open WhatsApp
      </Button>
    </PageScaffold>
  );
}

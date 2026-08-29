'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { ShareIcon, WhatsAppIcon } from '@/components/ui/Icon';
import { appUrl } from '@/lib/app-url';
import styles from './ShareOrder.module.css';

/**
 * Handing an order to the person buying it.
 *
 * The code beside the customer's name is already the shop's internal handover — a colleague picks
 * the same order up on their phone. This is the other direction: the CUSTOMER gets a link that
 * follows what they have been charged for, which is `/track?code=…` and has existed since the
 * public tracking work.
 *
 * Two ways out, because they are genuinely different acts. The share button hands the link to
 * whatever the phone offers and is right when the customer is standing there with their own
 * device. WhatsApp is right when they are not — it is how a Nigerian shop actually reaches a
 * regular, and it needs their number, which is a question of its own and gets its own screen.
 */
export function ShareOrder({
  open,
  onClose,
  code,
  shareToken,
  storeName,
  customerName,
  customerId,
  customerPhone,
  total,
}: {
  open: boolean;
  onClose: () => void;
  code: string | null;
  /** The stable identifier a link is built from. See `/t/[token]` for why it is not the code. */
  shareToken: string | null;
  storeName: string;
  customerName?: string;
  customerId?: string | null;
  customerPhone?: string | null;
  total?: string;
}) {
  const nav = useNav();
  const [copied, setCopied] = useState(false);

  if (!code) return null;

  /*
   * THE LINK CARRIES THE TOKEN, NOT THE CODE.
   *
   * The code is five characters so it can be read aloud, which means there are few of them, which
   * is why it is released when the order finishes and the next order takes it. A message sits in
   * somebody's chat for months — long enough for that code to belong to a stranger — so a link
   * built on it would eventually show them somebody else's order.
   *
   * The address itself comes from `appUrl`, not the browser's origin, or a shop setting up on
   * localhost would send links that open nothing.
   */
  const link = shareToken
    ? appUrl(`/t/${encodeURIComponent(shareToken)}`)
    : appUrl(`/track?code=${encodeURIComponent(code)}`);

  const message =
    `Your order at ${storeName}` +
    (total ? ` comes to ${total}.` : '.') +
    `\nFollow it here: ${link}`;

  const shareNatively = async () => {
    /*
     * The phone's own share sheet, when it has one.
     *
     * Falls back to the clipboard rather than an error: a desktop browser without `navigator.share`
     * is a real case, and "copied" is a perfectly good outcome for a link somebody is about to
     * paste somewhere.
     */
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: `Order at ${storeName}`, text: message, url: link });
        onClose();
        return;
      }
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // A cancelled share sheet throws. Nothing went wrong and nothing needs saying.
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Share this order">
      <InfoPanel tone="info" title="What they will see">
        A page showing what is on this order and what it comes to, updating as you add to it. It
        stops working once the order is paid for or cancelled.
      </InfoPanel>

      <p className={styles.link}>{link}</p>

      <div className={styles.actions}>
        <Button variant="secondary" size="large" fullWidth onClick={() => void shareNatively()}>
          <ShareIcon /> {copied ? 'Link copied' : 'Share'}
        </Button>

        <Button
          size="large"
          fullWidth
          onClick={() => {
            onClose();
            /*
             * Only ids and the message travel — never the customer record.
             *
             * The next screen re-reads whoever it needs from the database, so a deep link or a
             * reload lands on the same page rather than a blank one.
             */
            void nav.push('share_whatsapp_page', {
              message,
              phone: customerPhone ?? '',
              customerId: customerId ?? '',
              customerName: customerName ?? '',
            });
          }}
        >
          <WhatsAppIcon /> Share on WhatsApp
        </Button>
      </div>
    </BottomSheet>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';
import styles from './verify.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

/**
 * The six digits that prove a business owns the address it signed up with.
 *
 * NOT A LINK. A link opens in whichever browser the mail app prefers, which on a phone is often
 * not the one holding the half-finished sign-up — and the session then lands somewhere the person
 * cannot see. Six digits are read from one app and typed into another, which is the only thing
 * that reliably works on a device somebody is holding.
 *
 * The code comes from Supabase's own confirmation email (`{{ .Token }}`, six digits, delivered
 * through Brevo) and is checked by Supabase. Nothing here invents a verification scheme: the one
 * that already exists is the one with the rate limits and the expiry.
 *
 * ON SUCCESS THIS LEAVES THE STACK ENTIRELY — `router.replace`, not a push. A verified session
 * must not have a back route into the screen that verified it, and `replace` means the browser's
 * own Back does not return here either.
 */
export default function Verify() {
  const nav = useNav();
  const router = useRouter();
  const location = useLocation();

  // Only the address travels, which is all this screen needs and the only part that is not
  // secret. The password stays on the screen that asked for it.
  const email = (location?.params?.email as string | undefined) ?? '';

  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();
  const [note, setNote] = useState<string | null>(null);

  /*
   * A cool-down on resending.
   *
   * Supabase rate-limits this anyway and answers a too-eager second request with an error; a
   * visible countdown is the difference between "wait a minute" and an error message that reads
   * like something is broken.
   */
  const [wait, setWait] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    timer.current = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [wait]);

  /*
   * Somebody who arrived here with no address cannot do anything.
   *
   * Only reachable by restoring a persisted stack whose params did not survive, but the screen
   * would otherwise sit there verifying an empty string forever.
   */
  useEffect(() => {
    if (!email) void nav.popToRoot();
  }, [email, nav]);

  const verify = async () => {
    setBusy(true);
    try {
      const { error } = await getSupabase().auth.verifyOtp({
        email,
        token: digits.trim(),
        // 'email' covers both the sign-up confirmation and a later re-send; 'signup' is rejected
        // once the address has been through one confirmation attempt.
        type: 'email',
      });
      if (error) throw error;
      router.replace('/main');
    } catch (e) {
      problem.show(
        e instanceof Error
          ? // Supabase's own wording is "Token has expired or is invalid", which is accurate and
            // unhelpful about which. Both cases have the same remedy.
            /expired|invalid/i.test(e.message)
            ? 'That code did not work. It may have expired — send a new one.'
            : e.message
          : 'That code could not be checked.',
      );
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setNote(null);
    try {
      const { error } = await getSupabase().auth.resend({ type: 'signup', email });
      if (error) throw error;
      setNote(`A new code is on its way to ${email}.`);
      setWait(60);
    } catch (e) {
      problem.show(messageOf(e, 'That code could not be sent.'));
    }
  };

  return (
    <AuthShell
      compact
      title="Check your email"
      lead={
        <>
          We sent a six-digit code to <strong>{email}</strong>. Enter it here to finish setting up
          your shop.
        </>
      }
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not verified" />
      {note && (
        <InfoPanel tone="info" title="Sent">
          {note}
        </InfoPanel>
      )}

      <label className={styles.label} htmlFor="verify-code">
        Six-digit code
      </label>
      <input
        id="verify-code"
        className={styles.code}
        value={digits}
        onChange={(e) => setDigits(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        // A numeric keypad and one-tap fill from the notification, which is most of why a code
        // beats a link on a phone.
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        /*
         * No `maxLength`.
         *
         * It clips the RAW text before the digit-strip runs, so pasting anything with a stray
         * character in it — "12ab34cd56" — loses real digits rather than the letters. The strip
         * below already caps the result at six, which is the cap that should apply.
         */
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && digits.length === 6) void verify();
        }}
      />

      <Button
        size="large"
        fullWidth
        busy={busy}
        disabled={digits.length !== 6}
        onClick={() => void verify()}
      >
        Verify
      </Button>

      <div className={styles.secondary}>
        <button
          type="button"
          className={styles.link}
          disabled={wait > 0}
          onClick={() => void resend()}
        >
          {wait > 0 ? `Send another code in ${wait}s` : 'Send another code'}
        </button>
        <button type="button" className={styles.link} onClick={() => void nav.popToRoot()}>
          Use a different email
        </button>
      </div>

      <p className={styles.footnote}>
        Nothing arrived? Check the spam folder. The code lasts an hour.
      </p>
    </AuthShell>
  );
}

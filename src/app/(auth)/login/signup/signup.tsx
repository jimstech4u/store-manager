'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { getSupabase } from '@/lib/supabase/client';
import { safeNext } from '@/lib/auth/after-sign-in';
import styles from '../signin/signin.module.css';
import { messageOf } from '@/lib/format';

/**
 * Opening a shop — or opening a shopper's account.
 *
 * ONE SCREEN, TWO INTENTIONS, and they are genuinely different: one person is about to run a
 * business here and the other is about to buy a crate of drinks. Signing IN is shared, because
 * "who are you" has one answer and one password box; signing UP divides, because what happens next
 * does. A shop goes on to name its business and enter opening balances; a shopper goes back to the
 * basket they were in the middle of.
 *
 * What it does NOT do is ask a shopper for their name and number here. That is asked once, at the
 * moment a shop is actually being told to expect them — see the basket. Collecting it earlier means
 * collecting it before there is an account to keep it against, and then either losing it across
 * email confirmation or holding it somewhere it does not belong.
 *
 * Pushed on top of sign-in rather than swapped in behind a toggle, so the back arrow means what
 * it looks like it means and somebody who tapped it by mistake has an obvious way back.
 */
export default function SignUp() {
  const nav = useNav();
  const router = useRouter();
  const location = useLocation();
  const asCustomer = location?.params?.as === 'customer';
  const next = safeNext(useSearchParams().get('next'), asCustomer ? '/cart' : '/main');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  /*
   * TWO SURFACES, BECAUSE THERE ARE TWO KINDS OF THING HERE.
   *
   * "Enter your email address" is a CONDITION — this form can see it without attempting anything,
   * it is still true after any acknowledgement, and it belongs beside the fields being fixed.
   * "That email and password do not match" came back from an attempt that actually happened, and
   * a seller who does not notice it presses the button again.
   */
  const [error, setError] = useState<string | null>(null);
  const problem = useProblem();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) return setError('Enter your email address');
    if (password.length < 8) return setError('Your password must be at least 8 characters');

    setBusy(true);
    try {
      const { data, error: err } = await getSupabase().auth.signUp({
        email: email.trim(),
        password,
        /*
         * WHICH OF THE TWO THIS WAS. A shopper has no store, and "no store" has always meant one
         * thing here: go and create one. Their shopper record is not written until checkout — it
         * needs a name and a number, and this screen deliberately does not ask for them — so
         * without this a shopper who wanders to `/main` first is marched into the shop wizard.
         *
         * It GRANTS NOTHING. User metadata is writable by the client, so nothing may be permitted
         * on the strength of it; it decides which of two public screens somebody lands on and
         * that is all. Every permission in this app is still decided by the database from
         * `auth.uid()`.
         */
        options: { data: { signed_up_as: asCustomer ? 'customer' : 'shop' } },
      });
      if (err) throw err;

      /*
       * No session means the address has to be confirmed first, which is the normal path.
       *
       * POPPED BACK TO SIGN-IN, not left underneath. The account now exists; going back into this
       * form could only produce "that address is already registered", and it would be holding
       * their password in a field while it said so. Back from the code screen lands on sign-in,
       * which is both where they can act and where they were headed anyway.
       */
      if (!data.session) {
        void nav.pushAndPopUntil('verify', (entry) => entry.key === 'signin', {
          email: email.trim(),
          // Carried so the code screen knows where this person was going. Neither is secret, and
          // without them a verified shopper lands at a till and is asked to create a shop.
          as: asCustomer ? 'customer' : 'shop',
          next,
        });
        return;
      }

      router.replace(next);
    } catch (err: unknown) {
      const message = messageOf(err, 'Something went wrong');
      problem.show(
        /already registered|already exists/i.test(message)
          ? 'There is already an account with that address. Go back and sign in instead.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={asCustomer ? 'Create your shopper account' : 'Create your account'}
      lead={
        asCustomer
          ? 'So a shop can answer your order. You will not be asked to set up a shop.'
          : 'You will set up your shop in the next step.'
      }
    >
      <ProblemDialog problem={problem} title="Could not create your account" />

      {error && (
        <InfoPanel tone="danger" title="Check these first">
          {error}
        </InfoPanel>
      )}

      <form onSubmit={submit} noValidate>
        <Field
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          hint="We send a six-digit code here to check it reaches you."
        />

        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 8 characters."
        />

        <div className={styles.actions}>
          <Button
            type="submit"
            size="large"
            fullWidth
            busy={busy}
            busyLabel="Creating your account"
          >
            Create account
          </Button>
        </div>
      </form>

      <div className={styles.switcher}>
        Already have an account?{' '}
        <button type="button" className={styles.switchButton} onClick={() => void nav.pop()}>
          Sign in
        </button>
      </div>
    </AuthShell>
  );
}

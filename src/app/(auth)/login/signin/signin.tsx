'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useNav } from '@academix-admin/navigation-stack';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { getSupabase } from '@/lib/supabase/client';
import { isStaffAddress } from '@/lib/auth/staff-address';
import styles from './signin.module.css';
import { messageOf } from '@/lib/format';

/**
 * Signing in — the root of the auth stack.
 *
 * Email and password rather than a magic link, deliberately. A shop's staff phone often has a
 * shared or unreliable mailbox, and "go and check your email, then come back" is a hard stop in
 * the middle of a working day. A password they can be told once and reuse is the pattern that
 * actually survives in this setting.
 */
export default function SignIn() {
  const nav = useNav();
  const router = useRouter();

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
      const { error: err } = await getSupabase().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) throw err;
      router.replace('/main');
    } catch (err: unknown) {
      const message = messageOf(err, 'Something went wrong');

      /*
       * An unconfirmed business is not an error, it is an unfinished step.
       *
       * Supabase refuses the sign-in with "Email not confirmed". Showing that as a failure leaves
       * somebody stuck on a screen with nothing to do; sending a fresh code and asking for it is
       * what they were going to have to do anyway.
       *
       * A plain `push`, not `pushAndPopUntil`: nothing has been completed that they should be
       * stopped from going back to. Back from the code screen returns here, with what they typed
       * still in the form.
       */
      if (/email not confirmed/i.test(message)) {
        void getSupabase().auth.resend({ type: 'signup', email: email.trim() });
        nav.push('verify', { email: email.trim() });
        return;
      }

      /*
       * A staff login cannot be reset by the person using it.
       *
       * Their address is on a namespace the shop owns and nothing is delivered to it, so a
       * "forgot password" email would go nowhere. The admin who created the account is the only
       * person who can change it, and saying so is more use than a generic failure.
       */
      if (isStaffAddress(email)) {
        problem.show(
          'That is a shop login. If the password is not working, ask whoever set up your account ' +
            'to give you a new one — password emails are not sent to shop logins.',
        );
        return;
      }

      // Supabase returns "Invalid login credentials" for both a wrong password and an unknown
      // address — correct, since saying which would let someone enumerate accounts. Reworded
      // because the raw string reads like a system fault rather than something to try again.
      problem.show(
        /invalid login credentials/i.test(message)
          ? 'That email and password do not match. Check both and try again.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" lead="Welcome back.">
      <ProblemDialog problem={problem} title="Could not sign you in" />

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
        />

        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div className={styles.actions}>
          <Button type="submit" size="large" fullWidth busy={busy} busyLabel="Signing in">
            Sign in
          </Button>
        </div>
      </form>

      <div className={styles.switcher}>
        New here?{' '}
        <button type="button" className={styles.switchButton} onClick={() => nav.push('signup')}>
          Create an account
        </button>
      </div>
    </AuthShell>
  );
}

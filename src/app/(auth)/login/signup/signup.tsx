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
import styles from '../signin/signin.module.css';
import { messageOf } from '@/lib/format';

/**
 * Opening a shop.
 *
 * Pushed on top of sign-in rather than swapped in behind a toggle, so the back arrow means what
 * it looks like it means and somebody who tapped "Create an account" by mistake has an obvious
 * way back to where they were.
 */
export default function SignUp() {
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
      const { data, error: err } = await getSupabase().auth.signUp({
        email: email.trim(),
        password,
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
        });
        return;
      }

      router.replace('/main');
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
    <AuthShell title="Create your account" lead="You will set up your shop in the next step.">
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

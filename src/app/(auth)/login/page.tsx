'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup';

/**
 * Sign in / create account.
 *
 * Email and password rather than a magic link, deliberately. A shop's staff phone often has a
 * shared or unreliable mailbox, and "go and check your email, then come back" is a hard stop in
 * the middle of a working day. A password they can be told once and reuse is the pattern that
 * actually survives in this setting.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) return setError('Enter your email address');
    if (password.length < 8) {
      return setError('Your password must be at least 8 characters');
    }

    setBusy(true);
    try {
      const supabase = getSupabase();

      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (err) throw err;

        // With email confirmation switched on, signUp returns a user but no session. Saying so
        // explicitly beats leaving them on a form that looks like it silently failed.
        if (!data.session) {
          setNeedsConfirmation(true);
          return;
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) throw err;
      }

      router.replace('/main');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      // Supabase returns "Invalid login credentials" for both a wrong password and an unknown
      // address — correct, since saying which would let someone enumerate accounts. Reworded
      // because the raw string reads like a system fault rather than something to try again.
      setError(
        /invalid login credentials/i.test(message)
          ? 'That email and password do not match. Check both and try again.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (needsConfirmation) {
    return (
      <div className={styles.page}>
        <div className={styles.inner}>
          <div className={styles.card}>
            <InfoPanel tone="success" title="Account created">
              <div className={styles.sent}>
                <p>We sent a confirmation link to</p>
                <p className={styles.sentTo}>{email}</p>
                <p style={{ marginTop: 'var(--space-3)' }}>
                  Open it, then come back here and sign in.
                </p>
              </div>
            </InfoPanel>
            <Button
              variant="secondary"
              size="large"
              fullWidth
              onClick={() => {
                setNeedsConfirmation(false);
                setMode('signin');
              }}
            >
              Back to sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1 className={styles.brand}>Store Manager</h1>
        <p className={styles.tagline}>Stock, sales and accounts for your business.</p>

        <div className={styles.card}>
          <h2 className={styles.heading}>
            {mode === 'signin' ? 'Sign in' : 'Create your account'}
          </h2>
          <p className={styles.subheading}>
            {mode === 'signin'
              ? 'Welcome back.'
              : 'You will set up your shop in the next step.'}
          </p>

          {error && (
            <InfoPanel tone="danger" title="Could not continue">
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
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
            />

            <div className={styles.actions}>
              <Button
                type="submit"
                size="large"
                fullWidth
                busy={busy}
                busyLabel={mode === 'signin' ? 'Signing in' : 'Creating your account'}
              >
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </Button>
            </div>
          </form>

          <div className={styles.switcher}>
            {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
            <button
              type="button"
              className={styles.switchButton}
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

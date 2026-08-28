'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';
import styles from './ChoosePassword.module.css';

/**
 * A staff member choosing their own password, before they can do anything else.
 *
 * The admin set the first one, and told it to them out loud. That is the right way to hand
 * somebody a till and the wrong way to leave them: a password two people know is not a password,
 * and the one who is accountable for what happens at that till should be the only one who can sign
 * in as them.
 *
 * There is no "skip". A skipped step here is one nobody comes back to, and the shared password
 * quietly becomes permanent — usually written on something near the counter.
 */
export function ChoosePassword({
  loginEmail,
  onDone,
  onSignOut,
}: {
  loginEmail: string | null;
  onDone: () => void;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = again.length > 0 && password !== again;
  const ready = password.length >= 8 && password === again;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const supabase = getSupabase();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      /*
       * Clear the flag only AFTER the password actually changed.
       *
       * The other order would let a failed update leave somebody marked as sorted while still on
       * the password their manager knows — the exact state this screen exists to end.
       */
      const { error: flagError } = await supabase.rpc('password_changed');
      if (flagError) throw flagError;

      onDone();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That password could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Choose your own password</h1>
        <p className={styles.lead}>
          {loginEmail ? (
            <>
              You are signed in as <strong>{loginEmail}</strong>. The password you were given is
              known to whoever set it up — pick your own before you start.
            </>
          ) : (
            'The password you were given is known to whoever set it up. Pick your own before you start.'
          )}
        </p>

        {problem && (
          <InfoPanel tone="danger" title="Not saved">
            {problem}
          </InfoPanel>
        )}

        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 8 characters."
          error={tooShort ? 'A bit longer — at least 8 characters.' : undefined}
          autoFocus
        />

        <Field
          label="Type it again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={mismatch ? 'These two do not match.' : undefined}
        />

        <Button size="large" fullWidth busy={busy} disabled={!ready} onClick={() => void save()}>
          Save and continue
        </Button>

        <div className={styles.secondary}>
          <button type="button" className={styles.link} onClick={onSignOut}>
            Sign out instead
          </button>
        </div>
      </div>
    </main>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import styles from './setup.module.css';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { getSupabase } from '@/lib/supabase/client';
import { useAuth } from '@/providers/AuthProvider';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

/** A URL-safe slug from a shop name, with a short random tail so two "Blessing Stores" can coexist. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const tail = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${tail}` : `shop-${tail}`;
}

export default function CreateStorePage() {
  const router = useRouter();
  const { refreshStores } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useProblem();

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    const trimmed = name.trim();
    if (!trimmed) return error.show('Enter the name of your shop');

    setBusy(true);
    try {
      // create_store() writes the shop and the owner membership in one transaction. Doing it as
      // two client calls would risk a shop existing with no members — unreachable by anyone,
      // including the person who just made it.
      const { error: err } = await getSupabase().rpc('create_store', {
        p_name: trimmed,
        p_slug: slugify(trimmed),
      });
      if (err) throw err;

      await refreshStores();
      router.replace('/setup/opening');
    } catch (err: unknown) {
      error.show(messageOf(err, 'Could not create your shop'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <p className={styles.step}>Step 1 of 2</p>
        <h1 className={styles.heading}>Set up your shop</h1>
        <p className={styles.sub}>
          This is the business whose stock and money you are keeping track of.
        </p>

      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={error} title="Could not create your shop" />

        <form onSubmit={submit} noValidate>
          <div className={styles.card}>
            <Field
              label="Shop name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Blessing Stores"
              hint="The name you and your customers know it by."
              autoFocus
              help={
                <Explain label="Can I change this later?">
                  Yes. The name is only used to label your records and receipts, so changing it
                  later changes nothing about your stock or your customers.
                </Explain>
              }
            />

            <Button type="submit" size="large" fullWidth busy={busy} busyLabel="Creating your shop">
              Continue
            </Button>
          </div>
        </form>

        <div className={styles.note}>
          <InfoPanel tone="info" title="Next: what you already have">
            Your shop did not start today. The next step records the stock on your shelf and the
            money people already owe you, so your records begin from where you actually are.
          </InfoPanel>
        </div>
      </div>
    </div>
  );
}

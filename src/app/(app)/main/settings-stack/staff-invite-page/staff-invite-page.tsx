'use client';

import { useEffect, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { settingsChanged, SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { getSupabase } from '@/lib/supabase/client';
import styles from './staff-invite-page.module.css';

/**
 * Adding somebody to the team — a page.
 *
 * An email address and a role, which is a form, and forms belong on pages. As a sheet the role
 * picker sat under the keyboard raised by the email field, so choosing what somebody is allowed to
 * do meant dismissing the keyboard first — on the screen that decides who can change prices and
 * who can see the takings.
 *
 * THE OUTCOME STAYS HERE rather than being handed back. Inviting somebody who already has an
 * account puts them in the list, which is its own confirmation; inviting somebody who does not
 * changes nothing visible at all, so the sentence explaining that they will be let in when they
 * sign up IS the result. Popping straight back would throw away the only feedback that matters in
 * the case where feedback matters most.
 */

const ROLE_SUMMARY: Record<string, string> = {
  owner: 'Everything, including staff, settings and correcting a finished sale.',
  manager: 'Everything day to day, but cannot add staff or change settings.',
  seller: 'Sells and takes payment. Cannot change prices or see the takings.',
  staff: 'Sells and takes payment. Cannot change prices or see the takings.',
  stock: 'Receives deliveries and counts stock. Does not sell.',
};

interface Role {
  code: string;
  name: string;
}

export default function StaffInvitePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();

  /*
   * The roles this member is allowed to hand out — its own key.
   *
   * Deliberately not sharing the staff page's `staff:<store>` entry: that holds a different shape
   * (members, invites, roles together), and two shapes under one key is the collision that white-
   * screened the bank page once already.
   */
  const [roles, demandRoles] = useDemandState<Role[]>([], {
    key: `assignable-roles:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    persist: true,
    deps: [store?.id ?? ''],
    revalidateOnMount: false,
  });

  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('staff');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!store) return;
    demandRoles(async ({ set }) => {
      const { data } = await getSupabase().rpc('assignable_roles', { p_store_id: store.id });
      set((data ?? []) as Role[], { override: true });
    });
  }, [store, demandRoles]);

  // Default to the first role once they load, so the picker never shows an empty selection.
  useEffect(() => {
    if (roles.length > 0 && !roles.some((r) => r.code === roleCode)) setRoleCode(roles[0].code);
  }, [roles, roleCode]);

  if (!store) return null;

  const invite = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { data, error } = await getSupabase().rpc('invite_staff', {
        p_store_id: store.id,
        p_email: email.trim(),
        p_role_code: roleCode,
      });
      if (error) throw error;
      const result = data as { joined: boolean; email: string };
      // Say the team moved, so the list behind this page re-reads when it is returned to.
      settingsChanged();
      setDone(
        result.joined
          ? `${result.email} already had an account and now works here.`
          : `We will let ${result.email} in as soon as they sign up with that address.`,
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That person could not be added.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <PageScaffold onBack={goBack} title="Added" subtitle="They can work here now">
        <InfoPanel tone="success" title="Done">
          {done}
        </InfoPanel>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={() => {
              // Straight into adding another, which is what somebody setting up a shop is doing.
              setDone(null);
              setEmail('');
            }}
          >
            Add another
          </Button>
          <Button onClick={() => void nav.pop()}>Back to the team</Button>
        </div>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Add someone to your team"
      subtitle="They sign in with their own email"
    >
      {problem && (
        <InfoPanel tone="danger" title="Not added">
          {problem}
        </InfoPanel>
      )}

      <Field
        label="Their email address"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@example.com"
        hint="They sign in with this. If they do not have an account yet, they join as soon as they make one."
        autoFocus
      />

      <div className={styles.field}>
        <label className={styles.label} htmlFor="invite-role">
          What can they do?
        </label>
        <select
          id="invite-role"
          className={styles.select}
          value={roleCode}
          onChange={(e) => setRoleCode(e.target.value)}
        >
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <p className={styles.roleNote}>{ROLE_SUMMARY[roleCode]}</p>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} disabled={!email.trim()} onClick={() => void invite()}>
          Add them
        </Button>
      </div>
    </PageScaffold>
  );
}

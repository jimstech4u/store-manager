'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { PlusIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import styles from './staff-page.module.css';

/**
 * Who works here, and what each of them may do.
 *
 * The permission matrix has existed in the database since the first migration and there was no
 * way to put a second person into it, so every shop had exactly one user and the owner served
 * every customer personally.
 *
 * Every rule that matters is enforced by the server, not here: you cannot grant a role at or
 * above your own, you cannot change your own, and a shop must keep an owner. The UI hides what it
 * knows is refused — the list of roles comes from `assignable_roles`, so a manager is never shown
 * "Owner" as an option — but the hiding is a courtesy. The refusal is the rule.
 */

interface Member {
  user_id: string;
  email: string;
  role_code: string;
  role_name: string;
  role_rank: number;
  joined_at: string;
  is_you: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role_code: string;
  role_name: string;
  expires_at: string;
}

interface Role {
  code: string;
  name: string;
  rank: number;
}

/** What each role can actually do, in the words a shop owner would use. */
const ROLE_SUMMARY: Record<string, string> = {
  owner: 'Everything, including staff, settings and correcting a finished sale.',
  manager: 'Sells, receives stock, counts, takes payments, and approves what staff add.',
  staff: 'Sells and takes payments. Anything they add waits for a manager to check.',
};

export default function StaffPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('staff');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const [m, i, r] = await Promise.all([
        supabase.rpc('list_staff', { p_store_id: store.id }),
        supabase.rpc('list_invitations', { p_store_id: store.id }),
        supabase.rpc('assignable_roles', { p_store_id: store.id }),
      ]);
      if (m.error) throw m.error;
      setMembers((m.data ?? []) as Member[]);
      setInvites((i.data ?? []) as Invitation[]);
      const assignable = (r.data ?? []) as Role[];
      setRoles(assignable);
      if (assignable.length > 0) setRoleCode(assignable[0].code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your team.');
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!store) return null;

  if (!can('staff.manage')) {
    return (
      <PageScaffold onBack={goBack} title="Your team">
        <InfoPanel tone="info" title="Only the owner manages staff">
          Adding people and changing what they can do is the owner&apos;s job. Ask them if
          something needs to change.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (loading && members.length === 0) {
    return <FullPageMessage title="Loading your team" tone="loading" />;
  }

  const invite = async () => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const { data, error: e } = await getSupabase().rpc('invite_staff', {
        p_store_id: store.id,
        p_email: email.trim(),
        p_role_code: roleCode,
      });
      if (e) throw e;
      const result = data as { joined: boolean; email: string };
      setNote(
        result.joined
          ? `${result.email} already had an account and now works here.`
          : `We will let ${result.email} in as soon as they sign up with that address.`,
      );
      setEmail('');
      setInviting(false);
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That person could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, code: string) => {
    setProblem(null);
    try {
      const { error: e } = await getSupabase().rpc('set_member_role', {
        p_store_id: store.id,
        p_user_id: member.user_id,
        p_role_code: code,
      });
      if (e) throw e;
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That role could not be changed.');
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Your team"
      subtitle={`${members.length} ${members.length === 1 ? 'person' : 'people'}`}
      actions={[
        {
          key: 'add',
          icon: <PlusIcon />,
          onClick: () => {
            setProblem(null);
            setInviting(true);
          },
          ariaLabel: 'Add someone to your team',
        },
      ]}
    >
      <Explain label="What do the roles mean?">
        <strong>Staff</strong> serve customers. They can sell and take money, and anything new they
        add — a product, a customer — is saved and usable straight away but marked for a manager to
        check.
        <br />
        <br />
        <strong>Managers</strong> do all of that plus stock: recording deliveries, counting, and
        approving what staff added.
        <br />
        <br />
        <strong>Owners</strong> can also change settings, manage the team, and correct a sale that
        has already been finished.
        <br />
        <br />
        You can only give someone a role below your own, and a shop must always have an owner.
      </Explain>

      {error && (
        <InfoPanel tone="danger" title="Could not load">
          {error}
        </InfoPanel>
      )}
      {problem && (
        <InfoPanel tone="danger" title="Not changed">
          {problem}
        </InfoPanel>
      )}
      {note && (
        <InfoPanel tone="success" title="Done">
          {note}
        </InfoPanel>
      )}

      <ul className={styles.list}>
        {members.map((m) => (
          <li key={m.user_id} className={styles.row}>
            <div className={styles.rowMain}>
              <p className={styles.email}>
                {m.email}
                {m.is_you && <span className={styles.you}>you</span>}
              </p>
              <p className={styles.roleNote}>{ROLE_SUMMARY[m.role_code] ?? m.role_name}</p>
            </div>

            <div className={styles.rowActions}>
              {/* Your own row, and anyone at or above your rank, is read-only. The server would
                  refuse either anyway; showing a control that always fails is worse than none. */}
              {m.is_you || roles.every((r) => r.rank < m.role_rank) ? (
                <span className={styles.roleTag}>{m.role_name}</span>
              ) : (
                <>
                  <label className={styles.srOnly} htmlFor={`role-${m.user_id}`}>
                    Role for {m.email}
                  </label>
                  <select
                    id={`role-${m.user_id}`}
                    className={styles.select}
                    value={m.role_code}
                    onChange={(e) => void changeRole(m, e.target.value)}
                  >
                    {roles.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.name}
                      </option>
                    ))}
                    {!roles.some((r) => r.code === m.role_code) && (
                      <option value={m.role_code}>{m.role_name}</option>
                    )}
                  </select>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => setConfirmRemove(m)}
                    aria-label={`Remove ${m.email}`}
                  >
                    <TrashIcon size="1.1em" />
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h2 className={styles.section}>Waiting to join</h2>
          <p className={styles.sectionNote}>
            These people have been given a role but have not signed up yet. They join automatically
            the first time they sign in with this email address.
          </p>
          <ul className={styles.list}>
            {invites.map((i) => (
              <li key={i.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <p className={styles.email}>{i.email}</p>
                  <p className={styles.roleNote}>
                    {i.role_name} · expires {new Date(i.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={async () => {
                    await getSupabase().rpc('revoke_invitation', { p_id: i.id });
                    await load();
                  }}
                  aria-label={`Cancel the invitation for ${i.email}`}
                >
                  <TrashIcon size="1.1em" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Sheet
        open={inviting}
        onClose={() => setInviting(false)}
        title="Add someone to your team"
        footer={
          <div className={styles.sheetActions}>
            <Button variant="secondary" onClick={() => setInviting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void invite()}>
              Add them
            </Button>
          </div>
        }
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
      </Sheet>

      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.email ?? ''}?`}
        footer={
          <div className={styles.sheetActions}>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              Keep them
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirmRemove) return;
                setProblem(null);
                try {
                  const { error: e } = await getSupabase().rpc('remove_member', {
                    p_store_id: store.id,
                    p_user_id: confirmRemove.user_id,
                  });
                  if (e) throw e;
                  setConfirmRemove(null);
                  await load();
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : 'They could not be removed.');
                  setConfirmRemove(null);
                }
              }}
            >
              Remove them
            </Button>
          </div>
        }
      >
        <p>
          They lose access to this shop immediately. Everything they recorded stays exactly as it
          is — sales, payments and counts keep their name on them.
        </p>
      </Sheet>
    </PageScaffold>
  );
}

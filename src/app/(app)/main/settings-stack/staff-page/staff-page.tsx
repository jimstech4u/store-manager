'use client';

import { useRef, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { PlusIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useResource } from '@/lib/stacks/resource';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import styles from './staff-page.module.css';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

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
  status: 'active' | 'removed';
  removed_at: string | null;
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

interface Team {
  members: Member[];
  invites: Invitation[];
  roles: Role[];
}
const NO_TEAM: Team = { members: [], invites: [], roles: [] };

export default function StaffPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  /*
   * The team, its outstanding invitations and the roles that may be handed out — one entry.
   *
   * Read together, shown together, and pushed off constantly: every member on this page opens
   * their own permissions screen. Three `useState`s meant coming back from that screen re-ran all
   * three calls behind a full-page "Loading your team", over a team that had not changed.
   */
  /*
   * A RESOURCE. The old snapshot stored its own error and a `settled` flag, persisted — so a first
   * read that failed was kept as a settled, EMPTY team: "you have no staff", on the page somebody
   * opens to check exactly that, and it stayed until something else invalidated settings. Now the
   * team is null until read, kept through a failed refresh, and a failure has its own Try again.
   */
  const res = useResource<Team>({
    key: `staff:v2:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(store),
    read: async () => {
      const supabase = getSupabase();
      const [m, i, r] = await Promise.all([
        supabase.rpc('list_staff', { p_store_id: store!.id, p_include_removed: true }),
        supabase.rpc('list_invitations', { p_store_id: store!.id }),
        supabase.rpc('assignable_roles', { p_store_id: store!.id }),
      ]);
      if (m.error) throw m.error;
      if (i.error) throw i.error;
      if (r.error) throw r.error;
      return {
        members: (m.data ?? []) as Member[],
        invites: (i.data ?? []) as Invitation[],
        roles: (r.data ?? []) as Role[],
      };
    },
  });

  // For the handlers below, which change one row here rather than re-reading the team.
  const snapshotRef = useRef<Team>(res.data ?? NO_TEAM);
  snapshotRef.current = res.data ?? NO_TEAM;
  const setSnapshot = res.set;

  const members = snapshotRef.current.members;
  const invites = snapshotRef.current.invites;
  const roles = snapshotRef.current.roles;
  const error = res.error;

  const problem = useProblem();

  const removeDialog = useConfirm();
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);

  if (!store) return null;

  // One header; the body waits for the team.
  const status: PageStatus = !can('staff.manage')
    ? {
        // Said inside the page's own header — it used to be a second page with a second header.
        state: 'empty',
        title: 'Only the owner manages staff',
        body: (
          <>
            Adding people and changing what they can do is the owner&apos;s job. Ask them if
            something needs to change.
          </>
        ),
      }
    : res.data
    ? { state: 'ready' }
    : error
      ? { state: 'error', what: 'your team', error, onRetry: res.reload }
      : { state: 'loading', what: 'your team' };

  const changeRole = async (member: Member, code: string) => {
    try {
      const { error: e } = await getSupabase().rpc('set_member_role', {
        p_store_id: store.id,
        p_user_id: member.user_id,
        p_role_code: code,
      });
      if (e) throw e;

      /*
       * The row is changed here, not re-read.
       *
       * `load()` fetched the whole team — members, invitations and roles, three calls — to learn
       * one person's role, with the old role on screen until it landed. The role name comes from
       * the list this screen already holds.
       */
      const named = snapshotRef.current.roles.find((r) => r.code === code);
      setSnapshot({
        ...snapshotRef.current,
        members: snapshotRef.current.members.map((m) =>
          m.user_id === member.user_id
            ? { ...m, role_code: code, role_name: named?.name ?? m.role_name }
            : m,
        ),
      });
    } catch (e) {
      problem.show(messageOf(e, 'That role could not be changed.'));
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Your team"
      subtitle={(() => {
        const active = members.filter((m) => m.status === 'active').length;
        return `${active} ${active === 1 ? 'person' : 'people'}`;
      })()}
      actions={
        can('staff.manage')
          ? [
              {
                key: 'add',
                icon: <PlusIcon />,
                onClick: () => {
                  void nav.push('staff_invite_page');
                },
                ariaLabel: 'Add someone to your team',
              },
            ]
          : undefined
      }
    >
      <PageState status={status}>
        {() =>
          (
            <>
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
        <InfoPanel tone="danger" title="Could not refresh your team">
          {error}{' '}
          <Button variant="secondary" size="small" onClick={res.reload}>
            Try again
          </Button>
        </InfoPanel>
      )}
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not changed" />

      <ul className={styles.list}>
        {members.filter((m) => m.status === 'active').map((m) => (
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

      {/*
        People who used to work here.
        Removing somebody marks them rather than deleting them, so their name stays on every sale,
        count and payment they recorded and "who had access, and when" is still answerable. Hiding
        them from this screen entirely would make that record exist and be unfindable.
      */}
      {members.some((m) => m.status === 'removed') && (
        <>
          <h2 className={styles.section}>No longer here</h2>
          <ul className={styles.list}>
            {members
              .filter((m) => m.status === 'removed')
              .map((m) => (
                <li key={m.user_id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <p className={styles.email}>{m.email}</p>
                    <p className={styles.roleNote}>
                      Was {m.role_name}
                      {m.removed_at
                        ? ` · left ${new Date(m.removed_at).toLocaleDateString()}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      await getSupabase().rpc('restore_member', {
                        p_store_id: store.id,
                        p_user_id: m.user_id,
                      });

                      // Back among the active, without re-reading the team to be told so.
                      setSnapshot({
                        ...snapshotRef.current,
                        members: snapshotRef.current.members.map((x) =>
                          x.user_id === m.user_id
                            ? { ...x, status: 'active', removed_at: null }
                            : x,
                        ),
                      });
                    }}
                  >
                    Bring back
                  </Button>
                </li>
              ))}
          </ul>
        </>
      )}

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

                    // Taken off the waiting list here; nothing about the rest of the team changed.
                    setSnapshot({
                      ...snapshotRef.current,
                      invites: snapshotRef.current.invites.filter((x) => x.id !== i.id),
                    });
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

      {/*
        A CONFIRMATION IS A DIALOG (DialogViewer), not a bottom sheet — and mounted only while it is
        being asked, because `ConfirmDialog` opens itself on mount.
      */}
      {confirmRemove && (
        <ConfirmDialog
          controller={removeDialog}
          title={`Remove ${confirmRemove.email}?`}
          message={
            'They lose access to this shop immediately. Everything they recorded stays exactly as ' +
            'it is — sales, payments and counts keep their name on them.'
          }
          confirmText="Remove them"
          cancelText="Keep them"
          tone="danger"
          onDismiss={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            void (async () => {
              try {
                const { error: e } = await getSupabase().rpc('remove_member', {
                  p_store_id: store.id,
                  p_user_id: target.user_id,
                });
                if (e) throw e;
                // Taken out of the list here: this device knows exactly who went.
                setSnapshot({
                  ...snapshotRef.current,
                  members: snapshotRef.current.members.filter((m) => m.user_id !== target.user_id),
                });
              } catch (e) {
                problem.show(messageOf(e, 'They could not be removed.'));
              }
            })();
          }}
        />
      )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}

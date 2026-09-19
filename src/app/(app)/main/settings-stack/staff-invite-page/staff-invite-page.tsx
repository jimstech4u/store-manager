'use client';

import { useEffect, useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useResource } from '@/lib/stacks/resource';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { settingsChanged, SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { getSupabase } from '@/lib/supabase/client';
import styles from './staff-invite-page.module.css';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { messageOf } from '@/lib/format';

/**
 * Giving somebody a till.
 *
 * A shop hires a person, not an email address. This asks for the person — name, phone, where they
 * live — and issues them a login the shop itself owns, on its own namespace:
 * `john.ajibewa@ashabiglobal.sm`. Nobody behind a counter should need a personal email account
 * before they can be paid to sell.
 *
 * THE ADMIN SETS THE FIRST PASSWORD and the staff member must replace it before they can do
 * anything. A password two people know is not a password; it is a shared key that happens to be
 * typed. The first thing that login does is ask them to choose their own.
 *
 * PERMISSIONS ARE A CHECKLIST, not a role. The role is a starting point — tick "Seller" and the
 * usual boxes tick themselves — and then the admin adjusts. Every real shop has somebody who is a
 * seller EXCEPT that they also count stock, and there is no role name for that.
 */

interface Role {
  code: string;
  name: string;
}

interface Permission {
  code: string;
  description: string;
}

/*
 * The checklist, grouped the way a shop thinks about it rather than alphabetically.
 *
 * Sixteen unlabelled checkboxes is a form nobody reads. These are the four questions an owner is
 * actually answering: can they sell, can they touch the stock, can they see the money, can they
 * change how the shop works.
 */
const GROUPS: { title: string; note: string; codes: string[] }[] = [
  {
    title: 'Selling',
    note: 'The counter. Most people who work here need all of this.',
    codes: ['sales.record', 'payments.record', 'customers.manage', 'deposits.manage'],
  },
  {
    title: 'Stock',
    note: 'Receiving deliveries, counting, and explaining what went missing.',
    codes: ['stock.receive', 'stock.count', 'stock.adjust', 'variance.resolve', 'products.manage'],
  },
  {
    title: 'Money and records',
    note: 'What the shop earned, and correcting what was written down.',
    codes: ['reports.view', 'sales.amend', 'backfill.manage', 'customers.merge'],
  },
  {
    title: 'Running the shop',
    note: 'Keep these for people you would trust with the keys.',
    codes: ['staff.manage', 'store.settings', 'period.reopen'],
  },
];

export default function StaffInvitePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();

  /*
   * What can be handed out, and the shop's login domain.
   *
   * A resource: it started as no roles and no permissions — an empty role list and a form with no
   * boxes — and every read's error was ignored, so a failure left it that way for good.
   */
  const referenceRes = useResource<{
    roles: Role[];
    permissions: Permission[];
    domain: string | null;
  }>({
    key: `staff-reference:v2:${store?.id ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(store),
    read: async () => {
      const supabase = getSupabase();
      const [roles, permissions, domain] = await Promise.all([
        supabase.rpc('assignable_roles', { p_store_id: store!.id }),
        supabase.rpc('list_permissions'),
        supabase.rpc('ensure_login_domain', { p_store_id: store!.id }),
      ]);
      if (roles.error) throw roles.error;
      if (permissions.error) throw permissions.error;
      if (domain.error) throw domain.error;
      return {
        roles: (roles.data ?? []) as Role[],
        permissions: (permissions.data ?? []) as Permission[],
        domain: (domain.data as string | null) ?? null,
      };
    },
  });
  const reference = referenceRes.data ?? { roles: [], permissions: [], domain: null };

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState('staff');

  // What the role gives, before the admin touches anything. Kept apart from `allowed` so the page
  // can tell "the role does this" from "somebody chose this".
  const [allowed, setAllowed] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const [busy, setBusy] = useState(false);
  const problem = useProblem();
  const [done, setDone] = useState<{ email: string; warning?: string } | null>(null);


  // Default to the least powerful role on offer, so a slip of the finger cannot hand somebody the
  // keys to the shop.
  useEffect(() => {
    if (reference.roles.length > 0 && !reference.roles.some((r) => r.code === roleCode)) {
      setRoleCode(reference.roles[reference.roles.length - 1].code);
    }
  }, [reference.roles, roleCode]);

  /*
   * Picking a role re-ticks the boxes — unless the admin has already started ticking.
   *
   * A role is a starting point. Silently discarding somebody's hand-made checklist because they
   * changed the role afterwards would be the more annoying half of that trade, so once they have
   * touched a box the role stops rewriting their work.
   */
  /*
   * READ, NOT ASSUMED. The read's error was ignored and a failure gave the role no boxes — and the
   * login was then created with none ticked, a person who can sign in and do nothing. The Create
   * button now waits until the role's boxes are known.
   */
  const roleRes = useLoadArea(
    async () => {
      const { data, error } = await getSupabase().rpc('role_permission_codes', {
        p_role_code: roleCode,
      });
      if (error) throw error;
      return ((data ?? []) as { permission_code: string }[]).map((r) => r.permission_code);
    },
    [roleCode],
    { key: `role-permissions:${roleCode}`, scope: SETTINGS_SCOPE, whenNot: !store || !roleCode },
  );
  const rolePermissions = useMemo(() => roleRes.data ?? [], [roleRes.data]);
  useEffect(() => {
    if (roleRes.data && !touched) setAllowed(roleRes.data);
  }, [roleRes.data, touched]);

  const loginPreview = useMemo(() => {
    const clean = (v: string) =>
      v
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const local = [clean(firstName), clean(lastName)].filter(Boolean).join('.');
    if (!local || !reference.domain) return null;
    return `${local}@${reference.domain}.sm`;
  }, [firstName, lastName, reference.domain]);

  const addedDialog = useConfirm();

  if (!store) return null;

  const toggle = (code: string) => {
    setTouched(true);
    setAllowed((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  /*
   * Clear the form for the next person.
   *
   * Shared by "Add another" and by the sheet closing, so both leave the screen in the same state.
   * Somebody setting up a shop adds several people in a row, and the alternative — a form still
   * holding the last person's name — is how the second staff member ends up called Tunde too.
   */
  const addAnother = () => {
    setDone(null);
    setFirstName('');
    setLastName('');
    setPhone('');
    setAddress('');
    setPassword('');
    setTouched(false);
  };

  const create = async () => {
    setBusy(true);
    try {
      const { data: session } = await getSupabase().auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Your session has expired. Sign in again.');

      const response = await fetch('/api/create-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          storeId: store.id,
          firstName,
          lastName,
          phone,
          address,
          password,
          roleCode,
          permissions: allowed,
        }),
      });

      const result = (await response.json()) as {
        email?: string;
        error?: string;
        warning?: string;
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(result.error ?? 'That account could not be created.');
      }

      settingsChanged();
      setDone({ email: result.email ?? '', warning: result.warning });
    } catch (e) {
      problem.show(messageOf(e, 'That account could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  const byCode = new Map(reference.permissions.map((p) => [p.code, p]));

  // One header; the form waits for what it offers.
  const status: PageStatus = referenceRes.loaded
    ? { state: 'ready' }
    : referenceRes.error
      ? { state: 'error', what: 'the roles', error: referenceRes.error, onRetry: referenceRes.reload }
      : { state: 'loading', what: 'the roles' };

  return (
    <PageScaffold
      onBack={goBack}
      title="Add someone to your team"
      subtitle="They sign in with a login this shop owns"
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not added" />

      <PageState status={status}>
        {() => (
          <>

      <Field
        label="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
        placeholder="John"
        autoFocus
      />

      <Field
        label="Last name"
        optional
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
        placeholder="Ajibewa"
      />

      {loginPreview && (
        <InfoPanel tone="info" title="They will sign in as">
          <p className={styles.credential}>{loginPreview}</p>
          <p>
            This address belongs to your shop. Nothing is sent to it — if they forget their
            password, you set them a new one.
          </p>
        </InfoPanel>
      )}

      <Field
        label="Phone"
        optional
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 000 0000"
        hint="How you reach them when they are not at the counter."
      />

      <Field
        label="Address"
        optional
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Where they live"
      />

      <Field
        label="First password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="At least 8 characters. Tell it to them — they choose their own when they first sign in."
        autoComplete="new-password"
      />

      <div className={styles.field}>
        <label className={styles.label} htmlFor="staff-role">
          Start from
        </label>
        <select
          id="staff-role"
          className={styles.select}
          value={roleCode}
          onChange={(e) => {
            setRoleCode(e.target.value);
            // Choosing a role again is asking for its boxes back.
            setTouched(false);
          }}
        >
          {reference.roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <p className={styles.roleNote}>
          A starting point. Change any of the boxes below and they stay changed.
        </p>
      </div>

      <Explain label="What do these permissions mean?">
        Each box is one thing a person can do in this app. The database enforces them, not just the
        screens — somebody without <strong>Change prices</strong> cannot change a price by any
        route, not merely by not seeing the button.
        <br />
        <br />
        A box left as the role sets it keeps following the role. If you later make somebody a
        manager, everything you did not tick or untick by hand moves with them.
      </Explain>

      {/* The role's own boxes, on their way or not readable — never shown as none ticked. */}
      {!roleRes.data && <LoadArea area={roleRes} what="what this role can do" compact>{() => null}</LoadArea>}

      {GROUPS.map((group) => (
        <div key={group.title} className={styles.group}>
          <h2 className={styles.groupTitle}>{group.title}</h2>
          <p className={styles.groupNote}>{group.note}</p>

          {group.codes
            .filter((code) => byCode.has(code))
            .map((code) => {
              const permission = byCode.get(code)!;
              const isOn = allowed.includes(code);
              const fromRole = rolePermissions.includes(code);
              return (
                <label key={code} className={styles.check}>
                  <input type="checkbox" checked={isOn} onChange={() => toggle(code)} />
                  <span>
                    <strong>{permission.description}</strong>
                    {isOn !== fromRole && (
                      <span className={styles.changed}>
                        {isOn ? 'added for this person' : 'removed for this person'}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
        </div>
      ))}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button
          busy={busy}
          disabled={!firstName.trim() || password.length < 8 || !roleRes.data}
          onClick={() => void create()}
        >
          Create their login
        </Button>
      </div>

      {/*
        The result is a SHEET, not another page.

        A form belongs on a page; this is not a form. It is a short message with two ways on, and
        nothing to type — so it does not need the keyboard room a page exists to provide, and
        replacing the whole screen to say six words hides the form somebody may want to fill in
        again for the next person.

        Not dismissible by a stray tap or a downward drag. It is carrying the login address, and
        the address is the one thing the admin cannot get back by any other route on this screen —
        losing it to a mis-swipe means going to the team list to look it up.
      */}
      {/*
        THE RESULT IS A MESSAGE, so it is a dialog (DialogViewer) — not a bottom sheet. Mounted only
        while there is something to say, because `ConfirmDialog` opens itself on mount.
      */}
      {done && (
        <ConfirmDialog
          controller={addedDialog}
          title="Added"
          message={
            `Their login is ${done.email}. Give them this address and the password you chose — ` +
            'they will be asked to pick their own the first time they sign in.' +
            (done.warning ? ` One thing did not save: ${done.warning}` : '')
          }
          confirmText="Back to the team"
          cancelText="Add another"
          tone="primary"
          onDismiss={addAnother}
          onConfirm={() => void nav.pop()}
        />
      )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}

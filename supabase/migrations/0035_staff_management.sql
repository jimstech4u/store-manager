-- =====================================================================================
-- 0035 — Staff: who works here, what they may do, and how they get in
--
-- The permission matrix has existed since 0001 and there has been no way to put anybody into it.
-- A shop has had exactly one user — whoever signed up — which makes the whole RBAC design
-- decorative and means the owner does every sale personally.
--
-- Three guards run through all of this, and they are the reason it is server-side rather than a
-- form that writes to `store_members`:
--
--  1. RANK. You may only grant a role BELOW your own. Without this, a manager promotes themselves
--     to owner and the hierarchy is a suggestion.
--  2. THE LAST OWNER. A shop must always have one. Removing or demoting the last owner locks
--     everybody out of their own data permanently, with no recovery path that does not involve us.
--  3. YOURSELF. You cannot change your own role. It is the same escalation as (1) by another
--     route, and nobody legitimately needs it.
-- =====================================================================================

-- ─── Invitations ────────────────────────────────────────────────────────────────────
--
-- Staff usually do not have an account yet — a shop hires someone and wants them working that
-- afternoon. The invitation carries the intended role and is claimed on first sign-in, so the
-- owner does the thinking once and the new person does nothing but sign up.

create table if not exists public.store_invitations (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  email      text not null,
  role_code  text not null references public.roles (code),
  invited_by uuid references auth.users (id),
  status     text not null default 'pending'
             check (status in ('pending', 'accepted', 'revoked')),
  -- Invitations expire. A link that grants access to a shop's money forever is a liability
  -- sitting in somebody's inbox.
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id)
);

-- One live invitation per email per shop. Re-inviting should update the role, not stack up
-- several invitations that each grant something different.
create unique index if not exists store_invitations_pending_key
  on public.store_invitations (store_id, lower(email)) where status = 'pending';

create index if not exists store_invitations_email_idx
  on public.store_invitations (lower(email)) where status = 'pending';

alter table public.store_invitations enable row level security;

drop policy if exists invitations_read on public.store_invitations;
create policy invitations_read on public.store_invitations
  for select to authenticated using (public.has_permission(store_id, 'staff.manage'));

-- No direct writes at all. Every path goes through the functions below so the rank and
-- last-owner guards cannot be skipped by writing the table.
drop policy if exists invitations_write on public.store_invitations;

drop trigger if exists audit on public.store_invitations;
create trigger audit after insert or update or delete on public.store_invitations
  for each row execute function public.tg_audit();

-- ─── Reading the team ───────────────────────────────────────────────────────────────

/**
 * Everyone who works here, with the email they sign in with.
 *
 * SECURITY DEFINER because it reads `auth.users`, which is not readable by `authenticated` and
 * should not be. The permission check is therefore the whole boundary and is not optional.
 */
create or replace function public.list_staff(p_store_id uuid)
returns table (
  user_id    uuid,
  email      text,
  role_code  text,
  role_name  text,
  role_rank  int,
  joined_at  timestamptz,
  is_you     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id,
         u.email::text,
         m.role_code,
         r.name,
         r.rank,
         m.joined_at,
         m.user_id = auth.uid()
    from public.store_members m
    join public.roles r on r.code = m.role_code
    join auth.users u on u.id = m.user_id
   where m.store_id = p_store_id
     and public.has_permission(p_store_id, 'staff.manage')
   order by r.rank desc, u.email;
$fn$;

create or replace function public.list_invitations(p_store_id uuid)
returns table (
  id         uuid,
  email      text,
  role_code  text,
  role_name  text,
  expires_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select i.id, i.email, i.role_code, r.name, i.expires_at, i.created_at
    from public.store_invitations i
    join public.roles r on r.code = i.role_code
   where i.store_id = p_store_id
     and i.status = 'pending'
     and public.has_permission(p_store_id, 'staff.manage')
   order by i.created_at desc;
$fn$;

/** The roles the caller is allowed to hand out — everything strictly below their own. */
create or replace function public.assignable_roles(p_store_id uuid)
returns table (code text, name text, rank int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.code, r.name, r.rank
    from public.roles r
   where public.has_permission(p_store_id, 'staff.manage')
     and r.rank < (select r2.rank
                     from public.store_members m
                     join public.roles r2 on r2.code = m.role_code
                    where m.store_id = p_store_id and m.user_id = auth.uid())
   order by r.rank desc;
$fn$;

-- ─── Changing the team ──────────────────────────────────────────────────────────────

/** The caller's rank in this shop, or null when they are not a member. */
create or replace function public.my_rank(p_store_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.rank
    from public.store_members m
    join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = auth.uid();
$fn$;

create or replace function public.invite_staff(
  p_store_id  uuid,
  p_email     text,
  p_role_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_rank    int;
  v_my_rank int;
  v_user    uuid;
  v_id      uuid;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to add staff' using errcode = '42501';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'that does not look like an email address' using errcode = '22023';
  end if;

  select rank into v_rank from public.roles where code = p_role_code;
  if v_rank is null then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  v_my_rank := public.my_rank(p_store_id);
  if v_rank >= coalesce(v_my_rank, 0) then
    raise exception 'you can only give someone a role below your own' using errcode = '42501';
  end if;

  -- Already has an account? Add them now; there is nothing to wait for.
  select id into v_user from auth.users where lower(email) = v_email;

  if v_user is not null then
    if exists (select 1 from public.store_members
                where store_id = p_store_id and user_id = v_user) then
      raise exception 'that person already works here' using errcode = '22023';
    end if;

    insert into public.store_members (store_id, user_id, role_code, invited_by)
    values (p_store_id, v_user, p_role_code, auth.uid());

    return jsonb_build_object('joined', true, 'email', v_email);
  end if;

  insert into public.store_invitations (store_id, email, role_code, invited_by)
  values (p_store_id, v_email, p_role_code, auth.uid())
  on conflict (store_id, lower(email)) where status = 'pending'
  do update set role_code = excluded.role_code,
                expires_at = now() + interval '14 days',
                invited_by = auth.uid()
  returning id into v_id;

  return jsonb_build_object('joined', false, 'invitation_id', v_id, 'email', v_email);
end;
$fn$;

create or replace function public.revoke_invitation(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.store_invitations where id = p_id;
  if v_store is null then
    raise exception 'that invitation no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'staff.manage') then
    raise exception 'you do not have permission to change staff' using errcode = '42501';
  end if;
  update public.store_invitations set status = 'revoked' where id = p_id;
  return p_id;
end;
$fn$;

/**
 * Claim every invitation waiting for the signed-in user's email address.
 *
 * Called after sign-in rather than from a link with a token in it. A token in a URL gets
 * forwarded, pasted into a group chat and indexed; matching on the verified email of the account
 * actually signing in gives the same convenience with nothing to leak.
 */
create or replace function public.accept_invitations()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email text;
  v_count int := 0;
  v_inv   record;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then
    return 0;
  end if;

  for v_inv in
    select * from public.store_invitations
     where lower(email) = v_email and status = 'pending' and expires_at > now()
  loop
    insert into public.store_members (store_id, user_id, role_code, invited_by)
    values (v_inv.store_id, auth.uid(), v_inv.role_code, v_inv.invited_by)
    on conflict (store_id, user_id) do nothing;

    update public.store_invitations
       set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
     where id = v_inv.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

create or replace function public.set_member_role(
  p_store_id  uuid,
  p_user_id   uuid,
  p_role_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_new_rank     int;
  v_their_rank   int;
  v_my_rank      int;
  v_owner_count  int;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to change staff' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;

  select rank into v_new_rank from public.roles where code = p_role_code;
  if v_new_rank is null then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  select r.rank into v_their_rank
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = p_user_id;
  if v_their_rank is null then
    raise exception 'that person does not work here' using errcode = 'P0002';
  end if;

  v_my_rank := public.my_rank(p_store_id);

  -- Both ends are checked. Guarding only the new role would let a manager demote the owner.
  if v_their_rank >= coalesce(v_my_rank, 0) or v_new_rank >= coalesce(v_my_rank, 0) then
    raise exception 'you can only change someone whose role is below your own'
      using errcode = '42501';
  end if;

  update public.store_members
     set role_code = p_role_code
   where store_id = p_store_id and user_id = p_user_id;

  select count(*) into v_owner_count
    from public.store_members where store_id = p_store_id and role_code = 'owner';
  if v_owner_count = 0 then
    raise exception 'a shop must always have an owner' using errcode = '22023';
  end if;

  return p_user_id;
end;
$fn$;

create or replace function public.remove_member(p_store_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_their_rank  int;
  v_my_rank     int;
  v_owner_count int;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to change staff' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'you cannot remove yourself' using errcode = '42501';
  end if;

  select r.rank into v_their_rank
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = p_user_id;
  if v_their_rank is null then
    raise exception 'that person does not work here' using errcode = 'P0002';
  end if;

  v_my_rank := public.my_rank(p_store_id);
  if v_their_rank >= coalesce(v_my_rank, 0) then
    raise exception 'you can only remove someone whose role is below your own'
      using errcode = '42501';
  end if;

  delete from public.store_members where store_id = p_store_id and user_id = p_user_id;

  select count(*) into v_owner_count
    from public.store_members where store_id = p_store_id and role_code = 'owner';
  if v_owner_count = 0 then
    raise exception 'a shop must always have an owner' using errcode = '22023';
  end if;

  return p_user_id;
end;
$fn$;

-- ─── Grants ─────────────────────────────────────────────────────────────────────────

revoke all on function public.list_staff(uuid)                       from public;
revoke all on function public.list_invitations(uuid)                 from public;
revoke all on function public.assignable_roles(uuid)                 from public;
revoke all on function public.my_rank(uuid)                          from public;
revoke all on function public.invite_staff(uuid, text, text)         from public;
revoke all on function public.revoke_invitation(uuid)                from public;
revoke all on function public.accept_invitations()                   from public;
revoke all on function public.set_member_role(uuid, uuid, text)      from public;
revoke all on function public.remove_member(uuid, uuid)              from public;

grant execute on function public.list_staff(uuid)                    to authenticated;
grant execute on function public.list_invitations(uuid)              to authenticated;
grant execute on function public.assignable_roles(uuid)              to authenticated;
grant execute on function public.my_rank(uuid)                       to authenticated;
grant execute on function public.invite_staff(uuid, text, text)      to authenticated;
grant execute on function public.revoke_invitation(uuid)             to authenticated;
grant execute on function public.accept_invitations()                to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text)   to authenticated;
grant execute on function public.remove_member(uuid, uuid)           to authenticated;

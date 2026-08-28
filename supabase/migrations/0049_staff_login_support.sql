-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The small pieces the staff login flow needs
-- ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Is this address already an account?
 *
 * Used when building `john.ajibewa@ashabiglobal.sm`, to suffix the second John Ajibewa rather than
 * silently hand them the first one's login.
 *
 * NOT granted to `authenticated`. Asking "does this account exist" is account enumeration, and the
 * only caller is the server-side route holding the service key — which is exactly the caller that
 * has a legitimate reason to ask.
 */
create or replace function public.email_in_use(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;

revoke all on function public.email_in_use(text) from public, anon, authenticated;
grant execute on function public.email_in_use(text) to service_role;

/**
 * "I have chosen my own password now."
 *
 * Called by the staff member themselves, which is why it takes no user id: the only account
 * anybody may clear this flag on is their own. An admin-set password is a password two people
 * know, and this is the moment that stops being true.
 */
create or replace function public.password_changed()
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.store_members
     set must_change_password = false
   where user_id = auth.uid();
$$;

grant execute on function public.password_changed() to authenticated;

/**
 * What the signed-in person needs to know about themselves, before the app draws anything.
 *
 * One call rather than three: whether they must change their password, whether they are staff of a
 * shop rather than its owner, and which shop. The app gates on this at sign-in, so it is on the
 * critical path of every session and does not deserve three round trips.
 */
create or replace function public.my_membership()
returns table (
  store_id             uuid,
  store_name           text,
  role_code            text,
  must_change_password boolean,
  login_email          text,
  is_staff_login       boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.store_id, s.name, m.role_code, m.must_change_password, m.login_email,
         -- A staff login is one this shop issued. An owner who signed up with their own address
         -- has no `login_email`, and none of the staff rules apply to them.
         m.login_email is not null
    from public.store_members m
    join public.stores s on s.id = m.store_id
   where m.user_id = auth.uid()
     and m.status = 'active'
   order by m.joined_at
   limit 1;
$$;

grant execute on function public.my_membership() to authenticated;

/**
 * Change what an existing staff member is allowed to do, and who they are.
 *
 * Details only — never the password, which needs the service key and therefore the server route.
 * Kept separate from `set_member_permissions` because renaming somebody and re-permissioning them
 * are different decisions, and an admin correcting a misspelt surname should not have to restate a
 * checklist to do it.
 */
create or replace function public.update_staff_details(
  p_store_id   uuid,
  p_user_id    uuid,
  p_first_name text,
  p_last_name  text,
  p_phone      text,
  p_address    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_rank  int;
  v_target_rank int;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to manage staff here' using errcode = '42501';
  end if;

  select r.rank into v_actor_rank
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = auth.uid();

  select r.rank into v_target_rank
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = p_user_id;

  if v_target_rank is null then
    raise exception 'that person does not work here' using errcode = 'P0002';
  end if;

  -- Same rank rule as the permission checklist. Editing your senior's details is editing your
  -- senior.
  if v_actor_rank is null or (v_actor_rank <= v_target_rank and p_user_id <> auth.uid()) then
    raise exception 'you cannot change this person''s details' using errcode = '42501';
  end if;

  update public.store_members
     set first_name = nullif(trim(coalesce(p_first_name, '')), ''),
         last_name  = nullif(trim(coalesce(p_last_name, '')), ''),
         phone      = nullif(trim(coalesce(p_phone, '')), ''),
         address    = nullif(trim(coalesce(p_address, '')), '')
   where store_id = p_store_id and user_id = p_user_id;
end;
$$;

grant execute on function public.update_staff_details(uuid, uuid, text, text, text, text)
  to authenticated;

/**
 * What a role gives, so the checklist can start from it.
 *
 * The form ticks these when an admin picks a role, then lets them adjust. Readable by anybody
 * signed in: it is the same fixed table the product ships with, and knowing that a "Manager" can
 * receive stock is not a secret about any particular shop.
 */
create or replace function public.role_permission_codes(p_role_code text)
returns table (permission_code text)
language sql
stable
as $$
  select rp.permission_code
    from public.role_permissions rp
   where rp.role_code = p_role_code
   order by rp.permission_code;
$$;

grant execute on function public.role_permission_codes(text) to authenticated;

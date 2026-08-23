-- =====================================================================================
-- 0045 — Nothing is deleted; things are voided
--
-- The rule for this whole product is that a record can stop applying but must never stop
-- existing. Most of it already worked that way — products, customers and bank accounts archive —
-- but three paths still removed rows outright:
--
--   · removing a member deleted `store_members`, so "who could see the takings in March?" had no
--     answer, and a dismissed employee left no trace of ever having worked there
--   · revoking an invitation left `status = 'revoked'`, which was right, but the read path could
--     not show revoked ones so it behaved like a delete
--   · deleting a product photo removed the `product_media` row
--
-- The draft-order deletes in 0042 are deliberately NOT touched: a draft is scratch space being
-- edited at a counter, replaced wholesale on every keystroke-driven save, and nothing references
-- it. Once it settles it becomes a sale, and sales are append-only. Treating unsaved working
-- state as history would be ceremony, not accountability.
-- =====================================================================================

-- ─── Members are ended, not erased ──────────────────────────────────────────────────

alter table public.store_members
  add column if not exists status text not null default 'active'
    check (status in ('active', 'removed')),
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references auth.users (id);

/**
 * Access is decided by membership AND status.
 *
 * `is_store_member` is the gate every RLS policy and SECURITY DEFINER function leans on, so this
 * is the single place a removed member actually loses access. Missing it here would leave a
 * "removed" person still able to read the shop, which would make the whole change cosmetic.
 */
create or replace function public.is_store_member(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.store_members m
     where m.store_id = p_store_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  );
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
   where m.store_id = p_store_id and m.user_id = p_user_id and m.status = 'active';
  if v_their_rank is null then
    raise exception 'that person does not work here' using errcode = 'P0002';
  end if;

  v_my_rank := public.my_rank(p_store_id);
  if v_their_rank >= coalesce(v_my_rank, 0) then
    raise exception 'you can only remove someone whose role is below your own'
      using errcode = '42501';
  end if;

  -- Marked, not deleted. Their name stays on every sale, count and payment they recorded, and
  -- "who had access, and when" remains answerable.
  update public.store_members
     set status = 'removed', removed_at = now(), removed_by = auth.uid()
   where store_id = p_store_id and user_id = p_user_id;

  select count(*) into v_owner_count
    from public.store_members
   where store_id = p_store_id and role_code = 'owner' and status = 'active';
  if v_owner_count = 0 then
    raise exception 'a shop must always have an owner' using errcode = '22023';
  end if;

  return p_user_id;
end;
$fn$;

/** Bring somebody back — a dismissal reversed, or the wrong person removed. */
create or replace function public.restore_member(p_store_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to change staff' using errcode = '42501';
  end if;
  update public.store_members
     set status = 'active', removed_at = null, removed_by = null
   where store_id = p_store_id and user_id = p_user_id;
  return p_user_id;
end;
$fn$;

-- `list_staff` shows current people by default and past ones on request, so a removed member is
-- visible rather than simply gone.
create or replace function public.list_staff(p_store_id uuid, p_include_removed boolean default false)
returns table (
  user_id    uuid,
  email      text,
  role_code  text,
  role_name  text,
  role_rank  int,
  joined_at  timestamptz,
  is_you     boolean,
  status     text,
  removed_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id, u.email::text, m.role_code, r.name, r.rank, m.joined_at,
         m.user_id = auth.uid(), m.status, m.removed_at
    from public.store_members m
    join public.roles r on r.code = m.role_code
    join auth.users u on u.id = m.user_id
   where m.store_id = p_store_id
     and (p_include_removed or m.status = 'active')
     and public.has_permission(p_store_id, 'staff.manage')
   order by (m.status = 'active') desc, r.rank desc, u.email;
$fn$;

drop function if exists public.list_staff(uuid);

-- ─── Product photos are hidden, not erased ──────────────────────────────────────────

alter table public.product_media
  add column if not exists status text not null default 'active'
    check (status in ('active', 'voided')),
  add column if not exists voided_at timestamptz;

alter table public.store_media
  add column if not exists status text not null default 'active'
    check (status in ('active', 'voided')),
  add column if not exists voided_at timestamptz;

/**
 * Hide a picture without destroying it.
 *
 * The stored FILE is kept too. A photo removed by mistake is otherwise unrecoverable, and the
 * storage cost of a handful of product images is not worth that risk. Deleting the object is a
 * separate, deliberate housekeeping decision.
 */
create or replace function public.void_product_media(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select p.store_id into v_store
    from public.product_media m join public.products p on p.id = m.product_id
   where m.id = p_id;
  if v_store is null then
    raise exception 'that picture no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change pictures' using errcode = '42501';
  end if;
  update public.product_media set status = 'voided', voided_at = now() where id = p_id;
  return p_id;
end;
$fn$;

create or replace function public.restore_product_media(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select p.store_id into v_store
    from public.product_media m join public.products p on p.id = m.product_id
   where m.id = p_id;
  if v_store is null then
    raise exception 'that picture no longer exists' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change pictures' using errcode = '42501';
  end if;
  update public.product_media set status = 'active', voided_at = null where id = p_id;
  return p_id;
end;
$fn$;

-- Voided pictures must stop being served publicly, or hiding one achieves nothing.
--
-- Same signature and same returned columns as before: this is a filter change, not a shape change.
-- Widening the result would have meant dropping and recreating the function, which breaks every
-- caller mid-deploy for the sake of columns nothing asked for.
create or replace function public.public_product_media(p_product_id uuid)
returns table (kind text, path text, alt text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pm.kind, pm.path, pm.alt
  from public.product_media pm
  join public.products p on p.id = pm.product_id
  join public.stores s on s.id = p.store_id
  where pm.product_id = p_product_id
    and pm.status = 'active'
    and (s.is_public or public.is_store_member(s.id))
  order by pm.sort_order;
$fn$;

create or replace function public.public_store_media(p_store_id uuid)
returns table (kind text, path text, alt text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select sm.kind, sm.path, sm.alt
  from public.store_media sm
  join public.stores s on s.id = sm.store_id
  where sm.store_id = p_store_id
    and sm.status = 'active'
    and (s.is_public or public.is_store_member(s.id))
  order by sm.sort_order;
$fn$;

-- ─── Grants ─────────────────────────────────────────────────────────────────────────

revoke all on function public.restore_member(uuid, uuid)          from public;
revoke all on function public.void_product_media(uuid)            from public;
revoke all on function public.restore_product_media(uuid)         from public;

grant execute on function public.list_staff(uuid, boolean)        to authenticated;
grant execute on function public.remove_member(uuid, uuid)        to authenticated;
grant execute on function public.restore_member(uuid, uuid)       to authenticated;
grant execute on function public.void_product_media(uuid)         to authenticated;
grant execute on function public.restore_product_media(uuid)      to authenticated;
grant execute on function public.public_product_media(uuid)       to anon, authenticated;
grant execute on function public.public_store_media(uuid)         to anon, authenticated;
grant execute on function public.is_store_member(uuid)            to anon, authenticated;

-- 0278 - A checker does not check their own work
--
-- "Waiting for you is wrong: Olanike is the admin, but it needs the role again to approve what the
-- admin did." The queue (0028, 0227) listed every count, adjustment and write-off, and every customer
-- or item left unconfirmed, whoever made it. In Ashabi on 11 Nov that was 745 records, 742 of them
-- the owner's own: 635 stock entries and all 107 customers (the customers' maker read from the audit
-- log, which has carried the actor on every insert since 0001).
--
-- The review exists so somebody who may vouch looks at what somebody who may not has done (0029's
-- `records.confirm`). Someone who may confirm vouches by making the record; sending it back to them
-- is a form to fill in, not a check. So the queue is now: what was made by somebody who may NOT
-- confirm (or by the system, which nobody vouched for), each row naming who made it.
--
-- Read, not written: nothing is marked confirmed here. The maker's permission is asked as it stands,
-- so a worker later made a manager stops having their old entries queued, and a manager reduced to
-- staff has theirs queued again — the queue follows who may vouch today.
--
-- Also: the queue never checked who was asking. It is security definer and took any store id; it now
-- answers only a member who may confirm.

/** has_permission, for a named member rather than the caller. Internal: not for clients. */
create or replace function public.member_may(p_store_id uuid, p_user_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null and coalesce(
    (
      select smp.granted
        from public.store_member_permissions smp
        join public.store_members m on m.store_id = smp.store_id and m.user_id = smp.user_id
       where smp.store_id = p_store_id
         and smp.user_id = p_user_id
         and smp.permission_code = p_permission
         and m.status = 'active'
    ),
    exists (
      select 1
        from public.store_members m
        join public.role_permissions rp on rp.role_code = m.role_code
       where m.store_id = p_store_id
         and m.user_id = p_user_id
         and m.status = 'active'
         and rp.permission_code = p_permission
    )
  );
$$;

revoke all on function public.member_may(uuid, uuid, text) from public, anon, authenticated;

/** A member as the shop knows them: their name, else the part of their email before the @. */
create or replace function public.member_label(p_store_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(trim(concat_ws(' ', m.first_name, m.last_name)), '')
       from public.store_members m where m.store_id = p_store_id and m.user_id = p_user_id),
    (select split_part(u.email::text, '@', 1) from auth.users u where u.id = p_user_id),
    'Someone'
  );
$$;

revoke all on function public.member_label(uuid, uuid) from public, anon, authenticated;

create or replace function public.pending_review(p_store_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.has_permission(p_store_id, 'records.confirm') then
    raise exception 'only a manager or owner can see what is waiting to be checked' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'base_unit', p.base_unit,
        'on_hand', coalesce((select sum(m.qty_delta) from public.stock_movements m
                              where m.product_id = p.id), 0),
        'created_at', p.created_at,
        'made_by', mk.actor,
        'made_by_name', case when mk.actor is null then null else public.member_label(p_store_id, mk.actor) end
      ) order by p.created_at)
      from public.products p
      left join lateral (
        select a.actor from public.audit_log a
         where a.store_id = p_store_id and a.table_name = 'products' and a.record_id = p.id and a.op = 'insert'
         order by a.at limit 1
      ) mk on true
      where p.store_id = p_store_id and p.confirmed_at is null and p.status = 'active'
        and not public.member_may(p_store_id, mk.actor, 'records.confirm')
    ), '[]'::jsonb),

    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'phone', i.phone, 'created_at', sc.created_at,
        'made_by', mk.actor,
        'made_by_name', case when mk.actor is null then null else public.member_label(p_store_id, mk.actor) end
      ) order by sc.created_at)
      from public.store_customers sc
      join public.identities i on i.id = sc.identity_id
      left join lateral (
        select a.actor from public.audit_log a
         where a.store_id = p_store_id and a.table_name = 'store_customers' and a.record_id = sc.id and a.op = 'insert'
         order by a.at limit 1
      ) mk on true
      where sc.store_id = p_store_id and sc.confirmed_at is null
        and not public.member_may(p_store_id, mk.actor, 'records.confirm')
    ), '[]'::jsonb),

    -- Sales stay out (0028): a sale is evidenced by its receipt and its money.
    'stock_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'product_id', m.product_id, 'product', p.name, 'kind', m.kind,
        'qty', m.qty_delta, 'balance_before', m.balance_before, 'balance_after', m.balance_after,
        'note', m.note,
        'created_by', m.created_by,
        'made_by_name', case when m.created_by is null then null else public.member_label(p_store_id, m.created_by) end,
        'occurred_at', m.occurred_at
      ) order by m.occurred_at)
      from public.stock_movements m
      join public.products p on p.id = m.product_id
      where m.store_id = p_store_id
        and m.kind in ('opening', 'adjustment', 'damage', 'repack_loss')
        and not exists (select 1 from public.movement_reviews r where r.movement_id = m.id)
        and m.reverses_id is null
        and m.ref_table is distinct from 'movement_reviews'
        and not public.member_may(p_store_id, m.created_by, 'records.confirm')
    ), '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.pending_review(uuid) to authenticated;

/*
 * CONFIRM MANY AT ONCE. A queue is worked down, and a person who has looked at twenty counts from one
 * worker says so once, not twenty times. Only records of this shop that are still waiting are
 * touched; anything already dealt with (by this person on another phone, or by another manager) is
 * skipped, not an error. Returns how many of each were confirmed.
 */
create or replace function public.confirm_reviews(
  p_store_id  uuid,
  p_products  uuid[] default '{}',
  p_customers uuid[] default '{}',
  p_movements uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_products  int := 0;
  v_customers int := 0;
  v_movements int := 0;
begin
  if not public.has_permission(p_store_id, 'records.confirm') then
    raise exception 'only a manager or owner can confirm what was entered' using errcode = '42501';
  end if;

  update public.products
     set confirmed_at = now(), confirmed_by = auth.uid(), amend_reason = 'confirmed'
   where store_id = p_store_id and id = any(coalesce(p_products, '{}')) and confirmed_at is null;
  get diagnostics v_products = row_count;

  update public.store_customers
     set confirmed_at = now(), confirmed_by = auth.uid(), amend_reason = 'confirmed'
   where store_id = p_store_id and id = any(coalesce(p_customers, '{}')) and confirmed_at is null;
  get diagnostics v_customers = row_count;

  if coalesce(array_length(p_movements, 1), 0) > 0 then
    if not public.has_permission(p_store_id, 'stock.count') then
      raise exception 'only a manager or owner can sign off stock' using errcode = '42501';
    end if;
    insert into public.movement_reviews (store_id, movement_id, accepted, note)
    select m.store_id, m.id, true, 'confirmed with others'
      from public.stock_movements m
     where m.store_id = p_store_id and m.id = any(p_movements)
       and m.kind in ('opening', 'adjustment', 'damage', 'repack_loss')
    on conflict (movement_id) do nothing;
    get diagnostics v_movements = row_count;
  end if;

  return jsonb_build_object('products', v_products, 'customers', v_customers, 'stock_entries', v_movements);
end;
$$;

revoke all on function public.confirm_reviews(uuid, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.confirm_reviews(uuid, uuid[], uuid[], uuid[]) to authenticated;

notify pgrst, 'reload schema';

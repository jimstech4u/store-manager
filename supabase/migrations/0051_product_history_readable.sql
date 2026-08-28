-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The stock ledger, made readable
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- `stock_movements` has been an append-only ledger since 0003 and `product_history` has been able
-- to read it since 0017 — but nothing in the app ever showed it, and what it returned was not
-- quite what a shopkeeper needs. Two things were missing.
--
-- WHO. It returned `created_by` as a uuid. "A person did this" is the whole point of an audit
-- trail; a uuid is not a person.
--
-- WHAT IT LEFT. A movement says "-2". The question actually being asked is "we had 7, we sold 2,
-- what is on the shelf now?" — and working that out by adding up every row from the beginning is
-- something the database can do once, correctly, instead of every reader doing it differently.

/*
 * Dropped and recreated, not replaced: the shape of what it returns is changing, and Postgres
 * will not let `create or replace` change a function's OUT parameters. Nothing calls it yet — it
 * has been readable since 0017 and never surfaced — so there is no caller to break.
 */
drop function if exists public.product_history(uuid, int);

create function public.product_history(
  p_product_id uuid,
  p_limit int default 100
)
returns table (
  at           timestamptz,
  kind         text,
  qty_delta    qty,
  balance      qty,
  unit_cost    unit_cost,
  ref_table    text,
  ref_id       uuid,
  note         text,
  actor        uuid,
  actor_name   text,
  reverses_id  uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with movements as (
    select
      m.occurred_at,
      m.kind,
      m.qty_delta,
      -- The running total AT that moment, oldest first, so every row can say what was left.
      sum(m.qty_delta) over (order by m.occurred_at, m.id rows unbounded preceding) as balance,
      m.unit_cost,
      m.ref_table,
      m.ref_id,
      m.note,
      m.created_by,
      m.reverses_id
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    where m.product_id = p_product_id
      and public.is_store_member(p.store_id)
  )
  select
    v.occurred_at,
    v.kind,
    v.qty_delta,
    v.balance,
    v.unit_cost,
    v.ref_table,
    v.ref_id,
    v.note,
    v.created_by,
    /*
     * The name the shop knows them by.
     *
     * `store_members` first because that is what the shop itself set — a staff login has a real
     * first and last name against it and no personal email to fall back on. The email is only for
     * an owner who signed up with their own address before any of this existed.
     */
    coalesce(
      nullif(trim(coalesce(sm.first_name, '') || ' ' || coalesce(sm.last_name, '')), ''),
      sm.login_email,
      u.email,
      'Someone'
    ),
    v.reverses_id
  from movements v
  left join public.store_members sm on sm.user_id = v.created_by
  left join auth.users u on u.id = v.created_by
  order by v.occurred_at desc, v.balance desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

grant execute on function public.product_history(uuid, int) to authenticated;

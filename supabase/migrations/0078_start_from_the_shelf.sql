-- 0078 — Starting from what is on the shelf, and saying what comes back
--
-- Two things a shop needs before it can be added to mid-sale, and one it needs to be added at all.
--
-- «many stores already have stock and lost count of deliveries and only know what they have on
--  entering»
--
-- Stock could only arrive through `record_purchase`. A shop that never recorded its deliveries had
-- to invent one to start — and an invented delivery invents a COST, which then poisons every margin
-- it touches for as long as that stock lasts. A count is a truthful opening; an invented purchase
-- is not.

-- ─── Opening stock, from what is physically there ───────────────────────────────────
--
-- `count_from_till` (0073) already opens a period and enters a figure. That is the right shape for
-- an item the shop already trades. This is for the FIRST figure — the one that says the stock
-- exists at all — and it differs in two ways that matter:
--
--   · the movement is `opening`, not `receive`. Opening stock has no supplier and no invoice, and
--     a report that cannot tell them apart will show a month's purchases that never happened.
--   · the cost is flagged ESTIMATED. It is the owner's guess on day one, and the stock page
--     already prints "estimated" against it, and the next real delivery already replaces it
--     (0062). This just gives that machinery a second entrance.

create or replace function public.open_stock_by_count(
  p_store_id   uuid,
  p_product_id uuid,
  p_qty        qty,
  p_unit_cost  money_amt default null,
  p_note       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_owner uuid;
  v_id    uuid;
begin
  /*
   * Whoever may record a sale may do this.
   *
   * Refusing would be refusing the sale — the thing the mid-sale work exists to avoid. A seller
   * saying "there are nine on the shelf" is recording a fact with their name on it, and a manager
   * reviews the item they created anyway.
   */
  if not (public.has_permission(p_store_id, 'sales.record')
          or public.has_permission(p_store_id, 'stock.count')
          or public.has_permission(p_store_id, 'products.manage')) then
    raise exception 'You do not have permission to record opening stock.'
      using errcode = 'insufficient_privilege';
  end if;

  select store_id into v_owner from public.products where id = p_product_id;
  if v_owner is null or v_owner <> p_store_id then
    raise exception 'That item does not belong to this shop.' using errcode = '22023';
  end if;

  if p_qty is null or p_qty < 0 then
    raise exception 'How many are on the shelf? Zero is an answer; nothing is not.'
      using errcode = '22023';
  end if;

  /*
   * ZERO IS A REAL ANSWER, AND IT IS A COUNT, NOT A MOVEMENT.
   *
   * `stock_movements` refuses `qty_delta = 0`, and it is right to: nothing moved. But "there are
   * none on the shelf" is still a fact somebody established, and it is exactly the fact that
   * separates a shop that has run out from a shop nobody has looked at.
   *
   * So the two are recorded by the two mechanisms that mean them. A quantity that exists becomes an
   * `opening` movement — no supplier, no invoice, distinct from a purchase so no report shows a
   * month of deliveries that never happened. The act of counting becomes a COUNT, through the same
   * period machinery the counting screen uses, whatever the number was.
   *
   * The first version wrote only the movement and the constraint refused the zero case — which was
   * the database pointing out that a count and a movement are different things.
   */
  if (p_qty > 0) then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (p_store_id, p_product_id, 'opening', p_qty, coalesce(p_unit_cost, 0),
            'products', p_product_id, now(),
            coalesce(p_note, 'Opening stock, counted on the shelf'))
    returning id into v_id;
  end if;

  -- Somebody looked, and said so. This is what makes today's count gate pass for this item, and
  -- what makes "none" different from "unknown" for everyone who reads it later.
  perform public.enter_stock_count(public.ensure_open_period(p_product_id), p_qty);

  update public.products
     set avg_unit_cost    = coalesce(p_unit_cost, avg_unit_cost),
         cost_is_estimated = true
   where id = p_product_id;

  return v_id;
end;
$fn$;

revoke all on function public.open_stock_by_count(uuid, uuid, qty, money_amt, text) from public;
grant execute on function public.open_stock_by_count(uuid, uuid, qty, money_amt, text)
  to authenticated;

-- ─── Saying a product comes back ────────────────────────────────────────────────────
--
-- The pool is created if the shop names one that does not exist yet, because at a counter "Goldberg
-- crate" is a thing the seller knows and a row in `empties_categories` is not. Same permission as
-- creating the product: whoever may add an item may say what its container is, and a manager
-- reviews the item either way.

create or replace function public.set_product_returnable(
  p_store_id         uuid,
  p_product_id       uuid,
  p_category_name    text,
  p_kind             text default 'content',
  p_qty_per_base_unit qty default 1,
  p_deposit          money_amt default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_category uuid;
  v_owner    uuid;
begin
  if not (public.has_permission(p_store_id, 'products.manage')
          or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'You do not have permission to change what comes back.'
      using errcode = 'insufficient_privilege';
  end if;

  select store_id into v_owner from public.products where id = p_product_id;
  if v_owner is null or v_owner <> p_store_id then
    raise exception 'That item does not belong to this shop.' using errcode = '22023';
  end if;

  if coalesce(btrim(p_category_name), '') = '' then
    raise exception 'What comes back? Give the pool a name.' using errcode = '22023';
  end if;

  if p_kind not in ('content', 'container') then
    raise exception 'A returnable is either a content or a container.' using errcode = '22023';
  end if;

  -- The shop's own word for it, reused when it already has one. Matched case-insensitively for the
  -- same reason `quick_add_sellable` does: "NBL crate" and "NBL Crate" are one pool to a shop.
  select id into v_category
    from public.empties_categories
   where store_id = p_store_id and lower(name) = lower(btrim(p_category_name));

  if v_category is null then
    insert into public.empties_categories (store_id, name, kind, deposit)
    values (p_store_id, btrim(p_category_name), p_kind, coalesce(p_deposit, 0))
    returning id into v_category;
  end if;

  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit)
  values (p_product_id, v_category,
          -- A container's count cannot be derived from quantity — whether the crate physically left
          -- is declared at the till — so it is null here by design, not by omission.
          case when p_kind = 'content' then coalesce(p_qty_per_base_unit, 1) end)
  on conflict (product_id, empties_category_id) do update
     set qty_per_base_unit = excluded.qty_per_base_unit;

  return v_category;
end;
$fn$;

revoke all on function
  public.set_product_returnable(uuid, uuid, text, text, qty, money_amt) from public;
grant execute on function
  public.set_product_returnable(uuid, uuid, text, text, qty, money_amt) to authenticated;

-- ─── The pools a shop already has, for the form to offer ────────────────────────────

create or replace function public.store_empties_categories(p_store_id uuid)
returns table (id uuid, name text, kind text, deposit money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ec.id, ec.name, ec.kind, ec.deposit
    from public.empties_categories ec
   where ec.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by ec.name;
$fn$;

revoke all on function public.store_empties_categories(uuid) from public;
grant execute on function public.store_empties_categories(uuid) to authenticated;

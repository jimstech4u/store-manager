-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A sale never stops for paperwork
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The counter is the one place in a shop where waiting costs money, and it is exactly where the
-- system asks the most: this customer is not on file, this item has never been entered, this stock
-- has not been counted today. Every one of those is a real question, and every one of them, asked
-- as a blocking one, ends the same way — the seller writes the sale on paper and the ledger is
-- wrong for the rest of the day.
--
-- So the rule is: LET THE SALE THROUGH, RECORD WHAT WAS ACTUALLY DONE, AND ASK AFTERWARDS. Two
-- things make that safe rather than merely convenient:
--
--   WHOEVER MAY SELL MAY CREATE. A seller can add a product or a customer mid-receipt. What they
--   cannot do is vouch for it — `records.confirm` is a separate permission held by owners and
--   managers — so the record exists, the sale is correct, and somebody senior signs it off later.
--   That distinction already exists (0029) and was learned the hard way: reusing "may create" to
--   mean "may vouch" made the review queue a silent no-op.
--
--   AND THE COUNT COMES WHEN THE ITEM DOES. Counting every product before trading is possible in a
--   kiosk and impossible in a distributor's warehouse — and pointless, because most of the
--   catalogue will not be touched today. So nothing is counted up front. The first time an item is
--   sold on a given day, the seller says what is on the shelf, and from then on that item's day is
--   open and the till stops asking.

-- ─── Adding something sellable, mid-receipt ─────────────────────────────────────────

/**
 * The smallest thing that can be sold: a name, a unit, a price.
 *
 * `quick_add_product` already did this and does it on the one-pack-per-product model the units
 * work replaced, so it would create something the sell screen cannot price. This is the same idea
 * against `product_units`, and it is deliberately the MINIMUM — a seller mid-receipt has a customer
 * waiting and should be asked for three things, not eleven. The rest is filled in later, on the
 * item's own screen, by somebody not standing at a counter.
 *
 * PROVISIONAL UNLESS THE CALLER MAY VOUCH. Created by a manager it is confirmed at once; created by
 * a seller it lands in the review queue, visibly unconfirmed, while the sale it was created for
 * goes through.
 */
create or replace function public.quick_add_sellable(
  p_store_id    uuid,
  p_name        text,
  p_unit_name   text,
  p_unit_plural text default null,
  p_price       money_amt default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_product   uuid;
  v_unit      uuid;
  v_confirmed boolean := public.has_permission(p_store_id, 'records.confirm');
begin
  if not (v_confirmed
          or public.has_permission(p_store_id, 'products.manage')
          or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'You do not have permission to add what this shop sells.'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give it a name.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_unit_name), '') = '' then
    raise exception 'Say what it is sold in.' using errcode = 'check_violation';
  end if;

  -- The shop's word for it, reused when it already has one.
  select id into v_unit
    from public.store_units
   where store_id = p_store_id and lower(name) = lower(btrim(p_unit_name));

  if v_unit is null then
    insert into public.store_units (store_id, name, plural)
    values (p_store_id, btrim(p_unit_name),
            coalesce(nullif(btrim(p_unit_plural), ''), btrim(p_unit_name)))
    returning id into v_unit;
  end if;

  insert into public.products (store_id, name, base_unit, confirmed_at, confirmed_by)
  values (p_store_id, btrim(p_name), 'piece',
          case when v_confirmed then now() end,
          case when v_confirmed then auth.uid() end)
  returning id into v_product;

  /*
   * One unit, sold, worth one base unit.
   *
   * It is the measuring unit by definition — the only one — so it is measured against nothing and
   * every later unit will be stated in terms of it.
   */
  insert into public.product_units (
    product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price, sort_order
  )
  values (v_product, v_unit, 1, true, true, p_price, 0);

  return v_product;
end;
$fn$;

grant execute on function public.quick_add_sellable(uuid, text, text, text, money_amt) to authenticated;

-- ─── Has this been counted today? ───────────────────────────────────────────────────

/**
 * Whether an item still owes the shop a count before it may be sold today.
 *
 * True when nothing has counted it since the day began. A period that is already open counts as
 * answered — it was opened by somebody entering a figure — so the till asks once per item per day
 * and then leaves that seller alone.
 *
 * DELIBERATELY PER ITEM, NOT PER SHOP. Counting a whole catalogue before trading is impossible at
 * any real size and mostly wasted, because most of it will not be touched. The item being sold is
 * exactly the item worth counting, and the moment it is first sold is exactly when somebody is
 * standing in front of it.
 */
create or replace function public.needs_count_today(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select not exists (
    select 1
      from public.stock_periods sp
      join public.products p on p.id = sp.product_id
     where sp.product_id = p_product_id
       and public.is_store_member(p.store_id)
       and (
         sp.status = 'open'
         or (sp.status = 'closed' and sp.period_end >= date_trunc('day', now()))
       )
  );
$fn$;

grant execute on function public.needs_count_today(uuid) to authenticated;

/**
 * The same question for a whole receipt, in one request.
 *
 * A seller adds several items to one order and the till must not make a round trip per line.
 */
create or replace function public.which_need_count(p_product_ids uuid[])
returns table (product_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select id
    from unnest(p_product_ids) as id
   where public.needs_count_today(id);
$fn$;

grant execute on function public.which_need_count(uuid[]) to authenticated;

/**
 * Say what is on the shelf, from the till, and open the item's day.
 *
 * The same two steps the counting screen takes — open a period, enter the figure — put behind one
 * call so the sell screen can do it without leaving the receipt. `p_counted` is in BASE units;
 * the till converts from whatever the shop sells in, exactly as the counting screen does.
 *
 * Anyone who may record a sale may do this. Refusing would be refusing the sale, which is the
 * thing this whole migration exists to avoid — and a count entered by a seller is still a count,
 * with their name on it and a variance somebody can review.
 */
create or replace function public.count_from_till(
  p_product_id uuid,
  p_counted    qty
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store_id uuid;
  v_period   uuid;
begin
  select store_id into v_store_id from public.products where id = p_product_id;
  if v_store_id is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;

  if not (public.has_permission(v_store_id, 'sales.record')
          or public.has_permission(v_store_id, 'stock.count')) then
    raise exception 'You do not have permission to record what is on the shelf.'
      using errcode = 'insufficient_privilege';
  end if;

  v_period := public.ensure_open_period(p_product_id);
  perform public.enter_stock_count(v_period, p_counted);

  return v_period;
end;
$fn$;

grant execute on function public.count_from_till(uuid, qty) to authenticated;

-- =====================================================================================
-- 0009 — Whole-naira money, and the below-cost alert
--
-- Two corrections from the domain expert:
--
-- 1. Nigerian trade is in WHOLE NAIRA. Kobo is not used in practice, so an input that asks for
--    decimals is asking a question the seller does not think in — and a receipt showing
--    "₦1,900.00" reads as a foreign object next to how the price was actually spoken.
--
--    Storage stays numeric(18,2): the extra precision costs nothing, and derived values
--    (average cost, allocated delivery fees) genuinely need it. What changes is the ENTRY and
--    DISPLAY contract, which stores now declare, so the UI never has to guess.
--
-- 2. The seller may set ANY price, including below cost — that discretion is deliberate and
--    already core to the design. But an accidental below-cost price should be caught at the
--    moment it is typed. The system knows landed cost; it should say so, and then get out of
--    the way. Alert, never block.
-- =====================================================================================

alter table public.stores
  add column if not exists money_decimals smallint not null default 0
    check (money_decimals between 0 and 2);

comment on column public.stores.money_decimals is
  'Decimal places for money ENTRY and DISPLAY. Default 0: Nigerian trade is in whole naira. '
  'Storage remains numeric(18,2) because derived values (average cost, allocated fees) need '
  'the precision even when prices do not.';

-- ─── Below-cost alert ───────────────────────────────────────────────────────────────
--
-- Called by the UI as a price is entered. Returns what the seller needs to make an informed
-- decision — never a verdict. `is_below_cost` drives a visible warning; the seller may proceed
-- regardless, because selling below cost to move slow stock, keep a good customer, or clear
-- something near expiry is a legitimate business decision this tool has no standing to refuse.
--
-- `p_qty` and `p_price` are in ENTERED units (per pack if a pack is given), matching how
-- record_sale reads them, so the caller never has to convert.

create or replace function public.price_check(
  p_product_id uuid,
  p_qty        qty,
  p_price      money_amt default null,
  p_line_total money_amt default null,
  p_pack_id    uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_product    record;
  v_base_qty   qty;
  v_line_total money_amt;
  v_cost_total money_amt;
  v_margin     money_amt;
begin
  select p.*, s.money_decimals
    into v_product
    from public.products p
    join public.stores  s on s.id = p.store_id
   where p.id = p_product_id;

  if not found then
    raise exception 'unknown product' using errcode = '23503';
  end if;
  if not public.is_store_member(v_product.store_id) then
    raise exception 'not your store' using errcode = '42501';
  end if;

  if coalesce(p_qty, 0) <= 0 then
    raise exception 'quantity must be greater than zero' using errcode = '22023';
  end if;

  v_base_qty := public.to_base_qty(p_product_id, p_qty, p_pack_id);

  v_line_total := coalesce(p_line_total, round(p_qty * coalesce(p_price, 0), 2));
  v_cost_total := round(v_base_qty * coalesce(v_product.avg_unit_cost, 0), 2);
  v_margin     := v_line_total - v_cost_total;

  return jsonb_build_object(
    'line_total',     v_line_total,
    'cost_total',     v_cost_total,
    'margin',         v_margin,
    'margin_percent', case when v_line_total > 0
                           then round((v_margin / v_line_total) * 100, 1)
                           else null end,
    'is_below_cost',  v_margin < 0,
    -- A day-one estimate is not a fact. Saying so lets the UI soften the warning instead of
    -- asserting a loss it cannot actually stand behind.
    'cost_is_estimated', coalesce(v_product.cost_is_estimated, false),
    'money_decimals',    coalesce(v_product.money_decimals, 0),
    -- The break-even price per ENTERED unit, so the alert can be useful rather than merely
    -- alarming: "this is below cost, ₦3,400 covers it."
    'breakeven_unit_price', case when p_qty > 0
                                 then round(v_cost_total / p_qty, 2)
                                 else null end
  );
end;
$$;

grant execute on function public.price_check(uuid, qty, money_amt, money_amt, uuid) to authenticated;

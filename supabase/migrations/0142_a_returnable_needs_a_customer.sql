-- 0142 — Anything that comes back needs somebody to bring it back
--
-- «any returnable product in a receipt needs a customer»
--
-- It was assumed and never enforced. `tg_sale_line_owes_containers` (0117) meets a sale with no
-- customer and simply returns — "a walk-in owes nothing, because there is nobody to owe it" — so a
-- walk-in leaving with ten crates of Goldberg settled cleanly and the crates vanished from every
-- ledger. The yard went down by ten and nothing, anywhere, said who had them.
--
-- The right answer to "nobody to owe it" is not to record nothing; it is to refuse the sale until
-- somebody is named. The till says so before the button (a condition), and this is the backstop for
-- every writer that reaches `sale_lines` — settling, and a correction — so no path can skip it.
--
-- A TRIGGER, not a check inside `settle_draft_order`: that function is long, its signature has cost
-- the till a day once already (0058), and a trigger holds for writers added later too.
--
-- Safe for both writers as they stand: settling inserts the `sales` row with its customer before
-- any line, and `amend_sale` (0131) attaches the customer before it re-inserts lines.

create or replace function public.tg_returnable_needs_a_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_customer uuid;
  v_name     text;
begin
  if new.sale_unit_id is null or coalesce(new.entered_qty, 0) <= 0 then
    return new;
  end if;

  select su.plural into v_name
    from public.product_units pu
    join public.store_units su on su.id = pu.store_unit_id
   where pu.id = new.sale_unit_id and pu.is_returnable;

  if not found then
    return new;
  end if;

  select s.store_customer_id into v_customer from public.sales s where s.id = new.sale_id;

  if v_customer is null then
    raise exception
      'The % on this sale come back empty, so it needs a customer. Add who is taking them.',
      lower(v_name)
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

drop trigger if exists returnable_needs_a_customer on public.sale_lines;
create trigger returnable_needs_a_customer
  before insert on public.sale_lines
  for each row execute function public.tg_returnable_needs_a_customer();

comment on function public.tg_returnable_needs_a_customer() is
  'Refuses a sale line in a shape that comes back when the sale has no customer. Without it a '
  'walk-in left with crates and no ledger anywhere recorded who had them.';

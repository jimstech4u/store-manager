-- 0221 - Nothing sells without a price
--
-- "Some product do not have price so we should block that as we did for count."
--
-- The till now stops a sale whose item has no price and pushes a page to set one (the price gate,
-- beside the count gate). This is the server's half of the same rule, so a till running old code,
-- or a second till racing the first, cannot post a line at N0.
--
-- Before this was written, every sale line ever recorded was checked: none has a price of N0 or
-- less. So the rule states what the shop already does; it refuses nothing it has done.
--
-- Like the count rule (0144), only a sale created in THIS transaction is judged. A correction to
-- an old receipt re-writes lines that were priced when they were sold, and must stay possible.

create or replace function public.tg_sale_line_needs_a_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_new  boolean;
  v_name text;
begin
  select s.created_at = now() into v_new from public.sales s where s.id = new.sale_id;
  if not coalesce(v_new, false) then
    return new;
  end if;

  if coalesce(new.unit_price, 0) > 0 then
    return new;
  end if;

  select name into v_name from public.products where id = new.product_id;
  raise exception '% has no price yet. Set its price before selling it.',
    coalesce(v_name, 'An item on this sale')
    using errcode = '22023';
end;
$fn$;

drop trigger if exists sale_line_needs_a_price on public.sale_lines;
create trigger sale_line_needs_a_price
  before insert on public.sale_lines
  for each row execute function public.tg_sale_line_needs_a_price();

comment on function public.tg_sale_line_needs_a_price() is
  'Refuses a line priced at N0 or less on a sale created in this transaction. Corrections to older '
  'sales are not affected.';

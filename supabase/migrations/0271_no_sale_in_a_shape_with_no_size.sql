-- 0271 - Nothing is sold in a shape that is the same size as another by accident, and two names put right
--
-- Zetar's Piece stands alone at the size of its Pack (0270 stops new ones). Until the owner decides how
-- Zetar is re-based on pieces (12 to a pack), a piece sold now would take a whole pack off the shelf at
-- whatever price was typed. So a sale line in such a shape is refused, with what to do about it.
--
-- And, with the owner's word (4 Nov): Malta Guinness Can's 24-can shape was named "Can" and its single
-- can "Piece", so a receipt read "1 Can" for 24 cans. The names are put right; sizes, prices and every
-- past quantity stay as they are, so old receipts now read "1 Pack", which is what they meant. "m/gns"
-- is what the shop writes for it.

create function public.tg_sale_line_shape_has_a_size()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_unit text;
  v_twin text;
  v_item text;
begin
  if new.sale_unit_id is null then
    return new;
  end if;
  select su.name, tw.name, p.name into v_unit, v_twin, v_item
    from public.product_units pu
    join public.store_units su on su.id = pu.store_unit_id
    join public.products p on p.id = pu.product_id
    join lateral (
      select su2.name from public.product_units t
        join public.store_units su2 on su2.id = t.store_unit_id
       where t.product_id = pu.product_id and t.id <> pu.id
         and t.defined_against_id is null and t.base_qty = pu.base_qty
         -- Only the ACCIDENTAL one is stopped: the original (earliest, or the priced one) still sells.
         and (t.created_at, (t.sell_price is null), t.id) < (pu.created_at, (pu.sell_price is null), pu.id)
       order by t.created_at
       limit 1
    ) tw on true
   where pu.id = new.sale_unit_id and pu.defined_against_id is null;
  if v_twin is not null then
    raise exception '%''s % is set up as the same size as its %, so it would take the wrong stock. Fix its shapes before selling it that way.',
      v_item, lower(v_unit), lower(v_twin)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create trigger sale_line_shape_has_a_size before insert on public.sale_lines
  for each row execute function public.tg_sale_line_shape_has_a_size();

-- Malta Guinness Can: the 24 is a Pack, the one is a Can. Pack first, so the pair is never the same name.
update public.product_units pu
   set store_unit_id = (select id from public.store_units where store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and name = 'Pack')
  from public.products p
 where p.id = pu.product_id and p.store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and p.name = 'Malta Guinness Can (330mL)' and pu.base_qty = 24
   and pu.store_unit_id = (select id from public.store_units where store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and name = 'Can');
update public.product_units pu
   set store_unit_id = (select id from public.store_units where store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and name = 'Can')
  from public.products p
 where p.id = pu.product_id and p.store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and p.name = 'Malta Guinness Can (330mL)' and pu.base_qty = 1
   and pu.store_unit_id = (select id from public.store_units where store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and name = 'Piece');

insert into public.product_aliases (store_id, phrase, product_id)
select p.store_id, public.name_phrase('m/gns'), p.id from public.products p
 where p.store_id = '7138327c-c81c-4486-a97c-92207b48b64e' and p.name = 'Malta Guinness Can (330mL)'
on conflict do nothing;

notify pgrst, 'reload schema';

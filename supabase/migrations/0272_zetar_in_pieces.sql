-- 0272 - Zetar is counted in pieces, 12 to a pack
--
-- With the owner's explicit yes (4 Nov), and the one exception to the append-only rule it needs.
-- Zetar's base unit was a pack in all but name: Pack held "1 piece", and a Piece added later stood at the
-- same size, so a piece sold at the pack's price and took a pack. The shop sells pieces, 12 to a pack,
-- and stock is counted in whole pieces. Every Zetar quantity recorded in base units is multiplied by 12
-- and every cost per base unit divided by 12, so history, reports and stock read the same facts in pieces:
-- 94 movements, 62 receipt lines, 3 delivery lines, 6 batches and the open count. Receipts still read
-- "5 Packs", because they print the shape as entered; an open order on the till keeps its packs.
--
-- Every row is copied to _rebase_backup_0272 before it is touched. Triggers stand down only inside this
-- transaction (append-only, the audit trail, the shape history guard), and only Zetar's rows change.

create table if not exists public._rebase_backup_0272 (
  tbl      text not null,
  row      jsonb not null,
  saved_at timestamptz not null default now()
);
alter table public._rebase_backup_0272 enable row level security;

insert into public._rebase_backup_0272 (tbl, row)
select 'stock_movements', to_jsonb(m) from public.stock_movements m where m.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'sale_lines', to_jsonb(l) from public.sale_lines l where l.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'purchase_lines', to_jsonb(l) from public.purchase_lines l where l.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'stock_layers', to_jsonb(l) from public.stock_layers l where l.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'stock_periods', to_jsonb(s) from public.stock_periods s where s.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'product_units', to_jsonb(u) from public.product_units u where u.product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59'
union all select 'products', to_jsonb(p) from public.products p where p.id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

set local session_replication_role = replica;

update public.stock_movements
   set qty_delta = qty_delta * 12, unit_cost = unit_cost / 12,
       balance_before = balance_before * 12, balance_after = balance_after * 12
 where product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

update public.sale_lines
   set base_qty = base_qty * 12, unit_cost_at_sale = unit_cost_at_sale / 12
 where product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

-- The cost as entered stays per pack; the landed cost is per base unit.
update public.purchase_lines
   set base_qty = base_qty * 12, unit_cost_landed = unit_cost_landed / 12
 where product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

update public.stock_layers
   set qty_base = qty_base * 12, remaining_base = remaining_base * 12, unit_cost = unit_cost / 12
 where product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

update public.stock_periods
   set opening_qty = opening_qty * 12, receiving_qty = receiving_qty * 12, sales_qty = sales_qty * 12,
       damaged_qty = damaged_qty * 12, other_qty = other_qty * 12,
       expected_at_count = expected_at_count * 12, actual_closing_qty = actual_closing_qty * 12
 where product_id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

update public.products
   set avg_unit_cost = avg_unit_cost / 12, low_stock_threshold = low_stock_threshold * 12
 where id = 'c9e6b438-c415-43e1-89d5-653a594b8a59';

-- A pack is 12 pieces; the piece is the unit everything is counted in.
update public.product_units
   set defined_against_id = '02844541-0292-46a6-bac6-eec4dc34a9b6', defined_qty = 12, base_qty = 12
 where id = '6288a03a-fe0d-490f-8d9e-ee43f0ba79f3';

reset session_replication_role;

select public.sync_sale_units('c9e6b438-c415-43e1-89d5-653a594b8a59');

notify pgrst, 'reload schema';

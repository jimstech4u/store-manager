-- 0226 - The tables other tills never heard
--
-- The audit (TRACKER A1) found nine tables the app writes that were not in the realtime
-- publication, so a change on one till never reached another: a deposit held, a count difference
-- explained, a supplier paid or its crates returned, the yard counted, a shape renamed, the shop's
-- settings, an item's own low-stock level, a sale's named charges. Added, each mapped in
-- `live-shop.ts` to the screens that show it.

do $pub$
declare t text;
begin
  foreach t in array array['deposit_holdings', 'variance_resolutions', 'supplier_payments',
                           'supplier_empties', 'empties_counts', 'store_units', 'store_settings',
                           'product_low_stock_levels', 'sale_charges']
  loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$pub$;

-- 0273 - Open orders are heard on every device
--
-- "When we are using multiple devices and open one from the background, we have to close and reopen
-- to see changes like draft order changes." The till's open orders were never in the realtime
-- publication, so an order built, changed or settled on one device reached no other. Added, and
-- mapped in `live-shop.ts` to the till (`sell_flow`) and the online orders (`online_orders`).

do $pub$
declare t text;
begin
  foreach t in array array['draft_orders', 'draft_order_lines']
  loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$pub$;

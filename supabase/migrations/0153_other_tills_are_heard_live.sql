-- 0153 — What another till records reaches this one as it happens
--
-- «other tills' changes arrive when you return to a page. Truly live updates (academix-web uses
--  realtime subscriptions) would be a further step»
--
-- A shop with two tills and a manager's phone was three separate pictures of one shop. A sale on the
-- front till moved the stock, the customer's balance and their containers — and the back till found
-- out only when somebody left a screen and came back to it.
--
-- These tables are added to Supabase's realtime publication. The app subscribes to its own shop's
-- rows (filtered by `store_id`); realtime applies row security to every subscriber, so a member only
-- ever hears about rows they could already read. What it receives is used only as a SIGNAL — "the
-- sales changed", "the stock moved" — to re-read the figures from the server, never trusted as data
-- in itself.
--
-- Only tables that carry `store_id` can be filtered to one shop; `product_units` does not, and a shape
-- edited on another device still arrives on the next read.

do $publish$
declare
  t text;
begin
  foreach t in array array[
    'sales', 'payments', 'customer_charges',
    'stock_movements', 'stock_periods', 'stock_count_edits',
    'customer_empties', 'customer_deposits',
    'products', 'store_customers', 'expenses'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$publish$;

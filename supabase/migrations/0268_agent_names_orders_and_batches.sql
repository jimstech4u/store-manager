-- 0268 - The agent names an order and a batch in words
--
-- Online orders are accepted or declined by their draft id, and expired stock is written off by its
-- batch (`stock_layers`). A proposal reads in names, never ids: "Accept order Q6KBS for Mrs Adeola?",
-- "Write off Trophy Bottle batch, expires 12 Nov 2026". The live definition with two lines added.

CREATE OR REPLACE FUNCTION public.agent_names(p_store_id uuid, p_ids uuid[])
 RETURNS TABLE(id uuid, label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select x.id, x.label from (
    select p.id, p.name as label from public.products p where p.store_id = p_store_id and p.id = any(p_ids)
    union all
    select c.id, c.display_name from public.store_customers c where c.store_id = p_store_id and c.id = any(p_ids)
    union all
    select s.id, s.name from public.suppliers s where s.store_id = p_store_id and s.id = any(p_ids)
    union all
    select g.id, g.name from public.product_categories g where g.store_id = p_store_id and g.id = any(p_ids)
    union all
    select b.id, b.bank_name || ' ' || coalesce(b.account_name, '') from public.store_bank_accounts b
     where b.store_id = p_store_id and b.id = any(p_ids)
    union all
    select u.id, pr.name || ', by the ' || lower(su.name) from public.product_units u
      join public.products pr on pr.id = u.product_id
      join public.store_units su on su.id = u.store_unit_id
     where pr.store_id = p_store_id and u.id = any(p_ids)
    union all
    select s.id, 'receipt #' || upper(left(s.id::text, 8)) from public.sales s where s.store_id = p_store_id and s.id = any(p_ids)
    union all
    select o.id, 'order ' || o.code || coalesce(' for ' || o.label, '') from public.draft_orders o
     where o.store_id = p_store_id and o.id = any(p_ids)
    union all
    select l.id, pr.name || ' batch' || coalesce(', expires ' || to_char(l.expires_on, 'DD Mon YYYY'), '')
      from public.stock_layers l join public.products pr on pr.id = l.product_id
     where l.store_id = p_store_id and l.id = any(p_ids)
  ) x
  where public.is_store_member(p_store_id);
$function$;

notify pgrst, 'reload schema';

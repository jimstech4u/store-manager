-- 0227 - The review queue does not review its own reversals
--
-- "Wrong" on a stock entry (review_movement, accepted = false) writes a reversing adjustment. That
-- reversal is itself an 'adjustment' with no review, so it came straight back into the queue as
-- another entry to check — and marking it wrong would reverse the reversal. Excluded: a movement
-- that reverses another, or that the review itself wrote, is the answer to a review, not a question.

CREATE OR REPLACE FUNCTION public.pending_review(p_store_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'base_unit', p.base_unit,
        'on_hand', coalesce((select sum(m.qty_delta) from public.stock_movements m
                              where m.product_id = p.id), 0),
        'created_at', p.created_at
      ) order by p.created_at)
      from public.products p
      where p.store_id = p_store_id and p.confirmed_at is null and p.status = 'active'
    ), '[]'::jsonb),

    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'phone', i.phone, 'created_at', sc.created_at
      ) order by sc.created_at)
      from public.store_customers sc
      join public.identities i on i.id = sc.identity_id
      where sc.store_id = p_store_id and sc.confirmed_at is null
    ), '[]'::jsonb),

    -- Stock claimed but not yet signed off. Sales are excluded: a sale is evidenced by its
    -- receipt and its money, and putting every one of them in a queue would drown the entries
    -- that genuinely need a second pair of eyes.
    'stock_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'product_id', m.product_id, 'product', p.name, 'kind', m.kind,
        'qty', m.qty_delta, 'balance_before', m.balance_before, 'balance_after', m.balance_after,
        'created_by', m.created_by, 'occurred_at', m.occurred_at
      ) order by m.occurred_at)
      from public.stock_movements m
      join public.products p on p.id = m.product_id
      where m.store_id = p_store_id
        and m.kind in ('opening', 'adjustment', 'damage', 'repack_loss')
        and not exists (select 1 from public.movement_reviews r where r.movement_id = m.id)
        -- 0227: a reversal written by "Wrong" on this page is not a new entry to review.
        and m.reverses_id is null
        and m.ref_table is distinct from 'movement_reviews'
    ), '[]'::jsonb)
  );
$function$;

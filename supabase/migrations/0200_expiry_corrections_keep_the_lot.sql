-- 0200 — Correcting a date does not rewrite the stock lot
--
-- An expiry date belongs to a FIFO layer, not to the product. The product editor can therefore
-- repair a missed or mistyped date without changing the received quantity, the remaining quantity,
-- cost, or the order in which stock is consumed. The ordinary audit trigger on stock_layers keeps
-- the old and new dates; this explicit row supplies the human reason as well.

create or replace function public.set_stock_layer_expiry(
  p_layer_id   uuid,
  p_expires_on date,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_layer public.stock_layers%rowtype;
begin
  select * into v_layer from public.stock_layers where id = p_layer_id for update;
  if not found then
    raise exception 'That stock lot no longer exists.' using errcode = '23503';
  end if;
  if not public.has_permission(v_layer.store_id, 'stock.adjust') then
    raise exception 'You do not have permission to correct an expiry date.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this expiry date is being corrected.' using errcode = '22023';
  end if;

  if v_layer.expires_on is not distinct from p_expires_on then
    return;
  end if;

  update public.stock_layers
     set expires_on = p_expires_on
   where id = p_layer_id;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (
    v_layer.store_id,
    'stock_layers',
    p_layer_id,
    'update',
    jsonb_build_object('expires_on', v_layer.expires_on),
    jsonb_build_object('expires_on', p_expires_on),
    trim(p_reason)
  );
end;
$fn$;

revoke all on function public.set_stock_layer_expiry(uuid, date, text) from public;
grant execute on function public.set_stock_layer_expiry(uuid, date, text) to authenticated;

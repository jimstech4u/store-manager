-- 0251 - Ashabi Global Resources: every count removed; the count gate relaxed to Monday and Sunday
--
-- "Remove all the counted records in the database — I permit this. The stock is still what was
-- entered initially minus what was sold, so the count records are just wrong in some places. Then
-- pick relaxed (every Monday, every Sunday)." (The owner, 1 Oct 2026.)
--
-- Counts never moved stock here: of the store's 20 adjustment movements, 19 are receipt corrections
-- and one removed the ZZ Probe test item (it points at that item's variance resolution, so the ZZ
-- Probe's period stays as the record that explains it). Everything else counted goes: the periods,
-- their variance resolutions and their count edits (the last two are append-only; their guard is
-- lifted for this delete alone and put straight back). An item with no period has one opened from
-- the ledger itself (`ensure_open_period`: opening + deliveries - sales + corrections) the next time
-- it is counted or sold, which is exactly "initial minus sold".

do $$
declare
  v_store constant uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_zz    constant uuid := '89b618ac-1b47-4f1c-a1ea-7228474d01f2';
begin
  alter table public.variance_resolutions disable trigger no_mutation;
  alter table public.stock_count_edits disable trigger no_mutation;

  delete from public.stock_periods
   where store_id = v_store
     and product_id <> v_zz;

  alter table public.variance_resolutions enable trigger no_mutation;
  alter table public.stock_count_edits enable trigger no_mutation;

  insert into public.store_settings (store_id, count_gate_mode, count_gate_days)
  values (v_store, 'relaxed', '{1,7}')
  on conflict (store_id) do update
     set count_gate_mode = 'relaxed', count_gate_days = '{1,7}', updated_at = now();
end;
$$;

-- 0256 - receipt_detail, back as a plain pass-through to sale_detail
--
-- 0254 dropped `receipt_detail`, and the app still deployed then (bc7cd2f) read every receipt
-- through it — so live receipts failed until the new build (which reads `sale_detail`) arrived.
-- Restored as exactly `sale_detail`, so any phone on the older build reads its receipts. Applied
-- live on 8 Oct 2026; nothing in the current app calls it, and it can go once no phone runs bc7cd2f.

create or replace function public.receipt_detail(p_sale_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $f$ select public.sale_detail(p_sale_id); $f$;
revoke all on function public.receipt_detail(uuid) from public, anon;
grant execute on function public.receipt_detail(uuid) to authenticated;

notify pgrst, 'reload schema';

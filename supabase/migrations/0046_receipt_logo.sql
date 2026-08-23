-- =====================================================================================
-- 0046 — A shop's logo on its receipts
--
-- Stored as a path into the media bucket, like every other image, so the database never holds
-- bytes and the file is served from the CDN.
--
-- `receipt_logo_width_pct` exists because a thermal receipt is 40mm or 80mm wide and a logo that
-- looks right on one is unusable on the other. A percentage of the paper width survives a shop
-- changing printers, which a pixel size would not.
-- =====================================================================================

alter table public.store_settings
  add column if not exists receipt_logo_path text,
  add column if not exists receipt_logo_width_pct int not null default 60
    check (receipt_logo_width_pct between 20 and 100);

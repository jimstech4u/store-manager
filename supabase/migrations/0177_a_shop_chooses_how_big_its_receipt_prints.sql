-- =====================================================================================
-- 0177 — A shop chooses how big its receipt prints
--
-- The receipt goes to the printer app as ESC/POS text now, in the printer's own built-in font,
-- because a 203dpi head prints its ROM glyphs sharply and a browser-rendered bitmap thinly. That
-- font comes in sizes, and which one reads best is a judgement about the shop — how far the customer
-- stands, how good the light is, how much a roll costs — not something to decide for them.
--
-- The app's own printed reference lists them:
--
--     ss    small                 sl    large
--     ssh   small, double height  slh   large, double height
--     ssw   small, double width   slw   large, double width
--     sshw  small, double both    slhw  large, double both
--
-- On a 576-dot head the small font is 9 dots wide and the large one 12, so the choice is really a
-- choice of how many characters fit on a line: 64 at `ss`, 48 at `sl`, 32 at either double-width.
-- Double WIDTH is what makes it readable across a counter; double HEIGHT also makes it readable and
-- costs twice the paper, which is a real cost on a roll.
--
-- Per device, beside the rest of the printer setting, because the counter and the back office print
-- for different readers.
-- =====================================================================================

alter table public.store_printers
  add column if not exists text_size text not null default 'sshw';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'store_printers_text_size_known'
  ) then
    alter table public.store_printers
      add constraint store_printers_text_size_known
      check (text_size in ('ss', 'ssh', 'ssw', 'sshw', 'sl', 'slh', 'slw', 'slhw'));
  end if;
end $$;

comment on column public.store_printers.text_size is
  'Which of the printer''s built-in letter sizes the body of a receipt prints at. See the app''s ESC/POS tag list; double-width sizes give 32 characters a line on a 576-dot head.';


-- Dropped and restated: the return type gains a column, which `create or replace` cannot do.
drop function if exists public.my_printers(uuid);

create or replace function public.my_printers(p_store_id uuid)
returns table (
  device_id    text,
  device_label text,
  kind         text,
  printer_name text,
  width_mm     numeric,
  usb_vendor_id integer,
  usb_product_id integer,
  bt_device_id text,
  text_size    text,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.device_id, sp.device_label, sp.kind, sp.printer_name, sp.width_mm,
         sp.usb_vendor_id, sp.usb_product_id, sp.bt_device_id, sp.text_size, sp.updated_at
    from public.store_printers sp
   where sp.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by sp.updated_at desc;
$$;

grant execute on function public.my_printers(uuid) to authenticated;


/*
 * THE NINE-ARGUMENT VERSION IS DROPPED FIRST, and I got this wrong before fixing it.
 *
 * The comment that stood here said `create or replace` was enough because the argument list only
 * grows at the end. That is not how Postgres works, and 0170 already recorded the same lesson:
 * adding a parameter with a default does not REPLACE a function, it OVERLOADS it. Both survived,
 * every existing nine-argument call matched both, and Postgres refuses an ambiguous call — so
 * saving a printer would have failed for every device already set up.
 *
 * Caught by listing the signatures after applying, which is the only thing that catches it. Reading
 * the migration does not.
 */
drop function if exists public.set_my_printer(uuid, text, text, text, text, numeric, integer, integer, text);

create or replace function public.set_my_printer(
  p_store_id      uuid,
  p_device_id     text,
  p_kind          text,
  p_device_label  text default null,
  p_printer_name  text default null,
  p_width_mm      numeric default 80,
  p_usb_vendor_id integer default null,
  p_usb_product_id integer default null,
  p_bt_device_id  text default null,
  p_text_size     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not public.is_store_member(p_store_id) then
    raise exception 'that shop is not yours' using errcode = '42501';
  end if;
  if coalesce(btrim(p_device_id), '') = '' then
    raise exception 'a device has to say which device it is' using errcode = '22023';
  end if;

  insert into public.store_printers (
    store_id, device_id, device_label, kind, printer_name, width_mm,
    usb_vendor_id, usb_product_id, bt_device_id, text_size
  )
  values (
    p_store_id, btrim(p_device_id), nullif(btrim(coalesce(p_device_label, '')), ''), p_kind,
    nullif(btrim(coalesce(p_printer_name, '')), ''), coalesce(p_width_mm, 80),
    p_usb_vendor_id, p_usb_product_id, nullif(btrim(coalesce(p_bt_device_id, '')), ''),
    coalesce(nullif(btrim(coalesce(p_text_size, '')), ''), 'sshw')
  )
  on conflict (store_id, device_id) do update
    set kind           = excluded.kind,
        -- A label the shop already gave this device is kept when the printer is changed: renaming
        -- the counter is a separate decision from re-pairing it.
        device_label   = coalesce(excluded.device_label, public.store_printers.device_label),
        printer_name   = excluded.printer_name,
        width_mm       = excluded.width_mm,
        usb_vendor_id  = excluded.usb_vendor_id,
        usb_product_id = excluded.usb_product_id,
        bt_device_id   = excluded.bt_device_id,
        -- And the size is kept when the caller did not mention one, for the same reason: changing
        -- the printer is not a decision about how big the letters are.
        text_size      = coalesce(nullif(btrim(coalesce(p_text_size, '')), ''),
                                  public.store_printers.text_size),
        updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.set_my_printer(uuid, text, text, text, text, numeric, integer, integer, text, text) to authenticated;

-- =====================================================================================
-- 0181 — A receipt layout the shop sets, and measures
--
-- 0177 gave a shop four fixed sizes for the whole body of a receipt. A printed one showed why that
-- is not enough: the items and the totals came out well, and the date, the receipt number, the
-- customer's name and the bank details were too small to read. Those are different parts of a
-- document with different readers, and one setting cannot serve them.
--
-- So every part carries its own size, and `text_size` is replaced by a `layout` object.
--
-- ── AND THE COLUMN COUNTS ARE MEASURED, NOT CALCULATED ───────────────────────────
--
-- The harder half. Lining amounts up on the right-hand edge means padding a label out to the exact
-- width of a line, and being wrong does not look like a rounding error — it WRAPS. The amount drops
-- to the next line, indented by the padding, and the receipt becomes a ladder.
--
-- 0177 calculated the widths from the head's dot pitch: 576 dots, a 9-dot small font and a 12-dot
-- large one, so 64 and 48 characters. The small font was right — a rule of 64 dashes fits the paper
-- exactly. The large one was not: every line padded to 48 wrapped, and the shop was comparing a
-- preview against a piece of paper that said something different.
--
-- There is no way to ask a printer how wide its fonts are, and these are not standard parts. So the
-- shop prints a ruler and types in what it measured. Two numbers, saved with the printer, and the
-- preview uses the same ones — which is the only thing that makes a preview worth looking at.
--
-- Per device, like the rest of the printer setting: the counter and the back office can be
-- different printers with different fonts.
-- =====================================================================================

alter table public.store_printers
  add column if not exists layout jsonb;

comment on column public.store_printers.layout is
  'Per-part letter sizes and the MEASURED characters-per-line at each base font. Null means the defaults. See src/lib/escpos-text.ts — the column counts cannot be calculated reliably and are read off a printed ruler.';

/*
 * `text_size` stays, and is not dropped.
 *
 * It shipped, so a device set up between 0177 and now has a value in it, and a shop that has not
 * opened the new screen should keep printing at the size it chose. The client seeds the whole-body
 * parts of `layout` from it when `layout` is null, so nothing changes under anybody until they
 * choose something. Dropping a column that is holding somebody's setting is how a setting silently
 * reverts.
 */

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
  layout       jsonb,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.device_id, sp.device_label, sp.kind, sp.printer_name, sp.width_mm,
         sp.usb_vendor_id, sp.usb_product_id, sp.bt_device_id, sp.text_size, sp.layout,
         sp.updated_at
    from public.store_printers sp
   where sp.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by sp.updated_at desc;
$$;

grant execute on function public.my_printers(uuid) to authenticated;


/*
 * THE TEN-ARGUMENT VERSION IS DROPPED FIRST.
 *
 * Adding a parameter with a default OVERLOADS a function rather than replacing it. Both survive,
 * every existing call matches both, and Postgres refuses an ambiguous call — so saving a printer
 * would fail for every device already set up. 0170 recorded this, 0177 walked into it anyway, and
 * the only thing that catches it is listing the signatures after applying.
 */
drop function if exists public.set_my_printer(uuid, text, text, text, text, numeric, integer, integer, text, text);

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
  p_text_size     text default null,
  p_layout        jsonb default null
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
    usb_vendor_id, usb_product_id, bt_device_id, text_size, layout
  )
  values (
    p_store_id, btrim(p_device_id), nullif(btrim(coalesce(p_device_label, '')), ''), p_kind,
    nullif(btrim(coalesce(p_printer_name, '')), ''), coalesce(p_width_mm, 80),
    p_usb_vendor_id, p_usb_product_id, nullif(btrim(coalesce(p_bt_device_id, '')), ''),
    coalesce(nullif(btrim(coalesce(p_text_size, '')), ''), 'sshw'),
    p_layout
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
        -- The size and the layout are kept when the caller did not mention them: connecting a
        -- printer is not a decision about how the receipt is set out.
        text_size      = coalesce(nullif(btrim(coalesce(p_text_size, '')), ''),
                                  public.store_printers.text_size),
        layout         = coalesce(excluded.layout, public.store_printers.layout),
        updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.set_my_printer(uuid, text, text, text, text, numeric, integer, integer, text, text, jsonb) to authenticated;

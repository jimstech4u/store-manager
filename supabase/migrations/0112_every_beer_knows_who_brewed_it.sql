-- 0112 — Every beer knows who brewed it
--
-- 0101 seeded the maker groups — Nigerian Breweries (NBL), Guinness, Trophy International, Cway —
-- and linked no product to any of them. The picker has been showing "not used yet" beside all four
-- ever since, which was true.
--
-- It stopped being cosmetic the moment empties moved onto product shapes. What a customer owes now
-- reads product by product:
--
--     (no group)   Goldberg 60cl                       129 Crates
--     (no group)   Guinness Foreign Extra Stout 60cl     8 Bottles
--
-- and the whole point of grouping is that it should read "129 NBL crates". A crate is returned to
-- whoever made it and a Goldberg crate settles a Gulder crate, which is a fact about the BREWERY,
-- so a product with no maker cannot be rolled up with anything.
--
-- WHO BREWS WHAT, in Nigeria, as of writing:
--
--   Nigerian Breweries Plc (Heineken)   Star, Gulder, Legend Extra Stout, Goldberg, Life
--                                       Continental Lager, Heineken, "33" Export, Maltina
--   Guinness Nigeria (Diageo)           Guinness Foreign Extra Stout, Malta Guinness, Harp, Dubic
--   International Breweries (AB InBev)  Trophy Lager, Hero Lager, Budweiser, Beta Malt
--
-- The third group is seeded as "Trophy International", which is the shop's own name for it rather
-- than the company's — that is the shop's to rename on the product form, and it is left as the shop
-- wrote it.
--
-- MATCHED ON THE NAME, and only where a product is in NO group already. A shop that has since said
-- otherwise is not overruled by a migration.

do $link$
declare
  v_store  uuid;
  v_group  uuid;
  v_maker  record;
  v_linked int := 0;
begin
  for v_store in select id from public.stores where status = 'active' loop

    for v_maker in
      select * from (values
        ('Nigerian Breweries (NBL)',
         array['goldberg', 'gulder', 'star lager', 'legend extra stout',
               'life continental', 'heineken', '33 export', 'maltina', 'amstel']),
        ('Guinness',
         array['guinness', 'malta guinness', 'harp', 'dubic', 'orijin']),
        ('Trophy International',
         array['trophy', 'hero lager', 'budweiser', 'beta malt', 'castle lite']),
        ('Cway',
         array['cway', 'dispenser water', 'table water', 'sachet water'])
      ) as t(group_name, matches)
    loop
      select id into v_group
        from public.product_categories
       where store_id = v_store
         and lower(name) = lower(v_maker.group_name)
         and coalesce(status, 'active') = 'active'
       limit 1;

      -- The shop may never have had this group. Nothing is created here: 0101 seeded them, and a
      -- shop that archived one meant it.
      continue when v_group is null;

      insert into public.product_category_links (product_id, category_id)
      select p.id, v_group
        from public.products p
       where p.store_id = v_store
         and exists (
           select 1 from unnest(v_maker.matches) as m
            where lower(p.name) like '%' || m || '%'
         )
         /*
          * ONLY A PRODUCT IN NO GROUP AT ALL.
          *
          * A shop that has already said who makes something has answered a question this migration
          * is only guessing at from a name. "Malta Guinness" matching both the Guinness list and
          * nothing else is fine; a product the shop has filed itself is left alone.
          */
         and not exists (
           select 1 from public.product_category_links l where l.product_id = p.id
         )
      on conflict do nothing;

      get diagnostics v_linked = row_count;
      if v_linked > 0 then
        raise notice '% : % product(s) -> %', v_store, v_linked, v_maker.group_name;
      end if;
    end loop;
  end loop;
end;
$link$;

/*
 * AND `products.category_id` FOLLOWS, because that is the one `set_product_groups` keeps as the
 * first group and several readers still show.
 *
 * The join table is the truth — a product can be in several groups — and this column is the
 * shorthand for the first of them. Leaving it null while the links exist is how a product ends up
 * grouped on one screen and ungrouped on another.
 */
update public.products p
   set category_id = (
     select l.category_id
       from public.product_category_links l
       join public.product_categories c on c.id = l.category_id
      where l.product_id = p.id
      order by c.name
      limit 1
   )
 where p.category_id is null
   and exists (select 1 from public.product_category_links l where l.product_id = p.id);

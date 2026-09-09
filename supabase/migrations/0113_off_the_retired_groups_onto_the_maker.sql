-- 0113 — Off the retired groups, onto the maker who made it
--
-- 0112 linked products in NO group to their brewer, on the reasoning that a shop which has already
-- filed something has answered a question a migration should not overrule. Correct, and it left
-- four products behind:
--
--     Gulder 60cl              Beer
--     Star Lager 60cl          Beer
--     Malta Guinness Can 33cl  Can
--     Eva Water 75cl           PET
--
-- Those groups are ARCHIVED. 0101 retired "PET", "Beer" and "Can" because they describe a container
-- or a style, not a maker — and empties go back to whoever made them, which is the entire reason a
-- shop groups anything. The products kept pointing at them, so they were "in a group" in the only
-- sense 0112 could check, while being in one the shop has already said it does not use.
--
-- The result is worse than being ungrouped: Gulder reads under "Beer", Goldberg under "Nigerian
-- Breweries (NBL)", and two crates that settle each other in real life sit in different totals.
--
-- So the test is not "is it in a group" but "is it in a group the shop still uses".

do $move$
declare
  v_store  uuid;
  v_group  uuid;
  v_maker  record;
  v_moved  int;
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
          * IN NO GROUP THE SHOP STILL USES.
          *
          * A link to an archived group does not count as an answer — the shop retired that group
          * precisely to stop using it. A product the shop has filed under a LIVE group is left
          * exactly as it is.
          */
         and not exists (
           select 1
             from public.product_category_links l
             join public.product_categories c on c.id = l.category_id
            where l.product_id = p.id
              and coalesce(c.status, 'active') = 'active'
         )
      on conflict do nothing;

      get diagnostics v_moved = row_count;
      if v_moved > 0 then
        raise notice '% moved onto %', v_moved, v_maker.group_name;
      end if;
    end loop;
  end loop;
end;
$move$;

/*
 * AND THE LINKS TO RETIRED GROUPS GO.
 *
 * Left in place they are a second answer to "who made this", and `customer_empties_owed` picks the
 * first group by name — so "Beer" would keep beating "Nigerian Breweries (NBL)" alphabetically and
 * nothing visible would change. Removed only where a live group has taken over, so a product whose
 * only group is archived keeps it rather than losing its filing altogether.
 */
delete from public.product_category_links l
 using public.product_categories c
 where c.id = l.category_id
   and coalesce(c.status, 'active') <> 'active'
   and exists (
     select 1
       from public.product_category_links l2
       join public.product_categories c2 on c2.id = l2.category_id
      where l2.product_id = l.product_id
        and coalesce(c2.status, 'active') = 'active'
   );

-- `products.category_id` is the shorthand for the first LIVE group, and it was pointing at retired
-- ones too. Recomputed for every product, not only the null ones.
update public.products p
   set category_id = (
     select l.category_id
       from public.product_category_links l
       join public.product_categories c on c.id = l.category_id
      where l.product_id = p.id
        and coalesce(c.status, 'active') = 'active'
      order by c.name
      limit 1
   )
 where exists (
   select 1 from public.product_category_links l where l.product_id = p.id
 );

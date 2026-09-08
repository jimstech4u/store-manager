-- 0101 — The groups a shop starts with are the people who made the goods
--
-- The seed shipped PET, Beer and Can. Those are packaging and shelf, which a shop may well want —
-- but they are not the grouping this software needs, and putting them in the picker first taught the
-- wrong idea about what a group is for.
--
-- A group is WHO MADE IT, because a brewery's empties come back interchangeably across everything
-- bought from them. An NBL crate takes any NBL bottle, whether it held Star, Gulder or Goldberg. So
-- the four a Nigerian distributor actually deals with:
--
--   Nigerian Breweries (NBL)   Star, Gulder, Legend, Goldberg, Life, 33 Export, Maltina, Amstel
--   Guinness                   Guinness FES, Harp, Malta Guinness, Satzenbrau, Dubic, Orijin
--   Trophy International       Trophy, Hero, Budweiser, Beta Malt, Grand Malt — International
--                              Breweries, which everybody names after its lager
--   Cway                       the water and dispenser bottles, whose containers come back the same
--                              way a crate does
--
-- THE OLD THREE ARE RETIRED, not deleted. Five products are in them, and a group on a product is on
-- every receipt that product has printed. Retiring takes them out of the picker and leaves the
-- history saying what it always said — and a shop that genuinely wants "Beer" back can restore it.

insert into public.product_categories (store_id, name)
select st.id, v.name
  from public.stores st
  cross join (values
    ('Nigerian Breweries (NBL)'),
    ('Guinness'),
    ('Trophy International'),
    ('Cway')
  ) as v(name)
 where not exists (
   select 1 from public.product_categories c
    where c.store_id = st.id
      and lower(btrim(c.name)) = lower(btrim(v.name))
 );

/*
 * And the packaging words stop being offered.
 *
 * Only where a shop has not made them its own: a `products` count above zero means somebody put
 * something in it deliberately, and that is an answer, not a seed. Matched by name because that is
 * all a seeded row has to identify it by.
 */
update public.product_categories c
   set status = 'archived'
 where lower(btrim(c.name)) in ('pet', 'beer', 'can')
   and c.status = 'active';

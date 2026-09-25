/**
 * WHAT A SEARCH ENGINE ACTUALLY SEES.
 *
 * Not what a browser sees. A crawler fetches the HTML and reads it: no JavaScript on the first pass,
 * no clicks, and it follows <a href> — never a button with an onClick. Anything that only exists
 * after hydration is, for ranking purposes, not there.
 *
 * So this asks the server the way a crawler would, with plain fetch and no browser at all:
 *
 *   1. is there a robots.txt and a sitemap, and do they point anywhere
 *   2. does the marketplace's HTML contain product names, or an empty shell
 *   3. are products reachable by <a href>, or only by tapping
 *   4. does each page carry a title, description, canonical and og: tags of its own
 *
 *     node scripts/probe-crawlable.mjs [http://localhost:3101]
 */

const BASE = process.argv[2] ?? 'http://localhost:3101';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const note = (what, detail = '') => console.log(`  ····  ${what}${detail ? ` — ${detail}` : ''}`);

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  });
  return { status: res.status, html: await res.text() };
};

const meta = (html, name) => {
  const byName = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html);
  const byProp = new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html);
  return (byName ?? byProp)?.[1] ?? null;
};
const links = (html) => [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);

try {
  // ══ 1. The things a crawler looks for first ═══════════════════════════════════════
  const robots = await get('/robots.txt');
  check('there is a robots.txt', robots.status === 200, `${robots.status}`);
  const sitemap = await get('/sitemap.xml');
  check('there is a sitemap', sitemap.status === 200, `${sitemap.status}`);
  if (sitemap.status === 200) {
    const urls = [...sitemap.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    check('and it lists pages', urls.length > 0, `${urls.length} url(s)`);
    note('first few', urls.slice(0, 3).join(' '));
  }

  // ══ 2. The marketplace, as delivered ══════════════════════════════════════════════
  const home = await get('/');
  check('the marketplace answers', home.status === 200, `${home.status}`);
  check('it has a title', Boolean(/<title[^>]*>([^<]+)<\/title>/i.exec(home.html)?.[1]), /<title[^>]*>([^<]+)<\/title>/i.exec(home.html)?.[1] ?? '(none)');
  check('and a description', Boolean(meta(home.html, 'description')), meta(home.html, 'description')?.slice(0, 60) ?? '(none)');
  check('and an og:title, for anything that previews a link', Boolean(meta(home.html, 'og:title')), meta(home.html, 'og:title') ?? '(none)');
  check('and a canonical', Boolean(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(home.html)), 'so duplicates collapse');

  // Real content, or a shell that fills in later?
  const shopLinks = links(home.html).filter((h) => /^\/s\//.test(h));
  const all = links(home.html);
  /*
   * An earlier version of this check passed on `/₦|price/` appearing anywhere in the document,
   * which a bundle name or a stray string satisfies — a check that cannot fail is worth nothing.
   * What a crawler needs is a NAME it can read and a LINK it can follow, so that is what is asked.
   */
  check('the HTML contains anchors at all', all.length > 0, `${all.length} <a href>`);
  check('and links to shops', shopLinks.length > 0, shopLinks.length ? shopLinks.slice(0, 2).join(' ') : 'none');
  check('and names something for sale', /₦\s?[\d,]/.test(home.html), 'a price in the markup');

  // ══ 3. Follow a shop, then look for its products ══════════════════════════════════
  const code = shopLinks[0]?.replace('/s/', '').split(/[/?#]/)[0];
  if (!code) {
    note('no shop link to follow — a crawler stops here', 'nothing below is reachable');
  } else {
    const shop = await get(`/s/${code}`);
    check(`a shop page answers (/s/${code})`, shop.status === 200, `${shop.status}`);
    check('the shop page has its own title', Boolean(/<title[^>]*>([^<]+)<\/title>/i.exec(shop.html)?.[1]),
      /<title[^>]*>([^<]+)<\/title>/i.exec(shop.html)?.[1] ?? '(none)');
    const productLinks = links(shop.html).filter((h) => /product|\/p\//i.test(h));
    check('and links a crawler can follow to a PRODUCT', productLinks.length > 0,
      productLinks.length ? productLinks.slice(0, 2).join(' ') : 'none — products are taps, not links');

    // ══ 4. A product page, and the picture anything previewing it will ask for ══════
    if (productLinks[0]) {
      const item = await get(productLinks[0]);
      check('the product page answers', item.status === 200, `${item.status}`);
      check('it has its own title', Boolean(/<title[^>]*>([^<]+)<\/title>/i.exec(item.html)?.[1]),
        /<title[^>]*>([^<]+)<\/title>/i.exec(item.html)?.[1] ?? '(none)');

      /*
       * THE og:image HAS TO FETCH, and nothing short of fetching it says so.
       *
       * It was built without the storage bucket — `…/object/public/<store>/…` rather than
       * `…/object/public/media/<store>/…` — which Supabase answers with a 400. The tag was
       * present and well-formed the whole time, so every check that looked at the MARKUP passed
       * while every link shared to WhatsApp had no picture and Google was offered an image that
       * does not exist. The only check worth having is the one that asks for it.
       */
      const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(item.html)?.[1];
      if (!og) {
        note('this product has no picture', 'nothing to fetch — not a failure');
      } else {
        const res = await fetch(og);
        check('and its preview image actually fetches', res.status === 200, `${res.status} ${og.slice(-40)}`);
      }
    }
  }
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  console.log(failed ? `\n${failed} of the things a crawler needs are missing` : '\nall passed');
  process.exit(failed ? 1 : 0);
}

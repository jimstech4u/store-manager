/*
 * THE APP OPENS, AND KEEPS OPENING, ON A SIGNAL THAT COMES AND GOES.
 *
 * A distributor's phone is on a network that drops in a warehouse, in a lorry, behind a wall of
 * crates. Without this, every one of those moments is the browser's dinosaur: the shop cannot even
 * reach the till to read what it already knows, because the page itself has to be fetched first.
 *
 * WHAT IS CACHED AND WHAT IS NOT — the line matters:
 *
 *   THE SHELL        the HTML, the scripts, the styles, the icons. Fixed things, fetched again as
 *                    soon as there is a signal, and served from the cache when there is not.
 *   THE SHOP'S DATA  NOT cached here, deliberately. state-stack already keeps what each screen has
 *                    read, in IndexedDB, and knows when it is stale (`resource.ts`). A second copy
 *                    in a service worker would be a second answer to "what does this shop owe",
 *                    ageing on its own, with nothing to say which is right.
 *
 * So: what was read is on screen from state-stack, and everything on it says whether it could be
 * refreshed. A write still needs the server — selling with no signal is its own phase.
 *
 * NAVIGATIONS ARE NETWORK-FIRST, with a short timeout. Serving a cached page to somebody who has a
 * connection would show yesterday's build of the app; the cache is the fallback, not the source.
 * STATIC FILES ARE CACHE-FIRST: Next puts a hash in every name, so a file that exists cannot change.
 */

/*
 * THE BUILD THIS WORKER CAME FROM. Substituted by `scripts/build-sw.mjs` before every build.
 *
 * It used to be a hand-written 'v5', and that is why a deploy never announced itself. A browser
 * decides a worker is NEW by comparing the bytes of the file it fetches with the one it installed.
 * Ship the same bytes and there is no update — no `updatefound`, nothing reaches `waiting`, and the
 * dialog that asks to relaunch has nothing to ask about. Four deploys went out that way.
 *
 * Old caches are dropped on activate, so a new build also clears the last one's shell.
 */
const VERSION = '__BUILD_VERSION__';
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
/*
 * A PLAIN FILE, not a page of the app.
 *
 * The first version of this was a Next route, and offline it rendered "Application error": the HTML
 * was cached but the scripts and styles it asks for had never been fetched, so there was nothing to
 * hydrate it with. The page shown when nothing can be fetched must depend on nothing.
 */
const OFFLINE_URL = '/offline.html';
const NAVIGATE_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      /*
       * The doors into the app, fetched now so they are there before they are needed.
       *
       * `/main` especially: signing in ROUTES there on the client, so the browser never fetches it
       * as a page and nothing would have been cached under it — the shop reloading its own till
       * with no signal met the offline notice while its data sat in IndexedDB behind it.
       */
      await Promise.all(
        [OFFLINE_URL, '/', '/login', '/main'].map((path) =>
          cache.add(new Request(path, { cache: 'reload' })).catch(() => {}),
        ),
      );
      /*
       * NOT `skipWaiting()` HERE.
       *
       * Taking over the moment a new version lands swaps the files under a page that is already
       * running — a till halfway through a sale, reaching for a screen it has not loaded yet. So a
       * new worker WAITS, the app notices and asks ("Update ready — Reload"), and only an answer
       * moves it on (`skip-waiting` below). An app nobody answers gets it on its next launch, which
       * is what closing and reopening has always meant.
       */
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Anything from an older version of this file, dropped in one pass.
      const keep = new Set([SHELL, STATIC]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** The shop's own data and every write: straight to the network, never stored here. */
function isAppData(url) {
  return url.origin !== self.location.origin || url.pathname.startsWith('/api/');
}

/*
 * A PAGE IS ITS PATH, not its path and its query.
 *
 * navigation-stack writes the whole stack into `?nav=` — which page, on which tab, with which ids —
 * so every screen a shop opens has a URL of its own. Cached by full URL, the shell was stored under
 * hundreds of keys and matched none of them on the way back in: reloading the till with no signal
 * fell through to the offline page, with the shop's own data sitting in IndexedDB behind it.
 *
 * The HTML is the same for every one of those URLs (the app draws the stack from the query itself),
 * so one entry per path serves them all.
 */
function shellKey(url) {
  return new Request(`${url.origin}${url.pathname}`, { credentials: 'same-origin' });
}

async function fromNetworkFirst(request) {
  const cache = await caches.open(SHELL);
  const key = shellKey(new URL(request.url));
  try {
    const fresh = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NAVIGATE_TIMEOUT_MS)),
    ]);
    // Only a real answer is worth keeping: a redirect to sign-in is about this moment, not the page.
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(key, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(key);
    if (hit) return hit;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw new Error('offline, and nothing cached for this page');
  }
}

/*
 * Build files are named by their contents, so every deploy adds a new set and none of the old ones
 * can ever be asked for again. Left alone they pile up on the phone for ever. There is no date on a
 * cache entry to sort by, so past a generous ceiling the lot is dropped: the app is online at that
 * moment (it just fetched something), and what it needs comes straight back on the next request.
 */
const STATIC_CEILING = 400;

async function pruneStatic(cache) {
  const keys = await cache.keys();
  if (keys.length <= STATIC_CEILING) return;
  await Promise.all(keys.map((k) => cache.delete(k)));
}

async function fromCacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    await cache.put(request, fresh.clone());
    await pruneStatic(cache);
  }
  return fresh;
}

/*
 * A page the shop is standing on, kept for the next time there is no signal.
 *
 * Every screen after the first is a client-side move: no document is fetched, so nothing would be
 * cached for it. The app tells us where it is (`ServiceWorker.tsx`) and we fetch that path once, in
 * the background, while there is still a connection to do it with.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  // The shop said yes to the new version.
  if (data && data.type === 'skip-waiting') {
    void self.skipWaiting();
    return;
  }
  if (!data || data.type !== 'warm' || typeof data.path !== 'string') return;
  event.waitUntil(
    (async () => {
      try {
        const url = new URL(data.path, self.location.origin);
        if (url.origin !== self.location.origin) return;
        const cache = await caches.open(SHELL);
        const key = shellKey(url);
        if (await cache.match(key)) return; // already known; the fetch would be a round trip for nothing
        const fresh = await fetch(new Request(url.pathname, { cache: 'no-cache' }));
        if (fresh && fresh.ok && fresh.type === 'basic') await cache.put(key, fresh);
      } catch {
        // No signal, or the page needs one. Either way there is nothing to keep.
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isAppData(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fromNetworkFirst(request));
    return;
  }

  // Hashed by the build, so a name that matches is a file that matches.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(fromCacheFirst(request));
  }
});

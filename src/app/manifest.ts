import type { MetadataRoute } from 'next';

/**
 * WHAT MAKES THIS AN APP ON SOMEBODY'S PHONE RATHER THAN A PAGE IN A BROWSER.
 *
 * A shop opens this twenty times a day, at a counter, with a customer waiting. Reaching it through
 * a browser means finding the tab, or typing an address, past a bookmark bar and a URL bar that
 * eat a fifth of a phone screen. Installed, it is an icon beside WhatsApp: one tap, full screen,
 * its own window in the task switcher.
 *
 * `display: standalone` is the line that removes the browser chrome. `background_color` is the
 * colour of the launch screen before the first paint — brand teal, so it never flashes white on the
 * way in. `start_url` is the front door, not a deep page: the app decides where to land from the
 * session (a shop, the setup wizard, or sign-in), and a saved deep link would fight that.
 *
 * iOS reads almost none of this — it wants `apple-touch-icon` and the meta tags in the layout — so
 * the two have to agree. See `InstallHint` for the part Apple leaves to the app: there is no install
 * prompt on iOS, so somebody has to be told about Share → Add to Home Screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Store Manager',
    short_name: 'Store Manager',
    description: 'Stock, sales and accounts for distribution businesses.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b6252',
    theme_color: '#0b6252',
    lang: 'en',
    dir: 'ltr',
    categories: ['business', 'productivity', 'finance'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      /*
       * Cropped by the launcher to its own shape. Drawn at 72% on a full-bleed ground, so a circle
       * mask keeps the whole crate — an "any" icon reused here loses its corners.
       */
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

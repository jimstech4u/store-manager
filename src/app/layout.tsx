import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorker } from '@/components/ui/ServiceWorker';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider } from '@/providers/AuthProvider';
import { PermissionsProvider } from '@/providers/PermissionsProvider';

export const metadata: Metadata = {
  /*
   * WHAT A RELATIVE URL IS RELATIVE TO.
   *
   * A canonical and an og:url have to be absolute — a link preview is fetched by a server somewhere
   * else, and "/s/7R8U2A" means nothing to it. Next resolves relative ones against this; without it
   * they resolve against localhost, which is both wrong and invisible until somebody shares a link.
   */
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://store-manager.vercel.app'),
  title: 'Store Manager',
  description: 'Stock, sales and accounts for distribution businesses.',
  applicationName: 'Store Manager',
  /*
   * WHAT iOS READS. It ignores the manifest almost entirely: the icon on the home screen comes from
   * `apple-touch-icon`, the name under it from `appleWebApp.title`, and full screen — no Safari
   * chrome — only happens with `capable`. Without these an iPhone installs a bookmark that opens
   * the browser, which is the thing we are removing.
   */
  appleWebApp: {
    capable: true,
    title: 'Store Manager',
    // The status bar keeps its own background, so the clock never lands on top of a header.
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icons/apple-touch-icon.png',
  },
  other: {
    /*
     * Next writes the modern `mobile-web-app-capable` and stops there. Safari has only honoured the
     * manifest's display mode since iOS 16.4 — before that, and this trade runs on phones well
     * before that, full screen happens only with Apple's own spelling. Both are cheap; one is not
     * enough.
     */
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  /*
   * The colour of the system bars around the app, per theme — teal against the light theme's header,
   * the dark theme's own ground against dark. One fixed colour leaves a bright strip above a dark
   * screen, which is the tell of a web page in a shell.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0b6252' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1413' },
  ],
  width: 'device-width',
  initialScale: 1,
  // No maximumScale and no user-scalable=no. Blocking pinch zoom is a common "app-like" tweak
  // and an accessibility failure: the people most likely to need to zoom are the ones this
  // product is built for.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          THE INSTALLED APP NEVER SHOWS THE SHOPFRONT ON ITS WAY IN.

          `/` is the public marketplace. An app installed before `start_url` became `/main` still
          launches here, and the redirect that heals that used to live in an effect — which runs
          after hydration, which is long after the server's HTML has been painted. So opening the
          app meant a full screen of somebody else's shops, and then the till: reported as "a flash
          of marketplace before /main".

          This runs in the HEAD, before the body it would have painted even exists. `display-mode:
          standalone` is true only in the installed app and never in a browser tab, so a person
          genuinely browsing the marketplace is untouched — including a signed-in one, who gets a
          "Go to my shop" button rather than a redirect, because this page is public and people
          browse it.

          `location.replace`, not `href`: the shopfront must not become a back destination inside
          the app, where Back belongs to the navigation stack.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{if(location.pathname!=='/')return;" +
              "var app=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)" +
              "||window.navigator.standalone===true;" +
              "if(app)location.replace('/main');}catch(e){}})();",
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <PermissionsProvider>{children}</PermissionsProvider>
            {/*
              INSIDE the provider: the update prompt reads how often this shop wants to be asked
              again, which is one of the shop's own settings. Outside it, `useAuth` throws — and
              the page that showed it first was the 404, which nobody would have opened for weeks.
            */}
            <ServiceWorker />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorker } from '@/components/ui/ServiceWorker';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider } from '@/providers/AuthProvider';
import { PermissionsProvider } from '@/providers/PermissionsProvider';

export const metadata: Metadata = {
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
      <body>
        <ThemeProvider>
          <AuthProvider>
            <PermissionsProvider>{children}</PermissionsProvider>
          </AuthProvider>
          <ServiceWorker />
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider } from '@/context/ThemeContext';
import { AuthProvider } from '@/providers/AuthProvider';

export const metadata: Metadata = {
  title: 'Store Manager',
  description: 'Stock, sales and accounts for distribution businesses.',
};

export const viewport: Viewport = {
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
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

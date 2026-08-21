import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ViewportInsetsProvider, NavigationDevtools } from '@academix-admin/navigation-stack';

export const metadata: Metadata = {
  title: 'Store Manager',
  description: 'Academix store manager portal.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ViewportInsetsProvider>
          {children}
          <NavigationDevtools />
        </ViewportInsetsProvider>
      </body>
    </html>
  );
}

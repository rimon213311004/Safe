import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SafeCheck',
    template: '%s · SafeCheck',
  },
  description:
    'Privacy-first personal safety, verification and incident reporting. Adjudicated outcomes only — reports under review are never shown.',
  // A product where one screen shows findings about a named person has no business
  // in a search index, and no business being previewed by a link unfurler.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1319' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          Session state has to live above every route. There is no server-side
          session to read: the access token is held in memory only, so the tree
          starts anonymous on every load and the provider restores from the
          refresh cookie. See lib/api.ts for why it is built that way.
        */}
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

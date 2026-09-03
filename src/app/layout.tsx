import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { BottomNav, HeaderNav, type NavItem } from '@/components/mobile-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Portfolio Intelligence',
  description: 'Private risk and attribution analytics',
  // Private by nature: never index it, and do not follow anything out of it.
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: '/favicon.ico',
  },
  // Added to the iOS Home Screen this opens without Safari's chrome, which is
  // what makes it feel like an app rather than a bookmark.
  appleWebApp: {
    capable: true,
    title: 'Portfolio',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1b1d21' },
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
  ],
  width: 'device-width',
  initialScale: 1,
  // The dense tables need pinch-zoom on a phone, so scaling stays enabled.
  maximumScale: 5,
  viewportFit: 'cover',
};

/**
 * `primary` marks the four pages that earn a slot on the phone's bottom bar;
 * everything else sits behind "More". On a desktop the whole list is the
 * header row.
 */
const NAV: NavItem[] = [
  { href: '/', label: 'Overview', primary: true },
  { href: '/positions', label: 'Positions', primary: true },
  { href: '/attribution', label: 'Attribution', short: 'Attrib.', primary: true },
  { href: '/risk', label: 'Risk', primary: true },
  { href: '/rrg', label: 'Rotation' },
  { href: '/exposure', label: 'Exposure' },
  { href: '/trades', label: 'Trades' },
  { href: '/options', label: 'Options' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/macro', label: 'Macro' },
  { href: '/data-health', label: 'Data' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen">
        <header className="pt-safe sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-3 py-2 md:gap-6 md:px-4">
            <Link href="/" className="text-[13px] font-semibold tracking-tight">
              Portfolio<span className="text-muted"> Intelligence</span>
            </Link>
            <HeaderNav items={NAV} />
            <span className="ml-auto text-[11px] text-muted">GBP</span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-3 py-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:px-4 md:py-4 md:pb-6">
          {children}
        </main>
        <BottomNav items={NAV} />
      </body>
    </html>
  );
}

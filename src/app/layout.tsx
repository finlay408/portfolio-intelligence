import type { Metadata, Viewport } from 'next';
import { Space_Grotesk } from 'next/font/google';
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
 * Five pages, all on the phone's bottom bar, nothing behind a "More". Trades,
 * corporate actions and data health are reached from where they matter — the
 * Holdings upload button, the overview's alert badge and freshness chip —
 * rather than from the nav.
 */
const NAV: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/positions', label: 'Holdings', also: ['/trades'] },
  { href: '/attribution', label: 'Performance', short: 'Perf.' },
  { href: '/risk', label: 'Risk' },
  { href: '/markets', label: 'Markets' },
];

/**
 * The overview's display face. Self-hosted by next/font at build time, so the
 * page makes no request to Google at runtime. Exposed as a CSS variable and
 * used only where `font-display` is asked for; the tables keep the system face.
 */
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={display.variable}>
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

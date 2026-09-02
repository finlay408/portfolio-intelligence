import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Portfolio Intelligence',
  description: 'Private risk and attribution analytics',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1b1d21' },
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
  ],
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/positions', label: 'Positions' },
  { href: '/attribution', label: 'Attribution' },
  { href: '/risk', label: 'Risk' },
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
        <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-2">
            <Link href="/" className="text-[13px] font-semibold tracking-tight">
              Portfolio<span className="text-muted"> Intelligence</span>
            </Link>
            <nav className="flex items-center gap-1 overflow-x-auto">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded px-2 py-1 text-[12px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto text-[11px] text-muted">GBP</span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-4">{children}</main>
      </body>
    </html>
  );
}

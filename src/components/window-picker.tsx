/**
 * The trailing-window selector: 1M · 3M · 6M · YTD · 1Y · All.
 *
 * Plain links carrying `?window=` so the choice is in the URL, the page stays
 * server-rendered, and a bookmarked or shared view means the same thing
 * tomorrow. No client state to fall out of sync.
 */
import Link from 'next/link';
import { WINDOWS, type WindowKey } from '@/lib/engine/windows';
import { cn } from './ui/primitives';

export function WindowPicker({
  current,
  basePath,
  className,
  size = 'compact',
}: {
  current: WindowKey;
  basePath: string;
  className?: string;
  /** `full` stretches across the row with thumb-sized segments, for the phone overview. */
  size?: 'compact' | 'full';
}) {
  const full = size === 'full';
  return (
    <nav
      aria-label="Performance window"
      className={cn(
        full
          ? 'flex rounded-xl bg-surface p-1'
          : 'inline-flex rounded-md border border-line bg-surface p-0.5',
        className,
      )}
    >
      {WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={w.key === '3m' ? basePath : `${basePath}?window=${w.key}`}
          scroll={false}
          title={w.description}
          aria-current={w.key === current ? 'true' : undefined}
          className={cn(
            'font-medium transition-colors',
            full
              ? 'flex h-9 flex-1 items-center justify-center rounded-lg text-[13px]'
              : 'rounded px-2.5 py-1 text-[11px] sm:px-3',
            w.key === current
              ? full
                ? 'bg-ink text-canvas'
                : 'bg-surface-2 text-ink'
              : 'text-muted hover:text-ink',
          )}
        >
          {w.label}
        </Link>
      ))}
    </nav>
  );
}

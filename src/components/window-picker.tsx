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
}: {
  current: WindowKey;
  basePath: string;
  className?: string;
}) {
  return (
    <nav
      aria-label="Performance window"
      className={cn('inline-flex rounded-md border border-line bg-surface p-0.5', className)}
    >
      {WINDOWS.map((w) => (
        <Link
          key={w.key}
          href={w.key === '3m' ? basePath : `${basePath}?window=${w.key}`}
          scroll={false}
          title={w.description}
          aria-current={w.key === current ? 'true' : undefined}
          className={cn(
            'rounded px-2.5 py-1 text-[11px] font-medium transition-colors sm:px-3',
            w.key === current
              ? 'bg-surface-2 text-ink'
              : 'text-muted hover:text-ink',
          )}
        >
          {w.label}
        </Link>
      ))}
    </nav>
  );
}

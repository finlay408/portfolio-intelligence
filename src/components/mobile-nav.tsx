'use client';

/**
 * Navigation that works with a thumb.
 *
 * On a phone the five pages sit on a fixed bottom bar; on wider screens the
 * same list renders as the header row. One source of truth for the links; the
 * layout decides which shape to show.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from './ui/primitives';

export interface NavItem {
  href: string;
  label: string;
  /** Short label for the bottom bar. */
  short?: string;
  /** Other paths that light this item up, for pages reached from inside it. */
  also?: string[];
}

function matches(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isActive(pathname: string, item: NavItem): boolean {
  return [item.href, ...(item.also ?? [])].some((href) => matches(pathname, href));
}

export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="no-scrollbar hidden items-center gap-1 overflow-x-auto md:flex">
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded px-2 py-1 text-[12px] transition-colors',
              active ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-canvas/95 backdrop-blur md:hidden"
    >
      <ul className="grid h-14" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full flex-col items-center justify-center gap-0.5 text-[11px]',
                  active ? 'font-semibold text-ink' : 'text-muted',
                )}
              >
                <span className={cn('h-1 w-1 rounded-full', active ? 'bg-accent' : 'bg-transparent')} />
                {item.short ?? item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

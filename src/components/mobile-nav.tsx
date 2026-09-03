'use client';

/**
 * Navigation that works with a thumb.
 *
 * On a phone the eleven-item header row becomes a fixed bottom bar with the
 * four pages that get opened daily plus a "More" sheet for the rest. On
 * wider screens the same list renders as the header nav. One source of
 * truth for the links; the layout decides which shape to show.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from './ui/primitives';

export interface NavItem {
  href: string;
  label: string;
  /** Short label for the bottom bar. */
  short?: string;
  primary?: boolean;
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="no-scrollbar hidden items-center gap-1 overflow-x-auto md:flex">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
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
  const [open, setOpen] = useState(false);
  const primary = items.filter((i) => i.primary);
  const rest = items.filter((i) => !i.primary);
  const restActive = rest.some((i) => isActive(pathname, i.href));

  // Navigating closes the sheet.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="md:hidden">
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-canvas/60 backdrop-blur-[2px]"
        />
      )}
      {open && (
        <div className="fixed inset-x-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <div className="grid grid-cols-2 gap-1">
            {rest.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded px-3 py-2.5 text-[13px]',
                    active ? 'bg-surface-2 text-ink' : 'text-ink-2 active:bg-surface-2',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
      <nav
        aria-label="Primary"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-canvas/95 backdrop-blur"
      >
        <ul className="grid h-14 grid-cols-5">
          {primary.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-full flex-col items-center justify-center gap-0.5 text-[11px]',
                    active ? 'text-ink' : 'text-muted',
                  )}
                >
                  <span className={cn('h-1 w-1 rounded-full', active ? 'bg-accent' : 'bg-transparent')} />
                  {item.short ?? item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className={cn(
                'flex h-full w-full flex-col items-center justify-center gap-0.5 text-[11px]',
                open || restActive ? 'text-ink' : 'text-muted',
              )}
            >
              <span className={cn('h-1 w-1 rounded-full', restActive ? 'bg-accent' : 'bg-transparent')} />
              More
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}

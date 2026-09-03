/**
 * Top and bottom contributors as diverging bars, server-rendered.
 *
 * A contribution is weight × return, so a small position that doubled and a
 * large one that drifted 5% can sit side by side. Bars share one scale so
 * the eye compares magnitudes, and the sign carries the only colour.
 */
import Link from 'next/link';
import { cn } from './ui/primitives';

export interface ContributorRow {
  key: string;
  label: string;
  /** Contribution to portfolio return over the period, as a decimal. */
  value: number;
  href?: string;
  sub?: string;
}

const fmt = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

export function Contributors({ rows, emptyText = 'Nothing to attribute yet.' }: { rows: ContributorRow[]; emptyText?: string }) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-[12px] text-muted">{emptyText}</p>;
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);

  return (
    <ul className="divide-y divide-line/60">
      {rows.map((r) => {
        const positive = r.value >= 0;
        const width = (Math.abs(r.value) / max) * 100;
        const label = r.href ? (
          <Link href={r.href} className="font-medium hover:text-accent">
            {r.label}
          </Link>
        ) : (
          <span className="font-medium">{r.label}</span>
        );
        return (
          <li key={r.key} className="grid grid-cols-[minmax(4.5rem,1fr)_2fr_auto] items-center gap-3 px-4 py-1.5 text-[12px]">
            <div className="min-w-0 truncate">
              {label}
              {r.sub && <div className="truncate text-[10px] text-muted">{r.sub}</div>}
            </div>
            <div className="flex h-2 items-center">
              <div className="flex h-full w-1/2 justify-end">
                {!positive && <div className="h-full rounded-l-full bg-down/70" style={{ width: `${width}%` }} />}
              </div>
              <div className="h-full w-px bg-line-strong" />
              <div className="h-full w-1/2">
                {positive && <div className="h-full rounded-r-full bg-up/70" style={{ width: `${width}%` }} />}
              </div>
            </div>
            <span className={cn('tabular w-16 text-right', positive ? 'text-up' : 'text-down')}>{fmt(r.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

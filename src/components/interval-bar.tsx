/**
 * An estimate drawn as a range.
 *
 * "−0.3% ± 15.1%" is a true statement that almost nobody reads correctly. The
 * same fact drawn as a bar — a wide band straddling zero with a dot near the
 * middle — is read correctly at a glance: the dot is the best guess, the band
 * is everywhere the truth could plausibly be, and if the band crosses zero the
 * sign is not known (§7.4, §12).
 */
import { cn } from './ui/primitives';

export function IntervalBar({
  point,
  low,
  high,
  format,
  className,
}: {
  point: number;
  low: number;
  high: number;
  format: (v: number) => string;
  className?: string;
}) {
  const extent = Math.max(Math.abs(low), Math.abs(high), Math.abs(point)) * 1.15 || 1;
  const x = (v: number) => ((v + extent) / (2 * extent)) * 100;
  const crossesZero = low < 0 && high > 0;
  const tone = crossesZero ? 'bg-muted' : point >= 0 ? 'bg-up' : 'bg-down';
  const dot = crossesZero ? 'bg-ink' : point >= 0 ? 'bg-up' : 'bg-down';

  return (
    <div className={cn('select-none', className)}>
      <div className="relative h-6">
        {/* zero line */}
        <div className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${x(0)}%` }} />
        {/* the interval */}
        <div
          className={cn('absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-40', tone)}
          style={{ left: `${x(low)}%`, width: `${x(high) - x(low)}%` }}
        />
        {/* the point estimate */}
        <div
          className={cn('absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface', dot)}
          style={{ left: `${x(point)}%` }}
        />
      </div>
      <div className="relative h-4 text-[10px] text-muted">
        <span className="absolute -translate-x-1/2 tabular" style={{ left: `${x(low)}%` }}>
          {format(low)}
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: `${x(0)}%` }}>
          0
        </span>
        <span className="absolute -translate-x-1/2 tabular" style={{ left: `${x(high)}%` }}>
          {format(high)}
        </span>
      </div>
    </div>
  );
}

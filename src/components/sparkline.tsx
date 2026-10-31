/**
 * A tiny line with no axes, for showing which way something has been heading.
 *
 * Server-rendered SVG: there is nothing to hover, so there is no reason to
 * ship a charting library for it. The viewBox stretches to its box and the
 * stroke stays one width whatever the box does.
 */
import { cn } from './ui/primitives';

export function Sparkline({
  values,
  className,
  stroke = 'var(--color-muted)',
}: {
  values: number[];
  className?: string;
  stroke?: string;
}) {
  if (values.length < 2) return <div className={cn('h-6', className)} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - min) / span) * 20}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className={cn('h-6 w-full', className)} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

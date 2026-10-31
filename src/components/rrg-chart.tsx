'use client';

/**
 * Relative Rotation Graph (CLAUDE.md §7.7).
 *
 * Rendered with D3 rather than Recharts because the trails are the point: each
 * series is a path through the quadrants over 8-12 weekly observations, with
 * the head marked and the tail fading. No charting library gives that for free.
 *
 * The maths lives in `analytics/rrg.py`. This draws what it produced.
 */
import * as d3 from 'd3';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface RrgSeries {
  key: string;
  label: string;
  quadrant: 'leading' | 'weakening' | 'lagging' | 'improving';
  tail: Array<{ date: string; rs_ratio: number; rs_momentum: number }>;
}

const QUADRANTS = [
  { key: 'leading', label: 'Leading', x: 1, y: 1, tone: 'var(--color-up)' },
  { key: 'weakening', label: 'Weakening', x: 1, y: -1, tone: 'var(--color-warn)' },
  { key: 'lagging', label: 'Lagging', x: -1, y: -1, tone: 'var(--color-down)' },
  { key: 'improving', label: 'Improving', x: -1, y: 1, tone: 'var(--color-accent)' },
] as const;

export function RrgChart({
  series,
  benchmarkLabel,
  height = 520,
}: {
  series: RrgSeries[];
  benchmarkLabel: string;
  height?: number;
}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () => series.filter((s) => !hidden.has(s.key) && s.tail.length > 0),
    [series, hidden],
  );

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll('*').remove();
    if (visible.length === 0) return;

    const width = ref.current?.clientWidth ?? 720;
    const margin = { top: 16, right: 16, bottom: 32, left: 40 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const points = visible.flatMap((s) => s.tail);
    // Keep 100 exactly at the centre: the quadrants are only meaningful if the
    // crosshair sits on 100/100, so the domain is padded symmetrically.
    const spanX = Math.max(3, ...points.map((p) => Math.abs(p.rs_ratio - 100))) * 1.15;
    const spanY = Math.max(3, ...points.map((p) => Math.abs(p.rs_momentum - 100))) * 1.15;

    const x = d3.scaleLinear([100 - spanX, 100 + spanX], [0, innerWidth]);
    const y = d3.scaleLinear([100 - spanY, 100 + spanY], [innerHeight, 0]);

    const root = svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Quadrant washes.
    for (const q of QUADRANTS) {
      root
        .append('rect')
        .attr('x', q.x > 0 ? x(100) : 0)
        .attr('y', q.y > 0 ? 0 : y(100))
        .attr('width', innerWidth / 2)
        .attr('height', innerHeight / 2)
        .attr('fill', q.tone)
        .attr('opacity', 0.05);

      root
        .append('text')
        .attr('x', q.x > 0 ? innerWidth - 8 : 8)
        .attr('y', q.y > 0 ? 16 : innerHeight - 8)
        .attr('text-anchor', q.x > 0 ? 'end' : 'start')
        .attr('fill', q.tone)
        .attr('font-size', 11)
        .attr('opacity', 0.75)
        .text(q.label);
    }

    // Crosshair at 100/100.
    root
      .append('line')
      .attr('x1', x(100))
      .attr('x2', x(100))
      .attr('y1', 0)
      .attr('y2', innerHeight)
      .attr('stroke', 'var(--color-line-strong)');
    root
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', y(100))
      .attr('y2', y(100))
      .attr('stroke', 'var(--color-line-strong)');

    root
      .append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).ticks(6).tickSize(4))
      .call((g) => g.selectAll('text').attr('fill', 'var(--color-muted)').attr('font-size', 10))
      .call((g) => g.selectAll('line,path').attr('stroke', 'var(--color-line)'));

    root
      .append('g')
      .call(d3.axisLeft(y).ticks(6).tickSize(4))
      .call((g) => g.selectAll('text').attr('fill', 'var(--color-muted)').attr('font-size', 10))
      .call((g) => g.selectAll('line,path').attr('stroke', 'var(--color-line)'));

    const colour = d3
      .scaleOrdinal<string>()
      .domain(visible.map((s) => s.key))
      .range(d3.quantize((t) => d3.interpolateCool(t * 0.85 + 0.1), Math.max(visible.length, 2)));

    const line = d3
      .line<{ rs_ratio: number; rs_momentum: number }>()
      .x((p) => x(p.rs_ratio))
      .y((p) => y(p.rs_momentum))
      .curve(d3.curveCatmullRom.alpha(0.5));

    for (const s of visible) {
      const dim = hovered !== null && hovered !== s.key;
      const stroke = colour(s.key);

      root
        .append('path')
        .datum(s.tail)
        .attr('fill', 'none')
        .attr('stroke', stroke)
        .attr('stroke-width', hovered === s.key ? 2.5 : 1.5)
        .attr('opacity', dim ? 0.15 : 0.85)
        .attr('d', line);

      // Tail dots fade towards the oldest observation.
      root
        .selectAll(`.dot-${s.key}`)
        .data(s.tail.slice(0, -1))
        .join('circle')
        .attr('cx', (p) => x(p.rs_ratio))
        .attr('cy', (p) => y(p.rs_momentum))
        .attr('r', 2)
        .attr('fill', stroke)
        .attr('opacity', (_p, i) => (dim ? 0.1 : 0.2 + (0.6 * i) / Math.max(s.tail.length - 1, 1)));

      const head = s.tail.at(-1)!;
      const group = root
        .append('g')
        .attr('cursor', 'pointer')
        .on('mouseenter', () => setHovered(s.key))
        .on('mouseleave', () => setHovered(null));

      group
        .append('circle')
        .attr('cx', x(head.rs_ratio))
        .attr('cy', y(head.rs_momentum))
        .attr('r', hovered === s.key ? 7 : 5)
        .attr('fill', stroke)
        .attr('opacity', dim ? 0.2 : 1)
        .append('title')
        .text(
          `${s.label}\n${head.date}\nRS-Ratio ${head.rs_ratio.toFixed(2)}\nRS-Momentum ${head.rs_momentum.toFixed(2)}\n${s.quadrant}`,
        );

      group
        .append('text')
        .attr('x', x(head.rs_ratio) + 9)
        .attr('y', y(head.rs_momentum) + 4)
        .attr('fill', 'var(--color-ink)')
        .attr('font-size', 11)
        .attr('opacity', dim ? 0.2 : 1)
        .text(s.label);
    }
  }, [visible, hovered, height]);

  return (
    <div className="px-4 py-3">
      <svg ref={ref} className="w-full" style={{ height }} role="img" aria-label={`Relative rotation graph against ${benchmarkLabel}`} />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() =>
              setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(s.key)) next.delete(s.key);
                else next.add(s.key);
                return next;
              })
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
              hidden.has(s.key)
                ? 'border-line text-muted line-through'
                : 'border-line-strong text-ink-2 hover:text-ink'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

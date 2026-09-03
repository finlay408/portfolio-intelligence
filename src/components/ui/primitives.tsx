/**
 * The small set of shadcn-style primitives this app needs.
 *
 * Written by hand rather than pulled through the CLI: seven components is not
 * worth a generator, and the copy-paste model means they belong in the repo
 * anyway.
 */
import { clsx } from 'clsx';
import Link from 'next/link';
import { delayLabel } from '@/lib/format';
import type { ReactNode } from 'react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return clsx(parts);
}

/* ---------------- Card ---------------- */

export function Card({
  children,
  className,
  title,
  subtitle,
  action,
  footnote,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  /** Computation timestamp, provenance, caveat — §12 requires these visible. */
  footnote?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-line bg-surface',
        'flex flex-col overflow-hidden',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2.5 sm:px-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium tracking-tight text-ink sm:truncate">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] leading-snug text-muted sm:truncate">{subtitle}</p>}
          </div>
          {action && <div className="min-w-0 text-[11px] text-muted sm:shrink-0">{action}</div>}
        </header>
      )}
      <div className="min-h-0 flex-1">{children}</div>
      {footnote && (
        <footer className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-muted">
          {footnote}
        </footer>
      )}
    </section>
  );
}

/* ---------------- Stat ---------------- */

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  href,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warn';
  /** Progressive depth: every number on the overview opens its derivation. */
  href?: string;
  hint?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {hint && <InfoDot hint={hint} />}
      </div>
      <div
        className={cn(
          'tabular mt-1 text-xl leading-none font-medium',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-ink-2">{sub}</div>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="block rounded-md px-3 py-2.5 transition-colors hover:bg-surface-2"
      >
        {body}
      </Link>
    );
  }
  return <div className="px-3 py-2.5">{body}</div>;
}

export function InfoDot({ hint }: { hint: string }) {
  return (
    <span
      title={hint}
      className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-line-strong text-[8px] leading-none text-muted"
      aria-label={hint}
    >
      ?
    </span>
  );
}

/* ---------------- Badge ---------------- */

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warn' | 'accent';
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'neutral' && 'border-line text-muted',
        tone === 'up' && 'border-up/40 text-up',
        tone === 'down' && 'border-down/40 text-down',
        tone === 'warn' && 'border-warn/50 text-warn',
        tone === 'accent' && 'border-accent/40 text-accent',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Freshness badge. Rendered next to every quote, always. `delaySeconds` comes
 * straight from the provider row — the UI never guesses it.
 *
 * `kind` matters as much as the number. A stored end-of-day close taken this
 * morning is zero seconds "delayed" and is still not a live price; badging it
 * "Live" is precisely the failure §5 forbids, so a close is never labelled that
 * way no matter how recent it is.
 */
export function FreshnessBadge({
  delaySeconds,
  provider,
  asOf,
  kind = 'quote',
}: {
  delaySeconds: number | null;
  provider?: string | null;
  asOf?: string | null;
  kind?: 'quote' | 'close';
}) {
  if (kind === 'close') {
    // Anything older than a couple of sessions is amber: the close is real, but
    // the price on screen is not today's.
    const old = delaySeconds === null || delaySeconds > 3 * 86_400;
    return (
      <Badge
        tone={old ? 'warn' : 'neutral'}
        title={[
          'End-of-day close, not a live quote',
          provider && `via ${provider}`,
          asOf && `as of ${asOf}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <span className={cn('h-1 w-1 rounded-full', old ? 'bg-warn' : 'bg-muted')} />
        {delaySeconds !== null && delaySeconds < 2 * 86_400
          ? 'Close'
          : `Close · ${delayLabel(delaySeconds)}`}
      </Badge>
    );
  }

  const live = delaySeconds !== null && delaySeconds <= 5;
  // A quote more than a day old is not "delayed", it is stale, and it gets the
  // amber treatment so it cannot be mistaken for a working feed.
  const stale = delaySeconds === null || delaySeconds > 86_400;
  const tone = live ? 'up' : stale ? 'warn' : 'neutral';

  return (
    <Badge
      tone={tone}
      title={[provider && `via ${provider}`, asOf && `as of ${asOf}`].filter(Boolean).join(' · ')}
    >
      <span
        className={cn('h-1 w-1 rounded-full', live ? 'bg-up' : stale ? 'bg-warn' : 'bg-muted')}
      />
      {delayLabel(delaySeconds)}
    </Badge>
  );
}

/* ---------------- Table ---------------- */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-[13px]', className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-2 py-2 sm:px-3',
        'text-[10px] font-medium uppercase tracking-wide text-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  numeric,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td
      className={cn(
        'whitespace-nowrap border-b border-line/60 px-2 py-1.5 sm:px-3',
        numeric && 'tabular',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <tr className={cn('hover:bg-surface-2/60', className)}>{children}</tr>;
}

/* ---------------- Empty and warning states ---------------- */

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-[12px] text-muted">{children}</div>;
}

/**
 * Used wherever a figure is suppressed rather than computed from too little
 * data — "insufficient history" is a real answer and beats a fabricated number
 * (§7.5, §12).
 */
export function Insufficient({ reason }: { reason: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-[12px] font-medium text-warn">Insufficient history</p>
      <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-muted">{reason}</p>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-warn/30 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed text-ink-2">
      {children}
    </p>
  );
}

/* ---------------- Bar ---------------- */

/** A weight bar. No gradient, no animation — it is a length, and that is all. */
export function WeightBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'up' | 'down' }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'accent' && 'bg-accent/70',
          tone === 'up' && 'bg-up/70',
          tone === 'down' && 'bg-down/70',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

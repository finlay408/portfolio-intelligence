/**
 * Markets: how your holdings are rotating against the S&P 500 (§7.7), and the
 * macro backdrop they are doing it in.
 *
 * Merges the old Rotation and Macro pages. The RRG maths runs in the nightly
 * Python job; this draws what it produced. Macro is context, not signal: it is
 * here so a drawdown can be read against what rates and volatility were doing.
 */
import { Insufficient, cn } from '@/components/ui/primitives';
import { RrgChart, type RrgSeries } from '@/components/rrg-chart';
import { JumpLinks, MacroCard, PageHead, Section } from '@/components/scoreboard';
import { shortDate } from '@/lib/format';
import { MACRO_SERIES, QUADRANTS, quadrantMoves } from '@/lib/market-views';
import { getAnalytics, getMacroTiles } from '@/lib/portfolio';

export const dynamic = 'force-dynamic';

interface RrgPayload {
  status: string;
  frequency: string;
  tail_length: number;
  series: RrgSeries[];
  themes?: { status: string; series: RrgSeries[] };
}

export default async function MarketsPage() {
  const [rrg, macro] = await Promise.all([
    getAnalytics<RrgPayload>('rrg'),
    getMacroTiles(MACRO_SERIES.map((m) => m.id), 126),
  ]);

  const ok = rrg?.payload.status === 'ok';
  const series = ok ? rrg!.payload.series.filter((s) => s.tail.length > 0) : [];
  const themes = ok && rrg!.payload.themes?.status === 'ok' ? rrg!.payload.themes.series : [];
  const moves = quadrantMoves(series);

  return (
    <div className="font-display mx-auto max-w-5xl space-y-4 pb-4">
      <PageHead title="Markets" />

      <JumpLinks items={[['#rotation', 'Rotation'], ['#macro', 'Macro']]} />

      {/* ---- rotation ---- */}
      <Section
        id="rotation"
        title="Rotation"
        meta={ok ? `vs S&P 500 · ${rrg!.payload.frequency} · ${shortDate(rrg!.snapDate)}` : undefined}
      >
        {!ok ? (
          <Insufficient reason="Needs about seven months of weekly prices." />
        ) : (
          <>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {QUADRANTS.map((q) => (
                <div key={q.key} className={cn('rounded-xl px-1 py-2.5', q.fill)}>
                  <div className={cn('text-[24px] font-semibold leading-none', q.tone)}>
                    {series.filter((s) => s.quadrant === q.key).length}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-2">{q.label}</div>
                </div>
              ))}
            </div>

            {moves.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                <span className="text-muted">This week</span>
                {moves.map((m) => {
                  const q = QUADRANTS.find((x) => x.key === m.now)!;
                  return (
                    <span key={m.label}>
                      {m.label} → <span className={q.tone}>{q.label}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <div className="-mx-4">
              <RrgChart series={series} benchmarkLabel="the S&P 500" height={380} />
            </div>

          </>
        )}
      </Section>

      {themes.length > 0 && (
        <Section title="Themes" meta="weight-averaged">
          <div className="-mx-4">
            <RrgChart series={themes} benchmarkLabel="the S&P 500" height={320} />
          </div>
        </Section>
      )}

      {/* ---- macro ---- */}
      <Section id="macro" title="Macro" meta="~1 month change · colour = effect on you">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {MACRO_SERIES.map((spec) => (
            <MacroCard key={spec.id} spec={spec} tile={macro.find((t) => t.id === spec.id)!} tall />
          ))}
        </div>
      </Section>
    </div>
  );
}

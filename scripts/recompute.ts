/**
 * Rebuild the cached daily snapshots from the ledger.
 *
 *   npm run recompute -- --from=inception
 *   npm run recompute -- --from=2025-01-01 --account=1
 *
 * The cache in `portfolio_daily` is a performance optimisation and nothing
 * more (§2). The definition of what those rows contain lives in
 * `src/lib/engine/recompute.ts`, shared with the in-app export upload; this is
 * the command-line entry point.
 */
import { recomputeSnapshots } from '../src/lib/engine/recompute';
import { args, runJob } from './_util';

const argv = args();

await runJob('recompute', async () => {
  const from =
    argv.from === 'inception' || argv.from === undefined || argv.from === true
      ? 'inception'
      : String(argv.from);
  const result = await recomputeSnapshots({
    from,
    to: typeof argv.to === 'string' ? argv.to : undefined,
    accountId: argv.account ? Number(argv.account) : undefined,
    log: (line) => console.log(`[recompute] ${line}`),
  });
  return { ...result };
});

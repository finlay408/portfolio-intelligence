/**
 * Corporate action validation (CLAUDE.md §6).
 *
 * Do not apply actions blindly. A bad split ratio from a scraped source
 * silently destroys cost basis across all history, and the damage is invisible
 * until someone reconciles by hand months later.
 *
 * Two gates:
 *   1. Anything that would move a position's value by more than 15% is held
 *      as `applied = false` and queued for confirmation.
 *   2. A reported split ratio is cross-checked against the price gap between
 *      the prior close and the ex-date open. A genuine 4:1 split shows a ~75%
 *      drop. If the implied and reported ratios disagree, the action is
 *      flagged, not applied.
 */
import { Decimal, ONE, dec, divOrNull } from '../decimal';
import type { CorporateActionKind, IsoDate } from '../types';
import type { DetectedCorporateAction } from '../providers/types';

/** Value impact above which a human must confirm before the action applies. */
export const AUTO_APPLY_IMPACT_LIMIT = new Decimal('0.15');

/** How far the implied ratio may differ from the reported one, as a fraction. */
export const RATIO_AGREEMENT_TOLERANCE = new Decimal('0.05');

export type ValidationVerdict = 'auto_apply' | 'needs_confirmation' | 'rejected';

export interface ValidationResult {
  verdict: ValidationVerdict;
  /** Fraction of position value the action would move. */
  impact: Decimal;
  /** Ratio implied by the price gap across the ex-date, when computable. */
  impliedRatio: Decimal | null;
  reasons: string[];
}

export interface PriceContext {
  /** Close on the last session before the ex-date. */
  priorClose: Decimal | null;
  /** Open (or close) on the ex-date itself. */
  exDateOpen: Decimal | null;
  /** Position value in GBP immediately before the action. */
  positionValueGbp: Decimal | null;
}

export function validateAction(
  action: Pick<DetectedCorporateAction, 'kind' | 'ratio' | 'amount' | 'actionDate'>,
  ctx: PriceContext,
): ValidationResult {
  const reasons: string[] = [];
  const impliedRatio = impliedSplitRatio(ctx);

  switch (action.kind) {
    case 'split':
    case 'reverse_split': {
      const reported = action.ratio === null ? null : dec(action.ratio);
      if (!reported || reported.lessThanOrEqualTo(0)) {
        return {
          verdict: 'rejected',
          impact: ONE,
          impliedRatio,
          reasons: ['no usable ratio reported'],
        };
      }

      // A split changes the share count and the price together; the position
      // value should be unchanged. Any residual is the error in the ratio.
      if (impliedRatio) {
        const disagreement = reported.minus(impliedRatio).abs().div(reported);
        if (disagreement.greaterThan(RATIO_AGREEMENT_TOLERANCE)) {
          reasons.push(
            `reported ${reported.toFixed()}:1 but the price gap implies ` +
              `${impliedRatio.toFixed(3)}:1 — a ${disagreement.times(100).toFixed(1)}% disagreement`,
          );
          return { verdict: 'needs_confirmation', impact: ONE, impliedRatio, reasons };
        }
        reasons.push(`price gap confirms ~${impliedRatio.toFixed(2)}:1`);
      } else {
        reasons.push('no price data across the ex-date to cross-check the ratio');
        return { verdict: 'needs_confirmation', impact: ONE, impliedRatio, reasons };
      }

      // A split is value-neutral by construction, so impact is zero once the
      // ratio has been verified.
      return { verdict: 'auto_apply', impact: new Decimal(0), impliedRatio, reasons };
    }

    case 'dividend':
    case 'special_dividend': {
      const amount = action.amount === null ? null : dec(action.amount);
      if (!amount || amount.lessThanOrEqualTo(0)) {
        return {
          verdict: 'rejected',
          impact: new Decimal(0),
          impliedRatio,
          reasons: ['no usable dividend amount'],
        };
      }
      const impact =
        ctx.priorClose && !ctx.priorClose.isZero() ? amount.div(ctx.priorClose) : new Decimal(0);
      if (impact.greaterThan(AUTO_APPLY_IMPACT_LIMIT)) {
        reasons.push(
          `dividend is ${impact.times(100).toFixed(1)}% of the price — plausible for a special, ` +
            'but large enough to confirm by hand',
        );
        return { verdict: 'needs_confirmation', impact, impliedRatio, reasons };
      }
      return { verdict: 'auto_apply', impact, impliedRatio, reasons };
    }

    case 'ticker_change':
      return {
        verdict: 'auto_apply',
        impact: new Decimal(0),
        impliedRatio,
        reasons: ['ticker changes move no value'],
      };

    case 'spinoff':
    case 'merger':
    case 'delisting':
      // These restructure the holding itself. There is no safe automatic path.
      return {
        verdict: 'needs_confirmation',
        impact: ONE,
        impliedRatio,
        reasons: [`${action.kind} restructures the position and always needs explicit terms`],
      };

    default:
      return {
        verdict: 'needs_confirmation',
        impact: ONE,
        impliedRatio,
        reasons: [`unrecognised action kind`],
      };
  }
}

/**
 * The split ratio implied by the price gap. A 4:1 split takes the price to a
 * quarter, so ratio = priorClose / exDateOpen.
 */
export function impliedSplitRatio(ctx: PriceContext): Decimal | null {
  if (!ctx.priorClose || !ctx.exDateOpen) return null;
  if (ctx.exDateOpen.isZero()) return null;
  const ratio = divOrNull(ctx.priorClose, ctx.exDateOpen);
  if (!ratio || ratio.lessThanOrEqualTo(0)) return null;
  return ratio;
}

/** Value impact of applying an action to a position, as a fraction. */
export function estimateImpact(
  kind: CorporateActionKind,
  ratio: Decimal | null,
  positionValueGbp: Decimal | null,
  amountPerShare: Decimal | null,
  price: Decimal | null,
): Decimal {
  if (!positionValueGbp || positionValueGbp.isZero()) return new Decimal(0);
  switch (kind) {
    case 'split':
    case 'reverse_split':
      return new Decimal(0); // value-neutral when the ratio is right
    case 'dividend':
    case 'special_dividend':
      return amountPerShare && price && !price.isZero()
        ? amountPerShare.div(price)
        : new Decimal(0);
    default:
      return ONE;
  }
}

export interface QueuedAction {
  instrumentId: number;
  actionDate: IsoDate;
  kind: CorporateActionKind;
  verdict: ValidationVerdict;
  reasons: string[];
}

/** Format a validation result for the confirmation queue in the UI. */
export function describeVerdict(r: ValidationResult): string {
  switch (r.verdict) {
    case 'auto_apply':
      return `Applied automatically. ${r.reasons.join('; ')}`;
    case 'needs_confirmation':
      return `Held for confirmation. ${r.reasons.join('; ')}`;
    case 'rejected':
      return `Rejected. ${r.reasons.join('; ')}`;
  }
}

/**
 * Fund look-through parsing (`providers/yahoo-fund.ts`).
 *
 * The payloads below are trimmed captures of real Yahoo responses — VWRP.L, an
 * LSE-listed GBP accumulating all-world tracker, and IGLT.L, a gilt tracker
 * with no equity sleeve at all. Nothing here touches the network: the point is
 * that the shape Yahoo actually returns maps onto the buckets the exposure grid
 * uses, including the traps (zero-weight sectors, a bond fund with an empty
 * sector list, weights that do not sum to one).
 */
import { describe, expect, it } from 'vitest';
import {
  assetClassFromMix,
  fundSectorWeights,
  parseFundProfile,
  regionOfSymbol,
  topHoldingRegions,
} from '../src/lib/providers/yahoo-fund';

const n = (raw: number) => ({ raw, fmt: String(raw) });

/** VWRP.L — Vanguard FTSE All-World UCITS ETF (Acc), as Yahoo returns it. */
const vwrp = {
  fundProfile: {
    family: 'Vanguard Group (Ireland) Limited',
    categoryName: null,
    legalType: 'Exchange Traded Fund',
    feesExpensesInvestment: { annualReportExpenseRatio: n(0.0022) },
  },
  topHoldings: {
    sectorWeightings: [
      { realestate: n(0.0184) },
      { consumer_cyclical: n(0.0906) },
      { basic_materials: n(0.035) },
      { consumer_defensive: n(0.0475) },
      { technology: n(0.3066) },
      { communication_services: n(0.0794) },
      { financial_services: n(0.1695) },
      { utilities: n(0.0246) },
      { industrials: n(0.1062) },
      { energy: n(0.0394) },
      { healthcare: n(0.0827) },
    ],
    holdings: [
      { symbol: 'NVDA', holdingName: 'NVIDIA Corp', holdingPercent: n(0.0447908) },
      { symbol: 'AAPL', holdingName: 'Apple Inc', holdingPercent: n(0.0426907) },
      { symbol: 'MSFT', holdingName: 'Microsoft Corp', holdingPercent: n(0.0329731) },
    ],
    stockPosition: n(0.9995),
    bondPosition: n(0),
    cashPosition: n(0),
  },
};

/** IGLT.L — iShares Core UK Gilts. No equities, so no sector weightings at all. */
const iglt = {
  fundProfile: { family: 'iShares', categoryName: null, legalType: 'Exchange Traded Fund' },
  topHoldings: {
    sectorWeightings: [],
    holdings: [],
    stockPosition: n(0),
    bondPosition: n(0.9815),
    cashPosition: n(0.0185),
  },
};

describe('parsing a Yahoo fund payload', () => {
  const profile = parseFundProfile('VWRP.L', vwrp)!;

  it('labels sectors the way the equity classifier labels them', () => {
    // The whole point of the mapping: a fund's technology sleeve has to land in
    // the same bucket as a directly held NVDA, not in one spelled differently.
    expect(profile.sectorWeights).toMatchObject({
      Technology: 0.3066,
      'Financial Services': 0.1695,
      'Real Estate': 0.0184,
      'Communication Services': 0.0794,
      'Basic Materials': 0.035,
    });
  });

  it('reads the fund, not the name — VWRP is 31% technology, not "Financials"', () => {
    const ranked = Object.entries(profile.sectorWeights!).sort((a, b) => b[1] - a[1]);
    expect(ranked[0]![0]).toBe('Technology');
    expect(ranked).toHaveLength(11);
  });

  it('carries the expense ratio as a decimal, not a percent', () => {
    expect(profile.expenseRatio).toBe(0.0022);
    expect(profile.family).toBe('Vanguard Group (Ireland) Limited');
  });

  it('returns null for a symbol Yahoo has no fund data for', () => {
    expect(parseFundProfile('NVDA', {})).toBeNull();
    expect(parseFundProfile('NVDA', undefined)).toBeNull();
  });

  it('drops zero-weight sectors rather than creating empty buckets', () => {
    // A single-sector fund: Yahoo returns all eleven keys, ten of them zero.
    const smh = parseFundProfile('SMH', {
      topHoldings: {
        sectorWeightings: [
          { technology: n(1) },
          { energy: n(0) },
          { healthcare: n(0) },
          { realestate: n(0) },
        ],
        stockPosition: n(0.9994),
        cashPosition: n(0.0007),
      },
    })!;
    expect(smh.sectorWeights).toEqual({ Technology: 1 });
  });
});

describe('sector weights stored on the instrument', () => {
  it('covers a pure equity fund with its equity sectors', () => {
    const weights = fundSectorWeights(parseFundProfile('VWRP.L', vwrp)!)!;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(weights.Cash).toBeUndefined(); // 0% cash is not a bucket
  });

  it('gives a gilt tracker a Fixed Income split instead of "Unclassified"', () => {
    const weights = fundSectorWeights(parseFundProfile('IGLT.L', iglt)!)!;
    expect(weights).toEqual({ 'Fixed Income': 0.9815, Cash: 0.0185 });
  });

  it('does not let a bond sleeve be redistributed across equity sectors', () => {
    // A 60/40 fund. Yahoo's sector weights describe the equity sleeve only; if
    // they were stored raw, the grouper's normalisation would scale them back
    // up to 100% and overstate every equity sector by two thirds.
    const sixtyForty = parseFundProfile('MIXED', {
      topHoldings: {
        sectorWeightings: [{ technology: n(0.3) }, { healthcare: n(0.3) }],
        stockPosition: n(0.6),
        bondPosition: n(0.4),
        cashPosition: n(0),
      },
    })!;
    const weights = fundSectorWeights(sixtyForty)!;
    expect(weights.Technology).toBeCloseTo(0.3, 6);
    expect(weights.Healthcare).toBeCloseTo(0.3, 6);
    expect(weights['Fixed Income']).toBe(0.4);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('refuses to read a bond fund\'s issuer sectors as an equity allocation', () => {
    // VAGS.L, Vanguard Global Aggregate Bond, exactly as Yahoo returns it:
    // 100% "financial_services", because banks issue bonds. Carried through
    // literally, the exposure grid would report the fund as half financials.
    const vags = parseFundProfile('VAGS.L', {
      topHoldings: {
        sectorWeightings: [{ financial_services: n(1) }],
        stockPosition: n(0),
        bondPosition: n(0.9971),
        cashPosition: n(0.0029),
      },
    })!;
    const weights = fundSectorWeights(vags)!;
    expect(weights['Financial Services']).toBeUndefined();
    expect(weights['Fixed Income']).toBeCloseTo(1, 2);
  });

  it('states a leveraged product as shares of itself, not as 300%', () => {
    // TSM3.L, a 3x ETP: Yahoo reports 300% notional. The grouper renormalises
    // regardless, so storing 3.0 only produces a sector table reading "300%".
    const tsm3 = parseFundProfile('TSM3.L', {
      topHoldings: {
        sectorWeightings: [{ technology: n(3) }],
        stockPosition: n(3),
        cashPosition: n(0),
      },
    })!;
    const weights = fundSectorWeights(tsm3)!;
    expect(weights.Technology).toBeCloseTo(1, 6);
  });

  it('calls a commodity fund Alternatives rather than Unclassified', () => {
    // CMOC.DE, Invesco Bloomberg Commodity Carbon Tilted, as Yahoo returns it:
    // no sectors and no holdings, but 100% "other". That is a statement, not an
    // absence, and Unclassified would throw it away.
    const cmoc = parseFundProfile('CMOC.DE', {
      topHoldings: {
        sectorWeightings: [],
        stockPosition: n(0),
        bondPosition: n(0),
        cashPosition: n(0),
        otherPosition: n(1),
      },
    })!;
    expect(fundSectorWeights(cmoc)).toEqual({ Alternatives: 1 });
  });

  it('never creates a negative bucket from a leveraged fund\'s negative cash', () => {
    // 3GIS.L, a 3x short gilt ETP: cash −100%, other 200%. A negative weight
    // would corrupt the grouper's normalisation and mean nothing in a table.
    const short = parseFundProfile('3GIS.L', {
      topHoldings: {
        sectorWeightings: [],
        stockPosition: n(0),
        bondPosition: n(0),
        cashPosition: n(-1),
        otherPosition: n(2),
      },
    })!;
    const weights = fundSectorWeights(short)!;
    expect(Object.values(weights).every((w) => w > 0)).toBe(true);
    expect(weights).toEqual({ Alternatives: 1 });
  });

  it('rescales an equity sleeve that Yahoo reports on a different base', () => {
    // Yahoo sometimes reports sector weights summing to 1 while the stock
    // position is 0.85. The sectors describe 85% of the fund, not 100%.
    const profile = parseFundProfile('SKEW', {
      topHoldings: {
        sectorWeightings: [{ technology: n(0.5) }, { energy: n(0.5) }],
        stockPosition: n(0.85),
        cashPosition: n(0.15),
      },
    })!;
    const weights = fundSectorWeights(profile)!;
    expect(weights.Technology).toBeCloseTo(0.425, 6);
    expect(weights.Cash).toBe(0.15);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe('asset class from what a fund holds', () => {
  it('classifies a gilt tracker as a bond holding', () => {
    const mix = parseFundProfile('IGLT.L', iglt)!.assetMix;
    expect(assetClassFromMix(mix, 'etf')).toBe('bond');
  });

  it('leaves an equity ETF alone', () => {
    expect(assetClassFromMix(parseFundProfile('VWRP.L', vwrp)!.assetMix, 'etf')).toBe('etf');
  });

  it('never reclassifies an ordinary equity', () => {
    // An operating company that holds bonds is still an equity.
    expect(assetClassFromMix({ stock: 0, bond: 0.9, cash: 0.1, other: 0 }, 'equity')).toBe('equity');
    expect(assetClassFromMix({ stock: 0, bond: 0.9, cash: 0.1, other: 0 }, 'cash')).toBe('cash');
  });

  it('leaves an ambiguous mix where it found it', () => {
    // 50/50 is neither, and guessing would put it in the wrong grid row.
    expect(assetClassFromMix({ stock: 0.5, bond: 0.5, cash: 0, other: 0 }, 'etf')).toBe('etf');
  });
});

describe('listing region of a holding', () => {
  it('reads the suffix, and treats a bare ticker as a US listing', () => {
    expect(regionOfSymbol('NVDA')).toBe('US');
    expect(regionOfSymbol('HSBA.L')).toBe('UK');
    expect(regionOfSymbol('7203.T')).toBe('APAC');
    expect(regionOfSymbol('ASML.AS')).toBe('EU');
    expect(regionOfSymbol(null)).toBeNull();
    expect(regionOfSymbol('SOMETHING.ZZ')).toBeNull();
  });

  it('renormalises over the holdings it can resolve', () => {
    const regions = topHoldingRegions([
      { symbol: 'HSBA.L', name: 'HSBC', weight: 0.1 },
      { symbol: 'AZN.L', name: 'AstraZeneca', weight: 0.08 },
      { symbol: 'NVDA', name: 'NVIDIA', weight: 0.02 },
      { symbol: null, name: 'Unlisted', weight: 0.05 },
    ]);
    expect(regions.UK).toBeCloseTo(0.9, 6);
    expect(regions.US).toBeCloseTo(0.1, 6);
  });

  it('is empty rather than wrong when nothing resolves', () => {
    expect(topHoldingRegions([{ symbol: null, name: 'x', weight: 1 }])).toEqual({});
    expect(topHoldingRegions([])).toEqual({});
  });
});

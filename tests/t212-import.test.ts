/**
 * Trading 212 export import: the format's traps, and idempotency.
 *
 * Rows are lifted from a real export (values as printed, identifiers
 * shortened). Every expected figure below was checked against the broker's
 * own GBP `Total` column, which is the point: an inverted exchange rate on a
 * USD line is out by a factor of 1.8, and this is where it would show.
 */
import { describe, expect, it } from 'vitest';
import { dec } from '../src/lib/decimal';
import {
  classify,
  externalIdFor,
  flowNaturalKey,
  fxToGbp,
  mergeRows,
  parseT212Export,
  planInserts,
  securitiesIn,
  toLedgerEntries,
  tradeNaturalKey,
} from '../src/lib/import/t212';
import { candidateSymbols, currenciesAgree } from '../src/lib/import/resolve';

const HEADER =
  'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Stamp duty reserve tax,Currency (Stamp duty reserve tax),Currency conversion fee,Currency (Currency conversion fee)';

const ROWS = [
  'Deposit,2025-08-14 19:18:19+00:00,,,,,e0a1195c-0001,,,,,,,645.87,"GBP",,,,,,',
  'Market buy,2025-08-15 13:30:03+00:00,US0231351067,AMZN,"Amazon",,EOF37251730972,1.1647134500,232.5800000000,USD,1.35647999,,,200.00,"GBP",,,,,0.30,"GBP"',
  'Market buy,2025-08-19 07:00:32+00:00,IE00B4ND3602,SGLN,"iShares Physical Gold",,EOF37408447603,4.7549530700,4795.0000000000,GBX,100.00000000,,,228.00,"GBP",,,,,,',
  'Market buy,2025-08-19 07:00:02+00:00,IE00BYXYX745,EMID,"iShares MSCI Europe Mid Cap (Dist)",,EOF37408443274,4.4831136300,7.2610000000,EUR,1.15760626,,,28.16,"GBP",,,,,0.04,"GBP"',
  'Market buy,2025-08-19 07:00:32+00:00,IE00BK5BR733,VFEG,"Vanguard FTSE Emerging Markets (Acc)",,EOF37408447910,0.6038700200,54.7800000000,GBP,1.00000000,,,33.08,"GBP",,,,,,',
  'Market sell,2025-08-22 13:30:02+00:00,US87151X1019,SYM,"Symbotic",,EOF37601572006,2.9774111600,43.7000000000,USD,1.34219999,-18.37,"GBP",96.79,"GBP",,,,,0.15,"GBP"',
  'Dividend (Dividend),2025-09-04 12:07:34+00:00,US4039491000,DINO,"HF Sinclair",,,1.8001528500,0.425000,USD,0.74503500,,,0.57,"GBP",0.14,USD,,,,',
  'Interest on cash,2025-09-28 00:09:38+00:00,,,,"Interest on cash",7f807b6e-0002,,,,,,,0.01,"GBP",,,,,,',
  'Withdrawal,2026-07-29 18:03:01+00:00,,,,"Sent to Bank Account 00-00-00 / 00000000",019faf0b-0003,,,,,,,-950.00,"GBP",,,,,,',
];

const csv = (rows: string[]) => [HEADER, ...rows].join('\n') + '\n';

describe('parsing', () => {
  it('reads the columns by name and keeps the price currency label', () => {
    const rows = parseT212Export(csv(ROWS));
    expect(rows).toHaveLength(9);
    const sgln = rows.find((r) => r.ticker === 'SGLN')!;
    expect(sgln.priceCurrency).toBe('GBX');
    expect(sgln.id).toBe('EOF37408447603');
  });

  it('accepts the shorter header without the stamp duty columns', () => {
    const shortHeader =
      'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)';
    const row =
      'Market buy,2026-08-03 07:02:25+00:00,IE00B4KBBD01,IUUS,"iShares S&P 500 Utilities Sector (Acc)",,EOF55150628810,1.4728574100,11.0500000000,USD,1.34615999,,,12.11,"GBP",,,0.02,"GBP"';
    const [r] = parseT212Export(`${shortHeader}\n${row}\n`);
    expect(r!.conversionFee).toBe('0.02');
    expect(r!.stampDuty).toBe('');
  });

  it('rejects a file that is not a Trading 212 export', () => {
    expect(() => parseT212Export('symbol,qty,price\nAAPL,1,2\n')).toThrow(/Trading 212/);
  });

  it('classifies every action in the real export', () => {
    expect(classify('Market buy')).toBe('buy');
    expect(classify('Limit buy')).toBe('buy');
    expect(classify('Market sell')).toBe('sell');
    expect(classify('Dividend (Dividend)')).toBe('dividend');
    expect(classify('Dividend (Return of capital)')).toBe('dividend');
    expect(classify('Dividend (Tax exempted)')).toBe('dividend');
    expect(classify('Interest on cash')).toBe('interest');
    expect(classify('Deposit')).toBe('deposit');
    expect(classify('Withdrawal')).toBe('withdrawal');
    expect(classify('Card debit')).toBe('skip');
  });
});

describe('exchange rate direction', () => {
  const rows = parseT212Export(csv(ROWS));
  const by = (ticker: string) => rows.find((r) => r.ticker === ticker)!;

  it('divides on a trade: units per GBP', () => {
    // 1.35648 USD per GBP → 0.7372 GBP per USD
    expect(fxToGbp(by('AMZN'), 'buy')!.toFixed(4)).toBe('0.7372');
  });

  it('multiplies on a dividend: GBP per unit', () => {
    expect(fxToGbp(by('DINO'), 'dividend')!.toFixed(6)).toBe('0.745035');
  });

  it('lands a GBX line at exactly 1 after the pence factor', () => {
    expect(fxToGbp(by('SGLN'), 'buy')!.toFixed()).toBe('1');
  });
});

describe('ledger entries', () => {
  const rows = parseT212Export(csv(ROWS));
  const entries = toLedgerEntries(rows);
  const trade = (ticker: string) => entries.trades.find((t) => t.securityKey.startsWith(`${ticker}|`))!;

  it('reconciles every trade to the broker GBP total within 2%', () => {
    expect(entries.checked).toBe(5);
    expect(entries.mismatched).toBe(0);
    expect(entries.problems).toEqual([]);
  });

  it('converts GBX to GBP once, at the boundary', () => {
    const sgln = trade('SGLN');
    expect(sgln.price.toFixed(2)).toBe('47.95');
    expect(sgln.currency).toBe('GBP');
    expect(sgln.fxRate.toFixed()).toBe('1');
    expect(sgln.computedTotalGbp.toFixed(2)).toBe('228.00');
  });

  it('stores the FX fee in the trade currency', () => {
    const amzn = trade('AMZN');
    // £0.30 at 1.35648 USD/GBP ≈ $0.41
    expect(amzn.fxFee.toFixed(2)).toBe('0.41');
    // The broker's £200.00 is consideration plus the £0.30 fee.
    expect(amzn.computedTotalGbp.toFixed(2)).toBe('199.70');
  });

  it('keeps a EUR line in EUR', () => {
    const emid = trade('EMID');
    expect(emid.currency).toBe('EUR');
    expect(emid.computedTotalGbp.toFixed(2)).toBe('28.12'); // broker says 28.16 incl. fee
  });

  it('takes dividend gross in local currency and withholding in local currency', () => {
    const div = entries.flows.find((f) => f.kind === 'dividend')!;
    expect(div.currency).toBe('USD');
    expect(div.amount.toFixed(4)).toBe('0.7651'); // 1.80015285 × 0.425
    expect(div.withholding.toFixed(2)).toBe('0.14');
    // net in GBP ≈ broker's 0.57 - 0.14×0.745 ≈ 0.47
    expect(div.amount.minus(div.withholding).times(div.fxRate).toFixed(2)).toBe('0.47');
  });

  it('signs withdrawals negative and keeps interest and deposits positive', () => {
    const kinds = Object.fromEntries(entries.flows.map((f) => [f.kind, f.amount.toFixed(2)]));
    expect(kinds.withdrawal).toBe('-950.00');
    expect(kinds.deposit).toBe('645.87');
    expect(kinds.interest).toBe('0.01');
  });

  it('prefers the instrument row currency when the security is known', () => {
    const e = toLedgerEntries(rows, (key) => (key.startsWith('SGLN|') ? 'GBP' : undefined));
    expect(trade.call(null, 'SGLN').currency).toBe('GBP');
    expect(e.trades.find((t) => t.securityKey.startsWith('SGLN|'))!.currency).toBe('GBP');
  });

  it('flags a trade whose total disagrees with the broker', () => {
    const bad = ROWS[1]!.replace('1.35647999', '0.73720000'); // rate inverted by hand
    const e = toLedgerEntries(parseT212Export(csv([bad])));
    expect(e.mismatched).toBe(1);
    expect(e.mismatches[0]).toMatch(/AMZN/);
  });
});

describe('securities and symbol candidates', () => {
  it('keys on ticker and ISIN together', () => {
    const rows = parseT212Export(csv(ROWS));
    const s = securitiesIn(rows);
    expect(s.size).toBe(6);
    expect(s.get('SGLN|IE00B4ND3602')!.currency).toBe('GBX');
  });

  it('tries the LSE listing first for anything in pence or pounds', () => {
    expect(candidateSymbols('SGLN', 'GBX')).toEqual(['SGLN.L']);
    expect(candidateSymbols('VWRP', 'GBP')).toEqual(['VWRP.L']);
    expect(candidateSymbols('AMZN', 'USD')[0]).toBe('AMZN');
    expect(candidateSymbols('IUUS', 'USD')).toContain('IUUS.L');
  });

  it('treats GBX and GBp as the same currency', () => {
    expect(currenciesAgree('GBX', 'GBp')).toBe(true);
    expect(currenciesAgree('USD', 'GBp')).toBe(false);
    expect(currenciesAgree('USD', 'USD')).toBe(true);
  });
});

describe('idempotency', () => {
  it('drops a row that appears in two overlapping files', () => {
    const a = parseT212Export(csv(ROWS.slice(0, 5)));
    const b = parseT212Export(csv(ROWS.slice(3)));
    const merged = mergeRows([a, b]);
    expect(merged).toHaveLength(ROWS.length);
    expect(merged[0]!.action).toBe('Deposit');
  });

  it('gives a dividend a stable key even though the broker gives it no ID', () => {
    const [div] = parseT212Export(csv([ROWS[6]!]));
    expect(div!.id).toBe('');
    expect(externalIdFor(div!)).toBe(externalIdFor({ ...div! }));
    expect(externalIdFor(div!)).toContain('us4039491000');
  });

  it('matches a row by broker ID first', () => {
    const plan = planInserts(
      [{ id: 'A', key: 'k' }, { id: 'B', key: 'k' }],
      (e) => e.id,
      (e) => e.key,
      new Set(['A']),
      new Map(),
    );
    expect(plan.duplicateById).toBe(1);
    expect(plan.insert.map((e) => e.id)).toEqual(['B']);
  });

  it('matches rows recorded before IDs were kept by natural key, as a multiset', () => {
    // Ledger holds ONE such row; the upload has two identical fills.
    const plan = planInserts(
      [{ id: 'A', key: 'k' }, { id: 'B', key: 'k' }, { id: 'C', key: 'other' }],
      (e) => e.id,
      (e) => e.key,
      new Set(),
      new Map([['k', 1]]),
    );
    expect(plan.duplicateByKey).toBe(1);
    expect(plan.insert.map((e) => e.id)).toEqual(['B', 'C']);
  });

  it('normalises numeric strings in natural keys, as Postgres does', () => {
    const fromExport = tradeNaturalKey({
      instrumentId: 7,
      date: '2026-09-01',
      side: 'buy',
      quantity: dec('1.1217948700'),
      price: dec('143.5200000000'),
    });
    const fromDb = tradeNaturalKey({
      instrumentId: 7,
      date: '2026-09-01',
      side: 'buy',
      quantity: dec('1.12179487'),
      price: dec('143.52'),
    });
    expect(fromExport).toBe(fromDb);
    expect(
      flowNaturalKey({ instrumentId: null, date: '2026-08-02', kind: 'interest', amount: dec('0.370'), currency: 'GBP' }),
    ).toBe('|2026-08-02|interest|0.37|GBP');
  });
});

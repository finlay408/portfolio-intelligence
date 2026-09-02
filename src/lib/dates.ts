/**
 * Date handling. Everything is a plain 'YYYY-MM-DD' string in UTC terms —
 * no Date objects leak into the engine, because a portfolio dated by local
 * timezone silently shifts trades across day boundaries in BST.
 */
import type { IsoDate } from './types';

const MS_PER_DAY = 86_400_000;

export function toUtc(d: IsoDate): number {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
}

export function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / MS_PER_DAY);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtc(toUtc(d) + n * MS_PER_DAY);
}

export function addMonths(d: IsoDate, n: number): IsoDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return fromUtc(date.getTime());
}

/** 0 = Sunday. */
export function dayOfWeek(d: IsoDate): number {
  return new Date(toUtc(d)).getUTCDay();
}

export function isWeekend(d: IsoDate): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

/** Inclusive range. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let t = toUtc(from); t <= toUtc(to); t += MS_PER_DAY) out.push(fromUtc(t));
  return out;
}

export function eachBusinessDay(from: IsoDate, to: IsoDate, mic = 'XLON'): IsoDate[] {
  return eachDay(from, to).filter((d) => isTradingDay(d, mic));
}

/* ---------------- Market calendars ----------------
 * Enough of a calendar to roll auto-invest dates and to align return series.
 * Half-days are treated as full trading days: they have a close, which is all
 * a daily series needs.
 */

/** Anonymous Gregorian computus. Returns Easter Sunday for the given year. */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fromUtc(Date.UTC(year, month - 1, day));
}

/** nth weekday of a month, e.g. nthWeekday(2026, 1, 1, 3) = 3rd Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): IsoDate {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return fromUtc(Date.UTC(year, month - 1, 1 + shift + (n - 1) * 7));
}

function lastWeekday(year: number, month: number, weekday: number): IsoDate {
  const last = new Date(Date.UTC(year, month, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return fromUtc(Date.UTC(year, month, 0 - shift));
}

/** US federal observance: Saturday shifts back to Friday, Sunday forward to Monday. */
function usObserved(d: IsoDate): IsoDate {
  const w = dayOfWeek(d);
  if (w === 6) return addDays(d, -1);
  if (w === 0) return addDays(d, 1);
  return d;
}

const holidayCache = new Map<string, Set<IsoDate>>();

export function marketHolidays(year: number, mic: string): Set<IsoDate> {
  const cacheKey = `${mic}:${year}`;
  const hit = holidayCache.get(cacheKey);
  if (hit) return hit;

  const easter = easterSunday(year);
  const goodFriday = addDays(easter, -2);
  const out = new Set<IsoDate>();

  if (mic === 'XLON') {
    out.add(usObserved(fromUtc(Date.UTC(year, 0, 1)))); // New Year (substitute day)
    out.add(goodFriday);
    out.add(addDays(easter, 1)); // Easter Monday
    out.add(nthWeekday(year, 5, 1, 1)); // Early May
    out.add(lastWeekday(year, 5, 1)); // Spring
    out.add(lastWeekday(year, 8, 1)); // Summer
    out.add(fromUtc(Date.UTC(year, 11, 25)));
    out.add(fromUtc(Date.UTC(year, 11, 26)));
    // Christmas / Boxing Day substitute days when they land on a weekend.
    for (const d of [fromUtc(Date.UTC(year, 11, 25)), fromUtc(Date.UTC(year, 11, 26))]) {
      if (isWeekend(d)) {
        let sub = addDays(d, 1);
        while (isWeekend(sub) || out.has(sub)) sub = addDays(sub, 1);
        out.add(sub);
      }
    }
  } else {
    // US equity markets (XNAS / XNYS).
    out.add(usObserved(fromUtc(Date.UTC(year, 0, 1))));
    out.add(nthWeekday(year, 1, 1, 3)); // MLK
    out.add(nthWeekday(year, 2, 1, 3)); // Presidents' Day
    out.add(goodFriday);
    out.add(lastWeekday(year, 5, 1)); // Memorial Day
    if (year >= 2021) out.add(usObserved(fromUtc(Date.UTC(year, 5, 19)))); // Juneteenth
    out.add(usObserved(fromUtc(Date.UTC(year, 6, 4)))); // Independence Day
    out.add(nthWeekday(year, 9, 1, 1)); // Labor Day
    out.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
    out.add(usObserved(fromUtc(Date.UTC(year, 11, 25)))); // Christmas
  }

  holidayCache.set(cacheKey, out);
  return out;
}

export function isTradingDay(d: IsoDate, mic = 'XLON'): boolean {
  if (isWeekend(d)) return false;
  const year = Number(d.slice(0, 4));
  return !marketHolidays(year, mic).has(d);
}

/**
 * Roll a target date forward to the next session (CLAUDE.md §5, auto-invest).
 * Forward, never backward: an auto-invest that fires early would spend money
 * the account may not hold yet.
 */
export function rollForwardToTradingDay(d: IsoDate, mic = 'XLON'): IsoDate {
  let cur = d;
  for (let i = 0; i < 15; i++) {
    if (isTradingDay(cur, mic)) return cur;
    cur = addDays(cur, 1);
  }
  return cur;
}

/* ---------------- Period keys for attribution grids ---------------- */

export const monthKey = (d: IsoDate) => d.slice(0, 7);
export const yearKey = (d: IsoDate) => d.slice(0, 4);
export const quarterKey = (d: IsoDate) =>
  `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

/** UK tax year containing the date, e.g. '2025/26' (6 April to 5 April). */
export function ukTaxYear(d: IsoDate): string {
  const y = Number(d.slice(0, 4));
  const startOfTaxYear = `${y}-04-06`;
  const start = d >= startOfTaxYear ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

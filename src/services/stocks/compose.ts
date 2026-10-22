/**
 * The pure layer: Ghostfolio's slices in, the public /stocks/site body
 * out. No bindings, no clock — `today` is always passed in — so this is
 * where the unit tests live.
 *
 * What ships is how the portfolio moved, never what it is worth: a growth
 * index per account (the time-weighted return, 1 at the account's first
 * day), each holding's share of its account, and the public daily closes
 * of the holdings and of the benchmark, and per position the average
 * price paid per share and the day it was first bought. No amount,
 * quantity or individual trade is in it, and none can be derived from
 * it: an index is blind to money moving in and out by construction, and
 * a per-share price without a share count is not a sum.
 *
 * The index chains daily returns. A day's return is the day's gain over
 * the capital at work that day — the previous close plus whatever was put
 * in that day:
 *
 *   r(t) = (gain(t) − gain(t−1)) / (value(t−1) + max(0, invested(t)))
 *
 * Ghostfolio's gain already nets fees and counts realised gains and
 * dividends, so a sale or a payout moves the index by what it earned and
 * a deposit moves it not at all. Unlike Ghostfolio's own percentages, the
 * result is cut to any range by dividing two of its values, and compares
 * with an index fund's price line directly.
 */

import { DATE_RE } from "../../lib/http";
import type { GfAccount, GfCloses, GfDay, GfHolding } from "./ghostfolio";

export const SITE_VERSION = 3;

/** What the page compares the portfolio with: an S&P 500 fund's closes
 *  (price return, so it slightly understates the index with dividends). */
export const BENCHMARK = { dataSource: "YAHOO", symbol: "VOO", label: "S&P 500" } as const;

/** Days kept at daily resolution, counted back from the last one; older
 *  days thin to one a week, which is all a multi-year line can draw. */
export const DAILY_DAYS = 366;

/** Capital below this (in the base currency) earns no return: a day that
 *  starts from dust would turn a cent of rounding, or a one-dollar
 *  position going to zero, into the account's whole history. An account
 *  that only ever held dust before (Schwab's first months) starts its
 *  index the day real money went in. */
export const MIN_CAPITAL = 100;

/** Where the holdings trade, and when its regular session opens there. */
const MARKET_TIME_ZONE = "America/New_York";
const SESSION_OPEN_MINUTE = 9 * 60 + 30;

const marketClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

/**
 * The market day the latest price belongs to: the New York date once that
 * day's session has opened, otherwise the weekday before. Holidays are not
 * known here; one reads as a day the market held still.
 */
export function marketSession(at: Date): string {
  const parts = new Map(marketClock.formatToParts(at).map(({ type, value }) => [type, value]));
  const date = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const minute = Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
  const weekday = parts.get("weekday");
  let back = weekday === "Sat" ? 1 : weekday === "Sun" ? 2 : 0;
  if (back === 0 && minute < SESSION_OPEN_MINUTE) back = weekday === "Mon" ? 3 : 1;
  return shift(date, -back);
}

/**
 * Ghostfolio buckets its chart by the server's calendar (Asia/Shanghai)
 * and values its last day at the live quote. A US session closes in the
 * Shanghai night, so from midnight until the next open that last day is
 * the previous session again under a later date: a flat step at the end
 * of every line, and a day's move printed as 0.00% all day. So every day
 * from `session` on is folded into one day dated `session`: the latest
 * value and gain, with the money put in across them.
 */
export function toSessions(chart: GfDay[], session: string): GfDay[] {
  const at = chart.findIndex((day) => day.date >= session);
  if (at === -1 || chart.at(-1)?.date === session) return chart;
  const tail = chart.slice(at);
  const last = tail[tail.length - 1];
  return [
    ...chart.slice(0, at),
    {
      date: session,
      value: last.value,
      netPerformance: last.netPerformance,
      investment: tail.reduce((sum, day) => sum + day.investment, 0),
    },
  ];
}

export interface SiteHolding {
  symbol: string;
  /** Share of the account, cash included, 0–1. */
  weight: number;
  /** The position's return over its life in this account — a ratio of
   *  gain to money put in, so it says nothing of either. */
  performance: number | null;
  /** Average price paid per share in this account, in the symbol's
   *  currency; null when Ghostfolio cannot say. */
  cost: number | null;
  /** The first buy in this account, a calendar day. */
  since: string | null;
}

/** Cash in one currency, and its share of the account. */
export interface SiteCash {
  currency: string;
  weight: number;
}

export interface SiteAccount {
  /** `all` for the whole portfolio, otherwise a slug of the name. */
  id: string;
  name: string;
  /** The broker's logo; null for the whole portfolio and for an account
   *  with no platform (or none found). */
  logo: string | null;
  /** Growth index on `days`: 1 on the account's first day, null before. */
  index: (number | null)[];
  /** Most weight first; cash is `cash`, not a holding. */
  holdings: SiteHolding[];
  /** Most weight first. */
  cash: SiteCash[];
}

export interface SiteSymbol {
  symbol: string;
  name: string;
  /** ISO 4217, what `closes` are in. */
  currency: string;
  kind: "stock" | "etf" | "other";
  logo: string | null;
  /** A stock's sector (Ghostfolio's names); null for a fund. */
  sector: string | null;
  /** ISO 3166 alpha-2, where it is mostly listed or based. */
  country: string | null;
  /** The company's site, https only. */
  url: string | null;
  /** Close on each of `days`, carried over holidays; null before the
   *  first close Ghostfolio has. */
  closes: (number | null)[];
}

export interface Site {
  schemaVersion: number;
  today: string;
  /** Market days, oldest first: daily for the last DAILY_DAYS, weekly
   *  before. The last one is the session the latest quotes belong to —
   *  a New York date, which can be a day behind `today`. */
  days: string[];
  benchmark: { symbol: string; label: string; closes: (number | null)[] };
  /** The whole portfolio first, then each account holding something. */
  accounts: SiteAccount[];
  /** Every holding of the whole portfolio, in its weight order. */
  symbols: SiteSymbol[];
}

export interface Upstream {
  portfolio: { chart: GfDay[]; holdings: GfHolding[] };
  accounts: { account: GfAccount; chart: GfDay[]; holdings: GfHolding[] }[];
  /** Keyed by symbol. A symbol missing here ships with no closes. */
  closes: Map<string, GfCloses>;
  benchmark: GfCloses;
}

/** The growth index by day, from the day before capital first went in
 *  (the base, 1) to the chart's end. Empty when nothing was ever held. */
export function growthIndex(chart: GfDay[]): Map<string, number> {
  const index = new Map<string, number>();
  let level = 0;
  for (let i = 1; i < chart.length; i++) {
    const before = chart[i - 1];
    const day = chart[i];
    const capital = before.value + Math.max(0, day.investment);
    if (level === 0) {
      if (capital < MIN_CAPITAL) continue;
      level = 1;
      index.set(before.date, 1);
    }
    const gain = day.netPerformance - before.netPerformance;
    if (capital >= MIN_CAPITAL) level *= 1 + gain / capital;
    index.set(day.date, level);
  }
  return index;
}

/** Monday to Friday, read from the date alone. */
const isWeekday = (day: string) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

/** Monday of the day's week, as a key. */
const weekOf = (day: string) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};

const shift = (day: string, delta: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};

/**
 * The axis: the portfolio's indexed days, weekends dropped (a market
 * holds still on them, and a flat step every week is noise) except the
 * base, then thinned to the last day of each week before the daily
 * window.
 */
export function axis(indexed: string[]): string[] {
  const days = indexed.filter((day, i) => i === 0 || isWeekday(day));
  const last = days.at(-1);
  if (!last) return [];
  const cutoff = shift(last, -DAILY_DAYS);
  return days.filter(
    (day, i) =>
      i === 0 || day >= cutoff || i === days.length - 1 || weekOf(day) !== weekOf(days[i + 1])
  );
}

/** Six decimals: a growth index, below any return the page prints. */
const roundIndex = (value: number) => Math.round(value * 1e6) / 1e6;

/** Six significant digits: any share price, to the cent and beyond. */
const roundPrice = (value: number) => Number(value.toPrecision(6));

const roundWeight = (value: number) => Math.round(value * 1e4) / 1e4;

/** The index on each axis day, carried over a day the account's chart
 *  skips; null before it starts. */
function alignIndex(days: string[], index: Map<string, number>): (number | null)[] {
  let last: number | null = null;
  return days.map((day) => {
    const value = index.get(day);
    if (value !== undefined) last = value;
    return last === null ? null : roundIndex(last);
  });
}

/**
 * The close on each axis day: the latest close on or before it, so a
 * holiday carries the day before. The last day is the session the live
 * quote belongs to, priced at that quote, as the portfolio's is.
 */
export function alignCloses(
  days: string[],
  series: GfCloses | undefined,
  session: string
): (number | null)[] {
  if (!series) return days.map(() => null);
  const closes = new Map(series.closes.map(({ date, close }) => [date, close]));
  if (days.at(-1) === session) closes.set(session, series.marketPrice);
  const dated = [...closes].sort(([a], [b]) => a.localeCompare(b));
  let at = 0;
  let last: number | null = null;
  return days.map((day) => {
    while (at < dated.length && dated[at][0] <= day) last = dated[at++][1];
    return last === null ? null : roundPrice(last);
  });
}

/** `Interactive Brokers` → `interactive-brokers`; never `all`, and
 *  unique among the ones already taken. */
export function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "account";
  let id = base === "all" ? "all-account" : base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Holdings by weight, cash split off by currency. */
function weigh(holdings: GfHolding[]): { holdings: SiteHolding[]; cash: SiteCash[] } {
  const cash = new Map<string, number>();
  const held: SiteHolding[] = [];
  for (const holding of holdings) {
    if (holding.cash) {
      cash.set(holding.currency, (cash.get(holding.currency) ?? 0) + holding.weight);
    } else if (holding.weight > 0) {
      held.push({
        symbol: holding.symbol,
        weight: roundWeight(holding.weight),
        performance: holding.performance === null ? null : roundIndex(holding.performance),
        cost: holding.cost === null ? null : roundPrice(holding.cost),
        since: holding.since,
      });
    }
  }
  held.sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
  return {
    holdings: held,
    cash: [...cash]
      .map(([currency, weight]) => ({ currency, weight: roundWeight(weight) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.currency.localeCompare(b.currency)),
  };
}

const kindOf = (subClass: string | null): SiteSymbol["kind"] =>
  subClass === "STOCK" ? "stock" : subClass === "ETF" ? "etf" : "other";

/** Every non-cash holding, in the portfolio's weight order, once. */
export function heldSymbols(holdings: GfHolding[]): GfHolding[] {
  const seen = new Map<string, GfHolding>();
  for (const holding of holdings) {
    if (!holding.cash && holding.weight > 0 && !seen.has(holding.symbol)) {
      seen.set(holding.symbol, holding);
    }
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
}

/** How many days of closes to ask for: back to the portfolio's base. */
export function historyDays(chart: GfDay[], today: string): number {
  const first = chart.find((day) => DATE_RE.test(day.date))?.date ?? today;
  const span = Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000);
  return Math.max(30, span + 7);
}

/** Mirrored logo URLs: holdings by symbol, brokers by account id. */
export interface Logos {
  symbols: ReadonlyMap<string, string | null>;
  accounts: ReadonlyMap<string, string | null>;
}

export function composeSite(
  upstream: Upstream,
  logos: Logos,
  today: string,
  session: string
): Site {
  const whole = growthIndex(toSessions(upstream.portfolio.chart, session));
  const days = axis([...whole.keys()]);
  if (days.length < 2) throw new Error("Ghostfolio portfolio has no history yet");

  const taken = new Set(["all"]);
  const accounts: SiteAccount[] = [
    {
      id: "all",
      name: "All accounts",
      logo: null,
      index: alignIndex(days, whole),
      ...weigh(upstream.portfolio.holdings),
    },
  ];
  for (const { account, chart, holdings } of upstream.accounts) {
    const weighed = weigh(holdings);
    const index = growthIndex(toSessions(chart, session));
    if (index.size === 0 || (weighed.holdings.length === 0 && weighed.cash.length === 0)) continue;
    accounts.push({
      id: slug(account.name, taken),
      name: account.name,
      logo: logos.accounts.get(account.id) ?? null,
      index: alignIndex(days, index),
      ...weighed,
    });
  }

  return {
    schemaVersion: SITE_VERSION,
    today,
    days,
    benchmark: {
      symbol: BENCHMARK.symbol,
      label: BENCHMARK.label,
      closes: alignCloses(days, upstream.benchmark, session),
    },
    accounts,
    symbols: heldSymbols(upstream.portfolio.holdings).map((holding) => ({
      symbol: holding.symbol,
      name: holding.name,
      currency: holding.currency,
      kind: kindOf(holding.subClass),
      logo: logos.symbols.get(holding.symbol) ?? null,
      sector: holding.sector,
      country: holding.country,
      url: holding.url,
      closes: alignCloses(days, upstream.closes.get(holding.symbol), session),
    })),
  };
}

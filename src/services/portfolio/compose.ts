/**
 * The pure layer: the ledger's and the prices' slices in, the public
 * /portfolio/site body out. No bindings, no clock — `today` is always
 * passed in — so this is where the unit tests live.
 *
 * What ships is how the portfolio did, never what it is worth. Per
 * account, two series on the axis: its value (holdings and cash) and the
 * money put into it to date, both divided by the most ever put in, so
 * they are ratios on one scale and no amount survives. Every return the
 * page prints is one of them divided by the other:
 *
 *   return over a range = the range's gain
 *                         ÷ (the value it started from + money put in since)
 *
 * — what the money did, which a deposit cannot move — and the same
 * formula over one session is that day's time-weighted return, which the
 * page chains for its day cells and its drawdown. Beside them: each
 * holding's share of its account and the average price paid per share
 * (from the ledger), what each symbol is and its public daily closes and
 * the benchmark's (from Ghostfolio), and each account's best days. No
 * quantity, trade or amount is in it.
 */

import type { GfCloses, GfProfile } from "./ghostfolio";
import type { WfAccount, WfCash, WfDay, WfHolding, WfHoldings } from "./wealthfolio";

export const SITE_VERSION = 6;

/** What the page compares the portfolio with: an S&P 500 fund's closes
 *  (price return, so it slightly understates the index with dividends). */
export const BENCHMARK = { symbol: "VOO", label: "S&P 500" } as const;

/** Days kept at daily resolution, counted back from the last one; older
 *  days thin to one a week, which is all a multi-year line can draw. */
export const DAILY_DAYS = 366;

/** Capital below this (in the base currency) earns no return: a day that
 *  starts from dust would turn a cent of rounding, or a one-dollar
 *  position going to zero, into the account's whole history. An account
 *  that only ever held dust before starts the day real money went in. */
export const MIN_CAPITAL = 100;

/** The one currency whose cash the page shows. The rest is what a broker
 *  leaves behind (IBKR's CNH interest, an HKD conversion's change): too
 *  little to read as a position, so it is left out of the weights too. */
export const CASH_CURRENCY = "USD";

/** How each account shows on the page — a short name, and the broker's
 *  site for its logo — keyed by its name in Wealthfolio. An account not
 *  here keeps its own name and goes without a logo. */
export const BROKERS: Readonly<Record<string, { name: string; domain: string }>> = {
  "Interactive Brokers": { name: "IBKR", domain: "interactivebrokers.com" },
  "Charles Schwab": { name: "Schwab", domain: "schwab.com" },
  HSBC: { name: "HSBC", domain: "hsbc.com.hk" },
};

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
 * Wealthfolio dates its valuations by the server's calendar
 * (Asia/Shanghai) and values the last one at the latest quote. A US
 * session closes in the Shanghai night, so from midnight until the next
 * open that last day is the previous session again under a later date: a
 * flat step at the end of every line. So every day from `session` on is
 * folded into one day dated `session`, carrying the latest value and
 * contribution.
 */
export function toSessions(history: WfDay[], session: string): WfDay[] {
  const at = history.findIndex((day) => day.date >= session);
  const last = history.at(-1);
  if (at === -1 || !last || last.date === session) return history;
  return [...history.slice(0, at), { ...last, date: session }];
}

/**
 * One day's return on the money at work: the gain over the previous
 * close plus whatever was put in that day (money taken out is added back
 * to the close). Null on dust (`MIN_CAPITAL`).
 */
export function dayReturn(before: WfDay, day: WfDay): number | null {
  const flow = day.invested - before.invested;
  const base = before.value + Math.max(0, flow);
  return base < MIN_CAPITAL ? null : (day.value + Math.max(0, -flow)) / base - 1;
}

/** The daily returns chained, by day, from the day before capital first
 *  went in (the base, 1). Empty when nothing was ever held. It dates the
 *  account's start and finds its best days; the page chains the same
 *  returns off the shipped series. */
export function growthIndex(history: WfDay[]): Map<string, number> {
  const index = new Map<string, number>();
  let level = 0;
  for (let i = 1; i < history.length; i++) {
    const change = dayReturn(history[i - 1], history[i]);
    if (level === 0) {
      if (change === null) continue;
      level = 1;
      index.set(history[i - 1].date, 1);
    }
    if (change !== null) level *= 1 + change;
    index.set(history[i].date, level);
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
 *
 * Thinning keeps every day money moved in any of `ledgers` (the day its
 * `invested` differs from the axis day before) and the axis day before
 * it. The page reads the money in and out off adjacent axis days, so
 * between two kept days there is at most one movement, on the later one,
 * opening a one-day step: what was put in since a range's start, each
 * day's return and the benchmark bought with the same money all come
 * out as they do from the daily days. A week's withdrawal and deposit
 * folded into one step would net out — and read as gain or loss.
 */
export function axis(indexed: string[], ledgers: WfDay[][] = []): string[] {
  const days = indexed.filter((day, i) => i === 0 || isWeekday(day));
  const last = days.at(-1);
  if (!last) return [];
  const cutoff = shift(last, -DAILY_DAYS);
  const kept = new Set<number>();
  for (const history of ledgers) {
    const invested = investedOn(days, history);
    for (let i = 1; i < days.length; i++) {
      if (invested[i] !== invested[i - 1]) kept.add(i).add(i - 1);
    }
  }
  return days.filter(
    (day, i) =>
      i === 0 ||
      day >= cutoff ||
      i === days.length - 1 ||
      kept.has(i) ||
      weekOf(day) !== weekOf(days[i + 1])
  );
}

/** The money in on each day: the latest entry on or before it, null
 *  before the history starts. */
function investedOn(days: string[], history: WfDay[]): (number | null)[] {
  let at = 0;
  let last: number | null = null;
  return days.map((day) => {
    while (at < history.length && history[at].date <= day) last = history[at++].invested;
    return last;
  });
}

/** One market day's return. */
export interface SiteMove {
  date: string;
  change: number;
}

/**
 * The best days on record, newest first: walking back from the latest
 * session, each day that beat every one after it. The best day after any
 * session is then the earliest of these dated after it, so the page finds
 * a range's best day with one lookup, at daily resolution even where the
 * axis has thinned to weekly. Weekends drop out as they do from the axis,
 * so a move made over one counts on the Monday.
 */
export function bestDays(index: Map<string, number>): SiteMove[] {
  const days = [...index].filter(([day], i) => i === 0 || isWeekday(day));
  const best: SiteMove[] = [];
  let top = Number.NEGATIVE_INFINITY;
  for (let i = days.length - 1; i > 0; i--) {
    const change = days[i][1] / days[i - 1][1] - 1;
    if (change > top) {
      top = change;
      best.push({ date: days[i][0], change: round6(change) });
    }
  }
  return best;
}

/** Six decimals: a ratio or a return, below anything the page prints. */
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Six significant digits: any share price, to the cent and beyond. */
const roundPrice = (value: number) => Number(value.toPrecision(6));

const roundWeight = (value: number) => Math.round(value * 1e4) / 1e4;

/**
 * An account's value and the money in it on each axis day, divided by the
 * most it ever had in, from its start (the index's base) — null before.
 * A day the account's history skips carries the one before.
 */
export function capital(
  days: string[],
  history: WfDay[],
  start: string
): { value: (number | null)[]; invested: (number | null)[] } {
  const held = history.filter((day) => day.date >= start);
  const scale = Math.max(...held.map((day) => day.invested));
  if (!(scale > 0)) throw new Error("account has no money in it");
  let at = 0;
  let last: WfDay | null = null;
  const value: (number | null)[] = [];
  const invested: (number | null)[] = [];
  for (const day of days) {
    while (at < held.length && held[at].date <= day) last = held[at++];
    value.push(last === null ? null : round6(last.value / scale));
    invested.push(last === null ? null : round6(last.invested / scale));
  }
  return { value, invested };
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

export interface SiteHolding {
  symbol: string;
  /** Share of the account, cash included, 0–1. */
  weight: number;
  /** The position's return over its life in this account — gain over
   *  what went into it, so it says nothing of either. */
  performance: number | null;
  /** Average price paid per share in this account, in the symbol's
   *  currency; null when the ledger has no cost for it. */
  cost: number | null;
  /** The first buy in this account, a calendar day. */
  since: string | null;
}

/** Cash in one currency, and its share of the account. */
export interface SiteCash {
  currency: string;
  weight: number;
}

/** Holdings and cash, each as a share of everything in the account;
 *  only `CASH_CURRENCY` cash counts. */
export function weigh(
  { holdings, total }: WfHoldings,
  cash: WfCash[]
): { holdings: SiteHolding[]; cash: SiteCash[] } {
  const kept = cash.filter((entry) => entry.currency === CASH_CURRENCY);
  const whole = total + kept.reduce((sum, entry) => sum + entry.value, 0);
  const share = (value: number) => (whole > 0 ? roundWeight(value / whole) : 0);
  const byCurrency = new Map<string, number>();
  for (const entry of kept) {
    byCurrency.set(entry.currency, (byCurrency.get(entry.currency) ?? 0) + entry.value);
  }
  return {
    holdings: holdings
      .map((holding) => ({
        symbol: holding.symbol,
        weight: share(holding.value),
        performance: holding.performance === null ? null : round6(holding.performance),
        cost: holding.cost === null ? null : roundPrice(holding.cost),
        since: holding.since,
      }))
      .filter((holding) => holding.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol)),
    cash: [...byCurrency]
      .map(([currency, value]) => ({ currency, weight: share(value) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.currency.localeCompare(b.currency)),
  };
}

export interface SiteAccount {
  /** `all` for the whole portfolio, otherwise a slug of the name. */
  id: string;
  name: string;
  /** The broker's logo; null for the whole portfolio and for an account
   *  `BROKERS` does not know (or whose logo was not found). */
  logo: string | null;
  /** Value on `days` (holdings and cash) over the most ever put in; null
   *  before the account's start. */
  value: (number | null)[];
  /** Money put in to date, net, on the same scale and days. */
  invested: (number | null)[];
  /** Its best days on record (`bestDays`), newest first. */
  best: SiteMove[];
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
  kind: GfProfile["kind"];
  logo: string | null;
  /** A stock's sector; null for a fund. */
  sector: string | null;
  /** ISO 3166 alpha-2, where it is mostly based. */
  country: string | null;
  /** The company's site, https only. */
  url: string | null;
  /** Close on each of `days`, carried over holidays; null before the
   *  first close there is. */
  closes: (number | null)[];
}

export interface Site {
  schemaVersion: number;
  today: string;
  /** Market days, oldest first: daily for the last DAILY_DAYS, weekly
   *  before (plus every day money moved and the day before it). The last one is the session the latest quotes belong to —
   *  a New York date, which can be a day behind `today`. */
  days: string[];
  benchmark: { symbol: string; label: string; closes: (number | null)[] };
  /** The whole portfolio first, then each account holding something. */
  accounts: SiteAccount[];
  /** Every holding of the whole portfolio, in its weight order. */
  symbols: SiteSymbol[];
}

/** An account's slices of the ledger. */
export interface Ledger {
  days: WfDay[];
  holdings: WfHoldings;
  cash: WfCash[];
}

export interface Upstream {
  portfolio: Ledger;
  accounts: (Ledger & { account: WfAccount })[];
  /** Keyed by symbol; one Ghostfolio does not hold ships as `other`,
   *  under the ledger's name, with nothing else said of it. */
  profiles: ReadonlyMap<string, GfProfile>;
  /** Keyed by symbol. A symbol missing here ships with no closes. */
  closes: ReadonlyMap<string, GfCloses>;
  benchmark: GfCloses;
}

/** Every holding, heaviest first, once. */
export function heldSymbols(holdings: WfHolding[]): WfHolding[] {
  const seen = new Map<string, WfHolding>();
  for (const holding of holdings) {
    if (holding.value > 0 && !seen.has(holding.symbol)) seen.set(holding.symbol, holding);
  }
  return [...seen.values()].sort((a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol));
}

/** How many days of closes to ask for: back to the portfolio's start. */
export function historyDays(history: WfDay[], today: string): number {
  const first = history[0]?.date ?? today;
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
  const portfolio = toSessions(upstream.portfolio.days, session);
  const histories = upstream.accounts.map((ledger) => toSessions(ledger.days, session));
  const whole = growthIndex(portfolio);
  const days = axis([...whole.keys()], [portfolio, ...histories]);
  if (days.length < 2) throw new Error("Wealthfolio portfolio has no history yet");

  const account = (history: WfDay[], index: Map<string, number>) => {
    const [start] = index.keys();
    return { ...capital(days, history, start), best: bestDays(index) };
  };

  const taken = new Set(["all"]);
  const accounts: SiteAccount[] = [
    {
      id: "all",
      name: "All accounts",
      logo: null,
      ...account(portfolio, whole),
      ...weigh(upstream.portfolio.holdings, upstream.portfolio.cash),
    },
  ];
  for (const [i, ledger] of upstream.accounts.entries()) {
    const history = histories[i];
    const index = growthIndex(history);
    const weighed = weigh(ledger.holdings, ledger.cash);
    if (index.size === 0 || (weighed.holdings.length === 0 && weighed.cash.length === 0)) continue;
    const name = BROKERS[ledger.account.name]?.name ?? ledger.account.name;
    accounts.push({
      id: slug(name, taken),
      name,
      logo: logos.accounts.get(ledger.account.id) ?? null,
      ...account(history, index),
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
    symbols: heldSymbols(upstream.portfolio.holdings.holdings).map((holding) => {
      const profile = upstream.profiles.get(holding.symbol);
      return {
        symbol: holding.symbol,
        name: profile?.name ?? holding.name,
        currency: holding.currency,
        kind: profile?.kind ?? "other",
        logo: logos.symbols.get(holding.symbol) ?? null,
        sector: profile?.sector ?? null,
        country: profile?.country ?? null,
        url: profile?.url ?? null,
        closes: alignCloses(days, upstream.closes.get(holding.symbol), session),
      };
    }),
  };
}

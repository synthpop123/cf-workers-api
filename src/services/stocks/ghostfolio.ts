/**
 * The slice of the self-hosted Ghostfolio (`GHOSTFOLIO_URL`) this Worker
 * reads, and the calls that fetch it.
 *
 * It signs in as a bot user (`GHOSTFOLIO_TOKEN`, that user's security
 * token) and reads the owner's portfolio through the access the owner
 * granted it (`GHOSTFOLIO_ACCESS_ID`, sent as `Impersonation-Id`). The
 * grant is read-only — it cannot change an activity or an account — but it
 * does carry `portfolio:read:values`: the daily time-weighted return is
 * computed here from money amounts (`compose.ts`), which a restricted
 * grant would redact. So the amounts reach this file and stop at it: every
 * type below is the narrowed slice the composition reads, and the payload
 * is built from returns, weights and public prices only.
 *
 * Ghostfolio's own percentages (ROAI, ROI) are not read at all: neither
 * chains from day to day, so neither can be cut to a range or compared
 * with an index.
 */

import { fetchOk, TIME_ZONE } from "../../lib/http";
import { isNumber, isRecord, textOrNull } from "../../lib/narrow";

/** Ghostfolio computes a portfolio's chart on request; a cold one takes
 *  seconds, so its calls get longer than the usual upstream timeout. */
const GHOSTFOLIO_TIMEOUT_MS = 20_000;

export interface GfAccount {
  id: string;
  name: string;
  /** The broker's site, from the account's platform, when it has one. */
  platformUrl: string | null;
}

/** One calendar day of a portfolio's chart, in its base currency. */
export interface GfDay {
  date: string;
  /** Market value of the holdings at the day's close. */
  value: number;
  /** Cumulative gain to date — realised and unrealised, net of fees,
   *  dividends included. Its day-to-day change is the day's gain. */
  netPerformance: number;
  /** Net money put into holdings that day (buys minus sells, at cost). */
  investment: number;
}

export interface GfHolding {
  symbol: string;
  dataSource: string;
  name: string;
  /** ISO 4217, the currency it is quoted in. */
  currency: string;
  /** Ghostfolio's `assetSubClass` (`STOCK`, `ETF`, `CASH`, …). */
  subClass: string | null;
  /** Cash in an account, which Ghostfolio lists as a holding. */
  cash: boolean;
  /** Share of the (filtered) portfolio, 0–1. */
  weight: number;
  /** The position's return over its whole life, as Ghostfolio reports it
   *  under the owner's chosen calculation (ROI, ROAI): realised and
   *  unrealised gain, dividends and fees, in the base currency. */
  performance: number | null;
}

export interface GfCloses {
  /** The latest quote, which the chart's last day is valued at. */
  marketPrice: number;
  closes: { date: string; close: number }[];
}

export interface Ghostfolio {
  accounts(): Promise<GfAccount[]>;
  /** The whole history of the portfolio, or of one account. */
  chart(accountId?: string): Promise<GfDay[]>;
  /** Positions held now, or in one account. */
  holdings(accountId?: string): Promise<GfHolding[]>;
  /** Daily closes for the last `days` days. */
  closes(dataSource: string, symbol: string, days: number): Promise<GfCloses>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

const day = (value: unknown): string | null =>
  typeof value === "string" && DAY_RE.test(value) ? value.slice(0, 10) : null;

function narrowAccounts(body: unknown): GfAccount[] {
  if (!isRecord(body) || !Array.isArray(body.accounts)) {
    throw new Error("Ghostfolio accounts have no list");
  }
  return body.accounts.map((account) => {
    const id = isRecord(account) ? textOrNull(account.id) : null;
    const name = isRecord(account) ? textOrNull(account.name) : null;
    if (!id || !name) throw new Error("Ghostfolio account without id or name");
    const platform = isRecord(account) && isRecord(account.platform) ? account.platform : null;
    return { id, name, platformUrl: platform ? textOrNull(platform.url) : null };
  });
}

function narrowChart(body: unknown): GfDay[] {
  if (!isRecord(body) || !Array.isArray(body.chart)) {
    throw new Error("Ghostfolio performance has no chart");
  }
  return body.chart.map((item) => {
    if (!isRecord(item)) throw new Error("Ghostfolio chart item is not an object");
    const date = day(item.date);
    const { valueWithCurrencyEffect: value, netPerformanceWithCurrencyEffect: net } = item;
    // Absent on a grant without `portfolio:read:values`, or a renamed
    // field: either way there is no return to compute.
    if (!date || !isNumber(value) || !isNumber(net)) {
      throw new Error("Ghostfolio chart item lacks a date, value or gain");
    }
    const investment = item.investmentValueWithCurrencyEffect;
    return { date, value, netPerformance: net, investment: isNumber(investment) ? investment : 0 };
  });
}

function narrowHoldings(body: unknown): GfHolding[] {
  if (!isRecord(body) || !Array.isArray(body.holdings)) {
    throw new Error("Ghostfolio holdings have no list");
  }
  return body.holdings.map((holding) => {
    const profile = isRecord(holding) ? holding.assetProfile : null;
    if (!isRecord(holding) || !isRecord(profile)) {
      throw new Error("Ghostfolio holding without an asset profile");
    }
    const symbol = textOrNull(profile.symbol);
    const dataSource = textOrNull(profile.dataSource);
    const currency = textOrNull(profile.currency);
    const weight = holding.allocationInPercentage;
    if (!symbol || !dataSource || !currency || !isNumber(weight)) {
      throw new Error("Ghostfolio holding lacks a symbol, source, currency or allocation");
    }
    const subClass = textOrNull(profile.assetSubClass);
    return {
      symbol,
      dataSource,
      name: textOrNull(profile.name) ?? symbol,
      currency,
      subClass,
      cash: textOrNull(profile.assetClass) === "LIQUIDITY" || subClass === "CASH",
      weight,
      performance: isNumber(holding.netPerformancePercentWithCurrencyEffect)
        ? holding.netPerformancePercentWithCurrencyEffect
        : null,
    };
  });
}

function narrowCloses(body: unknown): GfCloses {
  if (!isRecord(body) || !isNumber(body.marketPrice) || !Array.isArray(body.historicalData)) {
    throw new Error("Ghostfolio symbol has no price or history");
  }
  const closes: GfCloses["closes"] = [];
  for (const item of body.historicalData) {
    const date = isRecord(item) ? day(item.date) : null;
    if (date && isRecord(item) && isNumber(item.value) && item.value > 0) {
      closes.push({ date, close: item.value });
    }
  }
  return { marketPrice: body.marketPrice, closes };
}

/** Sign in and return a reader bound to the granted portfolio. */
export async function connect(env: Env): Promise<Ghostfolio> {
  const base = env.GHOSTFOLIO_URL;
  const signal = () => AbortSignal.timeout(GHOSTFOLIO_TIMEOUT_MS);

  const auth = await fetchOk("Ghostfolio auth", new URL("/api/v1/auth/anonymous", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: env.GHOSTFOLIO_TOKEN }),
    signal: signal(),
  });
  const authBody: unknown = await auth.json();
  const jwt = isRecord(authBody) ? textOrNull(authBody.authToken) : null;
  if (!jwt) throw new Error("Ghostfolio auth returned no token");

  const get = async (name: string, path: string, query: Record<string, string> = {}) => {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchOk(`Ghostfolio ${name}`, url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jwt}`,
        "Impersonation-Id": env.GHOSTFOLIO_ACCESS_ID,
        // Ghostfolio buckets the chart's days in this zone, like every
        // other calendar day in the system.
        Timezone: TIME_ZONE,
      },
      signal: signal(),
    });
    return (await response.json()) as unknown;
  };
  const scoped = (accountId?: string): Record<string, string> =>
    accountId ? { accounts: accountId } : {};

  return {
    accounts: async () => narrowAccounts(await get("accounts", "/api/v1/account")),
    chart: async (accountId) =>
      narrowChart(
        await get("performance", "/api/v2/portfolio/performance", {
          range: "max",
          ...scoped(accountId),
        })
      ),
    holdings: async (accountId) =>
      narrowHoldings(
        await get("holdings", "/api/v1/portfolio/holdings", {
          holdingType: "ACTIVE",
          ...scoped(accountId),
        })
      ),
    closes: async (dataSource, symbol, days) =>
      narrowCloses(
        await get(
          `closes ${symbol}`,
          `/api/v1/symbol/${encodeURIComponent(dataSource)}/${encodeURIComponent(symbol)}`,
          { includeHistoricalData: String(days) }
        )
      ),
  };
}

/**
 * The securities: the self-hosted Ghostfolio (`GHOSTFOLIO_URL`), which the
 * owner keeps alongside Wealthfolio, answers what each held symbol is and
 * what it closed at. The money — values, contributions, weights, costs —
 * is Wealthfolio's (`wealthfolio.ts`); nothing here is an amount.
 *
 * It signs in as a bot user (`GHOSTFOLIO_TOKEN`, that user's security
 * token) and reads the owner's holdings through the read-only access the
 * owner granted it (`GHOSTFOLIO_ACCESS_ID`, sent as `Impersonation-Id`),
 * for their asset profiles only: Ghostfolio's public asset endpoint hides
 * a profile's sectors, countries and site from anyone but an admin.
 * Closes are public and need no grant.
 */

import { fetchOk, TIME_ZONE } from "../../lib/http";
import { isNumber, isRecord, textOrNull } from "../../lib/narrow";

/** Ghostfolio computes holdings and cold histories on request; give it
 *  longer than the usual upstream timeout. */
const GHOSTFOLIO_TIMEOUT_MS = 20_000;

/** What a symbol is asked for under when Ghostfolio does not hold it. */
export const DATA_SOURCE = "YAHOO";

/** What a held symbol is, from its asset profile. */
export interface GfProfile {
  symbol: string;
  dataSource: string;
  name: string;
  kind: "stock" | "etf" | "other";
  /** A stock's sector; null for a fund, whose sectors are a blend. */
  sector: string | null;
  /** ISO 3166 alpha-2 of the country it is mostly in, when one is. */
  country: string | null;
  /** The company's own site. */
  url: string | null;
}

export interface GfCloses {
  /** The latest quote, which the last session is valued at. */
  marketPrice: number;
  closes: { date: string; close: number }[];
}

export interface Ghostfolio {
  /** The profile of every symbol the owner holds there, by symbol. */
  profiles(): Promise<Map<string, GfProfile>>;
  /** Daily closes for the last `days` days. */
  closes(dataSource: string, symbol: string, days: number): Promise<GfCloses>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

/** The heaviest entry of a weighted list, when it carries at least half. */
function dominant(list: unknown, key: string): string | null {
  if (!Array.isArray(list)) return null;
  let best: { value: string; weight: number } | null = null;
  for (const entry of list) {
    if (!isRecord(entry) || !isNumber(entry.weight)) continue;
    const value = textOrNull(entry[key]);
    if (value && (!best || entry.weight > best.weight)) best = { value, weight: entry.weight };
  }
  return best && best.weight >= 0.5 ? best.value : null;
}

function narrowProfiles(body: unknown): Map<string, GfProfile> {
  if (!isRecord(body) || !Array.isArray(body.holdings)) {
    throw new Error("Ghostfolio holdings have no list");
  }
  const profiles = new Map<string, GfProfile>();
  for (const holding of body.holdings) {
    const profile = isRecord(holding) ? holding.assetProfile : null;
    if (!isRecord(profile)) throw new Error("Ghostfolio holding without an asset profile");
    const symbol = textOrNull(profile.symbol);
    const dataSource = textOrNull(profile.dataSource);
    if (!symbol || !dataSource) throw new Error("Ghostfolio holding lacks a symbol or source");
    const subClass = textOrNull(profile.assetSubClass);
    if (textOrNull(profile.assetClass) === "LIQUIDITY" || subClass === "CASH") continue;
    const kind = subClass === "STOCK" ? "stock" : subClass === "ETF" ? "etf" : "other";
    const country = dominant(profile.countries, "code");
    const url = textOrNull(profile.url);
    profiles.set(symbol, {
      symbol,
      dataSource,
      name: textOrNull(profile.name) ?? symbol,
      kind,
      sector: kind === "stock" ? dominant(profile.sectors, "name") : null,
      country: country && /^[A-Z]{2}$/.test(country) ? country : null,
      url: url?.startsWith("https://") ? url : null,
    });
  }
  return profiles;
}

function narrowCloses(body: unknown): GfCloses {
  if (!isRecord(body) || !isNumber(body.marketPrice) || !Array.isArray(body.historicalData)) {
    throw new Error("Ghostfolio symbol has no price or history");
  }
  const closes: GfCloses["closes"] = [];
  for (const item of body.historicalData) {
    if (
      isRecord(item) &&
      typeof item.date === "string" &&
      DAY_RE.test(item.date) &&
      isNumber(item.value) &&
      item.value > 0
    ) {
      closes.push({ date: item.date.slice(0, 10), close: item.value });
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

  const get = async (name: string, path: string, query: Record<string, string>) => {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchOk(`Ghostfolio ${name}`, url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jwt}`,
        "Impersonation-Id": env.GHOSTFOLIO_ACCESS_ID,
        Timezone: TIME_ZONE,
      },
      signal: signal(),
    });
    return (await response.json()) as unknown;
  };

  return {
    profiles: async () =>
      narrowProfiles(
        await get("holdings", "/api/v1/portfolio/holdings", { holdingType: "ACTIVE" })
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

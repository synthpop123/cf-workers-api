/**
 * Prices: the self-hosted Ghostfolio (`GHOSTFOLIO_URL`) as a market-data
 * source. The ledger is Wealthfolio's (`wealthfolio.ts`); Ghostfolio only
 * answers what a symbol closed at, which it keeps for every symbol it
 * gathers (any it has an activity or a watchlist entry for, and the
 * benchmark). A symbol it does not gather has no history, so a new
 * holding goes on its watchlist.
 *
 * It signs in as a bot user (`GHOSTFOLIO_TOKEN`, that user's security
 * token); public prices need no access to anyone's portfolio.
 */

import { fetchOk } from "../../lib/http";
import { isNumber, isRecord, textOrNull } from "../../lib/narrow";

/** A cold symbol's history is fetched on request; give it time. */
const GHOSTFOLIO_TIMEOUT_MS = 20_000;

/** The data source every symbol is asked for under. */
export const DATA_SOURCE = "YAHOO";

export interface GfCloses {
  /** The latest quote, which the last session is valued at. */
  marketPrice: number;
  closes: { date: string; close: number }[];
}

export interface Prices {
  /** Daily closes for the last `days` days. */
  closes(symbol: string, days: number): Promise<GfCloses>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

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

/** Sign in and return a price reader. */
export async function connect(env: Env): Promise<Prices> {
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

  return {
    closes: async (symbol, days) => {
      const url = new URL(`/api/v1/symbol/${DATA_SOURCE}/${encodeURIComponent(symbol)}`, base);
      url.searchParams.set("includeHistoricalData", String(days));
      const response = await fetchOk(`Ghostfolio closes ${symbol}`, url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
        signal: signal(),
      });
      return narrowCloses(await response.json());
    },
  };
}

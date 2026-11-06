/**
 * portfolio — the owner's portfolio as kept in the self-hosted
 * Wealthfolio (`WEALTHFOLIO_URL`), priced by the self-hosted Ghostfolio
 * (`GHOSTFOLIO_URL`), served as the returns-only view behind the
 * Portfolio section of lkwplus.com/misc: per account its value and the
 * money put in as ratios on one scale, what it holds by weight, and the
 * daily closes of those holdings and of the benchmark (compose.ts).
 *
 * Activities are recorded in Wealthfolio, which owns the ledger; nothing
 * is stored here but the snapshot. The heartbeat recomposes it hourly
 * (schedule.ts), so the line follows the market through a session and a
 * page load never waits on either upstream.
 *
 * One composition costs Wealthfolio a session (accounts, cash, then a
 * history and the holdings for the portfolio and for each account, and a
 * classification per new symbol) and Ghostfolio a sign-in and one price
 * history per holding plus the benchmark — about two dozen requests,
 * which is why it runs at a minute no other hourly job does.
 */

import { linkedKeys } from "../../lib/images";
import { isRecord } from "../../lib/narrow";
import type { Service } from "../../lib/service";
import { read, type Snapshot } from "../../lib/snapshot";
import {
  BENCHMARK,
  composeSite,
  heldSymbols,
  historyDays,
  marketSession,
  SITE_VERSION,
} from "./compose";
import * as ghostfolio from "./ghostfolio";
import { mirrorBrokers, mirrorLogos } from "./logos";
import * as wealthfolio from "./wealthfolio";
import type { WfProfile } from "./wealthfolio";

/** The classifications the stored body already carries, by symbol: a
 *  symbol's kind, sector and country are asked for once, when it is new. */
export function knownProfiles(text: string | undefined): Map<string, WfProfile> {
  const known = new Map<string, WfProfile>();
  if (!text) return known;
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || body.schemaVersion !== SITE_VERSION || !Array.isArray(body.symbols)) {
      return known;
    }
    for (const entry of body.symbols) {
      if (isRecord(entry) && typeof entry.symbol === "string") {
        const { kind, sector, country } = entry;
        known.set(entry.symbol, {
          kind: kind === "stock" || kind === "etf" ? kind : "other",
          sector: typeof sector === "string" ? sector : null,
          country: typeof country === "string" ? country : null,
        });
      }
    }
  } catch {
    // An unreadable body knows nothing; every symbol is asked for.
  }
  return known;
}

export const portfolioSite: Snapshot = {
  key: "portfolio:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    const ledger = await wealthfolio.connect(env);
    try {
      const [prices, previous] = await Promise.all([
        ghostfolio.connect(env),
        read(env, portfolioSite),
      ]);
      const [list, cash, days, holdings] = await Promise.all([
        ledger.accounts(),
        ledger.cash(),
        ledger.days(),
        ledger.holdings(),
      ]);
      const accounts = await Promise.all(
        list.map(async (account) => {
          const [accountDays, accountHoldings] = await Promise.all([
            ledger.days(account.id),
            ledger.holdings(account.id),
          ]);
          return {
            account,
            days: accountDays,
            holdings: accountHoldings,
            cash: cash.get(account.id) ?? [],
          };
        })
      );

      const held = heldSymbols(holdings.holdings).map((holding) => holding.symbol);
      const known = knownProfiles(previous?.text);
      const span = historyDays(days, today);
      const [profiles, benchmark, series] = await Promise.all([
        Promise.all(
          held.map(
            async (symbol) => [symbol, known.get(symbol) ?? (await ledger.profile(symbol))] as const
          )
        ),
        prices.closes(BENCHMARK.symbol, span),
        // A holding whose history fails ships without a line, never fails
        // the view.
        Promise.all(
          held.map((symbol) =>
            prices.closes(symbol, span).catch((error) => {
              console.error(`Ghostfolio closes for ${symbol} failed`, error);
              return undefined;
            })
          )
        ),
      ]);

      const linked = linkedKeys(env, previous?.text);
      const [symbols, brokers] = await Promise.all([
        mirrorLogos(env, held, linked),
        mirrorBrokers(env, list, linked),
      ]);
      return JSON.stringify(
        composeSite(
          {
            portfolio: { days, holdings, cash: [...cash.values()].flat() },
            accounts,
            profiles: new Map(profiles),
            closes: new Map(
              held.flatMap((symbol, i) => {
                const entry = series[i];
                return entry ? [[symbol, entry] as const] : [];
              })
            ),
            benchmark,
          },
          { symbols, accounts: brokers },
          today,
          marketSession(new Date())
        )
      );
    } finally {
      await ledger.close();
    }
  },
};

export default { name: "portfolio", site: portfolioSite } satisfies Service;

/**
 * portfolio — the owner's portfolio, served as the returns-only view
 * behind the Portfolio section of lkwplus.com/misc (compose.ts). The owner
 * records it twice, and each copy answers what it is good at: the money
 * from the self-hosted Wealthfolio (`WEALTHFOLIO_URL`) — per account its
 * value and the money put in, what it holds by weight and at what cost —
 * and the securities from the self-hosted Ghostfolio (`GHOSTFOLIO_URL`) —
 * what each symbol is and its daily closes, and the benchmark's.
 *
 * Nothing is stored here but the snapshot. The heartbeat recomposes it
 * hourly (schedule.ts), so the line follows the market through a session
 * and a page load never waits on either upstream.
 *
 * One composition costs Wealthfolio a session (accounts, cash, then a
 * history and the holdings for the portfolio and for each account) and
 * Ghostfolio a sign-in, the holdings' profiles and one price history per
 * holding plus the benchmark — about two dozen requests, which is why it
 * runs at a minute no other hourly job does.
 */

import { linkedKeys } from "../../lib/images";
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

export const portfolioSite: Snapshot = {
  key: "portfolio:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    const ledger = await wealthfolio.connect(env);
    try {
      const [securities, previous] = await Promise.all([
        ghostfolio.connect(env),
        read(env, portfolioSite),
      ]);
      const [list, cash, days, holdings, profiles] = await Promise.all([
        ledger.accounts(),
        ledger.cash(),
        ledger.days(),
        ledger.holdings(),
        securities.profiles(),
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
      const span = historyDays(days, today);
      const [benchmark, series] = await Promise.all([
        securities.closes(ghostfolio.DATA_SOURCE, BENCHMARK.symbol, span),
        // A holding whose history fails ships without a line, never fails
        // the view.
        Promise.all(
          held.map((symbol) =>
            securities
              .closes(profiles.get(symbol)?.dataSource ?? ghostfolio.DATA_SOURCE, symbol, span)
              .catch((error) => {
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
            profiles,
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

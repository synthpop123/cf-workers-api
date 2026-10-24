/**
 * portfolio — the owner's portfolio as it is kept in the self-hosted
 * Ghostfolio (`GHOSTFOLIO_URL`), served as the returns-only view behind
 * the Portfolio section of lkwplus.com/misc: a time-weighted growth index
 * per account, what each account holds by weight, and the daily closes of
 * those holdings and of the benchmark (compose.ts).
 *
 * Activities are recorded in Ghostfolio, which owns the ledger and the
 * market data; nothing is stored here but the snapshot. The heartbeat
 * recomposes it hourly (schedule.ts), so the line follows the market
 * through a session and a page load never waits on Ghostfolio.
 *
 * One composition costs Ghostfolio a sign-in, the account list, a chart
 * and the holdings for the portfolio and for each account, and one price
 * history per holding plus the benchmark — about twenty requests, which
 * is why it runs at a minute no other hourly job does.
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
import { connect } from "./ghostfolio";
import { mirrorBrokers, mirrorLogos } from "./logos";

export const portfolioSite: Snapshot = {
  key: "portfolio:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    const ghostfolio = await connect(env);
    const [list, chart, holdings] = await Promise.all([
      ghostfolio.accounts(),
      ghostfolio.chart(),
      ghostfolio.holdings(),
    ]);
    const accounts = await Promise.all(
      list.map(async (account) => {
        const [accountChart, accountHoldings] = await Promise.all([
          ghostfolio.chart(account.id),
          ghostfolio.holdings(account.id),
        ]);
        return { account, chart: accountChart, holdings: accountHoldings };
      })
    );

    const held = heldSymbols(holdings);
    const days = historyDays(chart, today);
    const [benchmark, ...series] = await Promise.all([
      ghostfolio.closes(BENCHMARK.dataSource, BENCHMARK.symbol, days),
      // A holding whose history fails ships without a line, never fails
      // the view.
      ...held.map((holding) =>
        ghostfolio.closes(holding.dataSource, holding.symbol, days).catch((error) => {
          console.error(`Ghostfolio closes for ${holding.symbol} failed`, error);
          return undefined;
        })
      ),
    ]);
    const closes = new Map(
      held.flatMap((holding, i) => {
        const entry = series[i];
        return entry ? [[holding.symbol, entry] as const] : [];
      })
    );

    const previous = await read(env, portfolioSite);
    const known = linkedKeys(env, previous?.text);
    const [symbols, brokers] = await Promise.all([
      mirrorLogos(
        env,
        held.map((holding) => holding.symbol),
        known
      ),
      mirrorBrokers(env, list, known),
    ]);
    return JSON.stringify(
      composeSite(
        { portfolio: { chart, holdings }, accounts, closes, benchmark },
        { symbols, accounts: brokers },
        today,
        marketSession(new Date())
      )
    );
  },
};

export default { name: "portfolio", site: portfolioSite } satisfies Service;

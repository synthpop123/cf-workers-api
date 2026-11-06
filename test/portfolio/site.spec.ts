import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refresh } from "../../src/lib/snapshot";
import { portfolioSite } from "../../src/services/portfolio";
import { SITE_VERSION } from "../../src/services/portfolio/compose";
import { HISTORY_START } from "../../src/services/portfolio/wealthfolio";
import { call, captureErrors, imageResponse } from "../helpers";

const valuation = (date: string, totalValue: number, netContribution: number) => ({
  date,
  totalValue,
  netContribution,
  currency: "USD",
});

// 1,000 put in, then 10% on it; the amounts may never reach the body.
const HISTORY = [
  valuation("2026-01-01", 0, 0),
  valuation("2026-01-02", 1000, 1000),
  valuation("2026-01-05", 1100, 1000),
];

const position = (symbol: string, marketValueBase: number) => ({
  account: "all",
  symbol,
  name: `${symbol} Inc.`,
  currency: "USD",
  localCurrency: "USD",
  marketValueBase,
  // 123,456 shares bought for 740,736: a cost of 6 a share, and neither
  // the count nor the sum may reach the body.
  quantity: 123_456,
  costBasisLocal: 740_736,
  totalReturnPct: 0.25,
  totalReturnBase: 185_184,
  openDate: "2026-01-02",
});

const ACCESS = "245c4b96-e08b-41f7-9217-28703aaf5fe2";

/** Ghostfolio's copy of a holding: only its profile is read, and its
 *  amounts may never reach the body. */
const profile = (symbol: string, subClass: string, assetClass = "EQUITY") => ({
  valueInBaseCurrency: 987_648,
  investment: 740_736,
  assetProfile: {
    symbol,
    dataSource: "YAHOO",
    name: `${symbol} Corporation`,
    currency: "USD",
    assetClass,
    assetSubClass: subClass,
    sectors: [{ name: "Technology", weight: 1 }],
    countries: [{ code: "US", weight: subClass === "ETF" ? 0.4 : 1 }],
    url: subClass === "STOCK" ? "https://www.example.com" : null,
  },
});

/** What each MCP tool answers, given its arguments. */
function tool(name: string, args: Record<string, unknown>): unknown {
  const account = args.accountId;
  switch (name) {
    case "get_accounts":
      return {
        accounts: [
          { id: "a1", name: "Interactive Brokers", currency: "USD" },
          { id: "a2", name: "Charles Schwab", currency: "USD" },
        ],
      };
    case "get_cash_balances":
      return {
        accounts: [
          {
            accountId: "a1",
            accountCurrency: "USD",
            balances: [{ currency: "USD", amount: 110 }],
            totalBaseCurrency: 110,
          },
          { accountId: "a2", accountCurrency: "USD", balances: [], totalBaseCurrency: 0 },
        ],
      };
    case "get_valuation_history":
      expect(args.startDate).toBe(HISTORY_START);
      return { valuations: HISTORY };
    case "get_holdings":
      return account === "a2"
        ? { holdings: [position("BOXX", 1100)], totalValue: 1100 }
        : { holdings: [position("MSFT", 660), position("BOXX", 330)], totalValue: 990 };
    default:
      throw new Error(`unexpected tool ${name}`);
  }
}

const history = (base: number) => ({
  marketPrice: base + 2,
  historicalData: [
    { date: "2026-01-01T00:00:00.000Z", value: base },
    { date: "2026-01-02T00:00:00.000Z", value: base + 1 },
  ],
});

/** A Wealthfolio MCP endpoint that checks the token and the session on
 *  every call, a Ghostfolio that checks the bot's credentials and the
 *  grant, and logo.dev. */
function upstreams({ failCloses = false } = {}) {
  const asked: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.host === "img.logo.dev") {
      asked.push(`${url.host}${url.pathname}`);
      expect(url.searchParams.get("token")).toBe("test-logo-token");
      return url.pathname.endsWith("/MSFT") ? imageResponse() : new Response("", { status: 404 });
    }
    if (url.host === "wealthfolio.lkwplus.com") {
      expect(url.pathname).toBe("/mcp");
      expect(headers.get("Authorization")).toBe("Bearer test-wealthfolio-token");
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const message = JSON.parse(String(init?.body));
      if (message.method === "initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
          { headers: { "Mcp-Session-Id": "s1" } }
        );
      }
      expect(headers.get("Mcp-Session-Id")).toBe("s1");
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      expect(message.method).toBe("tools/call");
      const { name, arguments: args } = message.params;
      asked.push(`mcp ${name} ${args.accountId ?? ""}`.trim());
      const result = tool(name, args);
      // The event stream Wealthfolio answers with: an empty priming event,
      // then the message.
      return new Response(
        `data: \nid: 0/0\n\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          },
        })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }
    expect(url.host).toBe("ghostfolio.lkwplus.com");
    if (url.pathname === "/api/v1/auth/anonymous") {
      expect(JSON.parse(String(init?.body))).toEqual({ accessToken: "test-ghostfolio-token" });
      return Response.json({ authToken: "jwt" });
    }
    expect(headers.get("Authorization")).toBe("Bearer jwt");
    expect(headers.get("Impersonation-Id")).toBe(ACCESS);
    asked.push(`ghostfolio ${url.pathname}`);
    if (url.pathname === "/api/v1/portfolio/holdings") {
      return Response.json({
        holdings: [
          profile("MSFT", "STOCK"),
          profile("BOXX", "ETF"),
          profile("USD", "CASH", "LIQUIDITY"),
        ],
      });
    }
    if (url.pathname === "/api/v1/symbol/YAHOO/BOXX" && failCloses) {
      return new Response("nope", { status: 500 });
    }
    const symbol = url.pathname.split("/").at(-1) ?? "";
    return Response.json(history({ VOO: 600, MSFT: 400, BOXX: 100 }[symbol] ?? 1));
  });
  return { spy, asked };
}

beforeEach(async () => {
  await env.CACHE.delete(portfolioSite.key);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /portfolio/site", () => {
  it("composes the money from Wealthfolio and the securities from Ghostfolio, with no amount in it", async () => {
    const { asked } = upstreams();
    const response = await call("/portfolio/site");
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ["1000", "1100", "123456", "740736", "185184", "987648", "990", "660"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text);
    expect(body.schemaVersion).toBe(SITE_VERSION);
    expect(body.accounts.map((a: { id: string; name: string }) => [a.id, a.name])).toEqual([
      ["all", "All accounts"],
      ["ibkr", "IBKR"],
      ["schwab", "Schwab"],
    ]);
    expect(body.accounts[0]).toMatchObject({
      value: [0, 1, 1.1],
      invested: [0, 1, 1],
      cash: [{ currency: "USD", weight: 0.1 }],
      holdings: [
        { symbol: "MSFT", weight: 0.6, performance: 0.25, cost: 6, since: "2026-01-02" },
        { symbol: "BOXX", weight: 0.3, performance: 0.25, cost: 6, since: "2026-01-02" },
      ],
    });
    // A fund's sectors are a blend: none is named.
    expect(body.symbols).toMatchObject([
      {
        symbol: "MSFT",
        name: "MSFT Corporation",
        kind: "stock",
        sector: "Technology",
        country: "US",
        url: "https://www.example.com",
        logo: "https://img.lkwplus.com/portfolio/logos/MSFT-96.webp",
      },
      { symbol: "BOXX", kind: "etf", sector: null, country: null, url: null, logo: null },
    ]);
    expect(await env.IMAGES.head("portfolio/logos/MSFT-96.webp")).not.toBeNull();
    // The portfolio and each account, once each.
    expect(asked.filter((path) => path.startsWith("mcp get_valuation_history"))).toHaveLength(3);
    expect(asked).toContain("ghostfolio /api/v1/symbol/YAHOO/VOO");
  });

  it("ships a holding whose history fails without its line", async () => {
    const logged = captureErrors();
    upstreams({ failCloses: true });
    const body = await (await call("/portfolio/site")).json<{
      symbols: { symbol: string; closes: (number | null)[] }[];
    }>();
    expect(body.symbols.find((s) => s.symbol === "BOXX")?.closes).toEqual([null, null, null]);
    expect(body.symbols.find((s) => s.symbol === "MSFT")?.closes).toEqual([400, 401, 401]);
    expect(logged).toHaveBeenCalledWith("Ghostfolio closes for BOXX failed", expect.any(Error));
  });

  it("answers 503 when the ledger is down and nothing is stored", async () => {
    const logged = captureErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    expect((await call("/portfolio/site")).status).toBe(503);
    expect(logged).toHaveBeenCalled();
  });

  it("does not ask logo.dev again for a logo the stored body links", async () => {
    const { asked } = upstreams();
    await refresh(env, portfolioSite);
    asked.length = 0;
    await refresh(env, portfolioSite);
    expect(asked.some((path) => path.startsWith("img.logo.dev/ticker/MSFT"))).toBe(false);
  });
});

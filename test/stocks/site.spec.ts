import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refresh } from "../../src/lib/snapshot";
import { stocksSite } from "../../src/services/stocks";
import { SITE_VERSION } from "../../src/services/stocks/compose";
import { call, captureErrors, imageResponse } from "../helpers";

const ACCESS = "245c4b96-e08b-41f7-9217-28703aaf5fe2";

const chartDay = (date: string, value: number, net: number, invested = 0) => ({
  date,
  valueWithCurrencyEffect: value,
  netPerformanceWithCurrencyEffect: net,
  investmentValueWithCurrencyEffect: invested,
  // What a full grant also sends, and the view must never repeat.
  netWorth: value + 777_777,
  totalInvestment: 999_999,
  netPerformanceInPercentageWithCurrencyEffect: 0.0123,
});

const CHART = [
  chartDay("2026-01-01", 0, 0),
  chartDay("2026-01-02", 1000, 0, 1000),
  chartDay("2026-01-05", 1100, 100),
];

const holding = (symbol: string, allocation: number, assetClass = "EQUITY", sub = "STOCK") => ({
  allocationInPercentage: allocation,
  netPerformancePercentWithCurrencyEffect: 0.25,
  // 123,456 shares at 8 bought for 740,736: a cost of 6 a share, and
  // neither the count nor the sum may reach the body.
  quantity: 123_456,
  marketPrice: 8,
  valueInBaseCurrency: 987_648,
  investment: 740_736,
  dateOfFirstActivity: "2026-01-02T00:00:00.000Z",
  assetProfile: {
    symbol,
    dataSource: "YAHOO",
    name: `${symbol} Inc.`,
    currency: "USD",
    assetClass,
    assetSubClass: sub,
    sectors: [{ name: "Technology", weight: 1 }],
    countries: [{ code: "US", weight: 1 }],
    url: sub === "STOCK" ? "https://www.example.com" : null,
  },
});

const history = (base: number) => ({
  marketPrice: base + 2,
  historicalData: [
    { date: "2026-01-01T00:00:00.000Z", value: base },
    { date: "2026-01-02T00:00:00.000Z", value: base + 1 },
  ],
});

/** A Ghostfolio that checks the bot's credentials and the grant on every
 *  call, plus logo.dev. */
function ghostfolio({ failCloses = false } = {}) {
  const asked: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(`${url.host}${url.pathname}${url.search}`);
    if (url.host === "img.logo.dev") {
      expect(url.searchParams.get("token")).toBe("test-logo-token");
      return url.pathname.endsWith("/MSFT") ? imageResponse() : new Response("", { status: 404 });
    }
    expect(url.host).toBe("ghostfolio.lkwplus.com");
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/v1/auth/anonymous") {
      expect(JSON.parse(String(init?.body))).toEqual({ accessToken: "test-ghostfolio-token" });
      return Response.json({ authToken: "jwt" });
    }
    expect(headers.get("Authorization")).toBe("Bearer jwt");
    expect(headers.get("Impersonation-Id")).toBe(ACCESS);
    const account = url.searchParams.get("accounts");
    switch (url.pathname) {
      case "/api/v1/account":
        return Response.json({
          accounts: [
            { id: "a1", name: "IBKR", balance: 3166.02, value: 40_016 },
            { id: "a2", name: "Schwab", balance: 310.98, value: 506 },
          ],
          totalValueInBaseCurrency: 43_222,
        });
      case "/api/v2/portfolio/performance":
        expect(url.searchParams.get("range")).toBe("max");
        return Response.json({ chart: CHART, performance: { currentNetWorth: 43_222 } });
      case "/api/v1/portfolio/holdings":
        return Response.json({
          holdings:
            account === "a2"
              ? [holding("BOXX", 1, "EQUITY", "ETF")]
              : [
                  holding("MSFT", 0.6),
                  holding("BOXX", 0.3, "EQUITY", "ETF"),
                  holding("USD", 0.1, "LIQUIDITY", "CASH"),
                ],
        });
      default: {
        if (url.pathname === "/api/v1/symbol/YAHOO/BOXX" && failCloses) {
          return new Response("nope", { status: 500 });
        }
        const symbol = url.pathname.split("/").at(-1) ?? "";
        return Response.json(history({ VOO: 600, MSFT: 400, BOXX: 100 }[symbol] ?? 1));
      }
    }
  });
  return { spy, asked };
}

beforeEach(async () => {
  await env.CACHE.delete(stocksSite.key);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /stocks/site", () => {
  it("composes from Ghostfolio through the grant, with no amount in it", async () => {
    const { asked } = ghostfolio();
    const response = await call("/stocks/site");
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of [
      "777777",
      "999999",
      "123456",
      "987648",
      "740736",
      "3166",
      "43222",
      "0.0123",
    ]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text);
    expect(body.schemaVersion).toBe(SITE_VERSION);
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(["all", "ibkr", "schwab"]);
    expect(body.accounts[0]).toMatchObject({
      index: [1, 1, 1.1],
      cash: [{ currency: "USD", weight: 0.1 }],
      holdings: [
        { symbol: "MSFT", weight: 0.6, performance: 0.25, cost: 6, since: "2026-01-02" },
        { symbol: "BOXX", weight: 0.3, performance: 0.25, cost: 6, since: "2026-01-02" },
      ],
    });
    const symbols = body.symbols as { symbol: string; logo: string | null; kind: string }[];
    expect(symbols.map((s) => [s.symbol, s.kind])).toEqual([
      ["MSFT", "stock"],
      ["BOXX", "etf"],
    ]);
    expect(symbols[0].logo).toBe("https://img.lkwplus.com/stocks/logos/MSFT-96.webp");
    expect(symbols[1].logo).toBeNull();
    // A fund's sectors are a blend: none is named.
    expect(body.symbols[0]).toMatchObject({
      sector: "Technology",
      country: "US",
      url: "https://www.example.com",
    });
    expect(body.symbols[1]).toMatchObject({ sector: null, country: "US", url: null });
    expect(await env.IMAGES.head("stocks/logos/MSFT-96.webp")).not.toBeNull();
    // The portfolio and each account, once each.
    expect(asked.filter((path) => path.includes("/performance"))).toHaveLength(3);
  });

  it("ships a holding whose history fails without its line", async () => {
    const logged = captureErrors();
    ghostfolio({ failCloses: true });
    const body = await (await call("/stocks/site")).json<{
      symbols: { symbol: string; closes: (number | null)[] }[];
    }>();
    expect(body.symbols.find((s) => s.symbol === "BOXX")?.closes).toEqual([null, null, null]);
    expect(body.symbols.find((s) => s.symbol === "MSFT")?.closes).toEqual([400, 401, 401]);
    expect(logged).toHaveBeenCalledWith("Ghostfolio closes for BOXX failed", expect.any(Error));
  });

  it("answers 503 when Ghostfolio is down and nothing is stored", async () => {
    const logged = captureErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    expect((await call("/stocks/site")).status).toBe(503);
    expect(logged).toHaveBeenCalled();
  });

  it("does not ask logo.dev again for a logo the stored body links", async () => {
    const { asked } = ghostfolio();
    await refresh(env, stocksSite);
    asked.length = 0;
    await refresh(env, stocksSite);
    expect(asked.some((path) => path.startsWith("img.logo.dev/ticker/MSFT"))).toBe(false);
  });
});

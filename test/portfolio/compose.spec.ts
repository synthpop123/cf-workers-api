import { describe, expect, it } from "vitest";
import {
  alignCloses,
  axis,
  bestDays,
  capital,
  composeSite,
  DAILY_DAYS,
  dayReturn,
  growthIndex,
  heldSymbols,
  marketSession,
  SITE_VERSION,
  slug,
  toSessions,
  type Upstream,
  weigh,
} from "../../src/services/portfolio/compose";
import type { WfDay, WfHolding } from "../../src/services/portfolio/wealthfolio";

const day = (date: string, value: number, invested: number): WfDay => ({ date, value, invested });

const holding = (symbol: string, value: number, extra: Partial<WfHolding> = {}): WfHolding => ({
  symbol,
  name: `${symbol} Inc.`,
  currency: "USD",
  value,
  performance: 0.25,
  cost: 400,
  since: "2026-01-02",
  ...extra,
});

describe("dayReturn", () => {
  it("is the gain over the close before plus the day's money in", () => {
    // 1,000 at work, 9,000 put in, 11,000 at the close: 10% on 10,000.
    expect(dayReturn(day("2026-01-01", 1000, 1000), day("2026-01-02", 11_000, 10_000))).toBeCloseTo(
      0.1
    );
  });

  it("adds money taken out back to the close", () => {
    // 10,000 at work, 5,000 taken out, 5,500 left: 5% on 10,000.
    expect(dayReturn(day("2026-01-01", 10_000, 10_000), day("2026-01-02", 5500, 5000))).toBeCloseTo(
      0.05
    );
  });

  it("is null on dust", () => {
    expect(dayReturn(day("2026-01-01", 1.28, 1.28), day("2026-01-02", 8.66, 1.28))).toBeNull();
  });
});

describe("growthIndex", () => {
  it("starts at 1 the day before money goes in and chains each day's return", () => {
    const index = growthIndex([
      day("2026-01-01", 0, 0),
      day("2026-01-02", 1010, 1000),
      day("2026-01-05", 1111, 1000),
    ]);
    expect([...index.keys()]).toEqual(["2026-01-01", "2026-01-02", "2026-01-05"]);
    expect(index.get("2026-01-02")).toBeCloseTo(1.01);
    expect(index.get("2026-01-05")).toBeCloseTo(1.01 * 1.1);
  });

  it("does not move when money comes in or goes out", () => {
    const index = growthIndex([
      day("2026-01-01", 0, 0),
      day("2026-01-02", 1000, 1000),
      day("2026-01-05", 10_000, 10_000),
      day("2026-01-06", 11_000, 10_000),
      day("2026-01-07", 1000, 0),
    ]);
    expect(index.get("2026-01-05")).toBeCloseTo(1);
    expect(index.get("2026-01-06")).toBeCloseTo(1.1);
    expect(index.get("2026-01-07")).toBeCloseTo(1.1);
  });

  it("earns nothing on dust, and starts once real money is in", () => {
    const index = growthIndex([
      day("2026-03-11", 1.28, 1.28),
      day("2026-03-12", 8.66, 1.28),
      day("2026-09-16", 1.3, 1.28),
      day("2026-09-17", 510, 510),
      day("2026-09-18", 561, 510),
    ]);
    expect([...index.keys()]).toEqual(["2026-09-16", "2026-09-17", "2026-09-18"]);
    expect(index.get("2026-09-18")).toBeCloseTo(1.1, 2);
  });

  it("is empty for an account that never held anything", () => {
    expect(growthIndex([day("2026-01-01", 0, 0), day("2026-01-02", 0, 0)]).size).toBe(0);
  });
});

describe("bestDays", () => {
  it("walks back keeping each day that beat every one after it", () => {
    const best = bestDays(
      new Map([
        ["2026-01-01", 1],
        ["2026-01-02", 1.05], // +5%
        ["2026-01-05", 1.05 * 0.98], // −2%
        ["2026-01-06", 1.05 * 0.98 * 1.03], // +3%
        ["2026-01-07", 1.05 * 0.98 * 1.03 * 1.01], // +1%
      ])
    );
    expect(best.map(({ date }) => date)).toEqual(["2026-01-07", "2026-01-06", "2026-01-02"]);
    expect(best.map(({ change }) => change)).toEqual([0.01, 0.03, 0.05]);
  });

  it("counts a weekend's move on the Monday", () => {
    const best = bestDays(
      new Map([
        ["2026-01-02", 1], // Friday
        ["2026-01-03", 1.1], // Saturday
        ["2026-01-05", 1.21], // Monday
      ])
    );
    expect(best).toEqual([{ date: "2026-01-05", change: 0.21 }]);
  });

  it("is empty with no day after the base", () => {
    expect(bestDays(new Map([["2026-01-01", 1]]))).toEqual([]);
  });
});

describe("marketSession", () => {
  const at = (iso: string) => marketSession(new Date(iso));
  it("is New York's day once its session opens, the weekday before until then", () => {
    // Thu 22 Oct 2026, 09:00 in Shanghai = Wed 21:00 in New York.
    expect(at("2026-10-22T09:00:00+08:00")).toBe("2026-10-21");
    // Thu 22:00 in Shanghai = Thu 10:00 in New York, session open.
    expect(at("2026-10-22T22:00:00+08:00")).toBe("2026-10-22");
    // Thu 09:00 in New York, before the open.
    expect(at("2026-10-22T09:00:00-04:00")).toBe("2026-10-21");
    // Monday morning before the open, and a Sunday: Friday.
    expect(at("2026-10-26T08:00:00-04:00")).toBe("2026-10-23");
    expect(at("2026-10-25T12:00:00-04:00")).toBe("2026-10-23");
  });
});

describe("toSessions", () => {
  it("folds the days after the session into it", () => {
    const folded = toSessions(
      [day("2026-10-20", 100, 100), day("2026-10-21", 101, 100), day("2026-10-22", 152, 150)],
      "2026-10-21"
    );
    expect(folded).toEqual([day("2026-10-20", 100, 100), day("2026-10-21", 152, 150)]);
  });

  it("leaves a history that ends on the session alone", () => {
    const history = [day("2026-10-21", 100, 100), day("2026-10-22", 101, 100)];
    expect(toSessions(history, "2026-10-22")).toBe(history);
  });
});

describe("capital", () => {
  it("divides value and money in by the most ever put in, from the start", () => {
    const history = [
      day("2026-01-01", 1, 1),
      day("2026-01-02", 1000, 1000),
      day("2026-01-03", 1500, 2000), // a Saturday deposit, then a fall
      day("2026-01-05", 2500, 2000),
    ];
    expect(capital(["2025-12-31", "2026-01-02", "2026-01-05"], history, "2026-01-02")).toEqual({
      value: [null, 0.5, 1.25],
      invested: [null, 0.5, 1],
    });
  });
});

describe("axis", () => {
  it("drops weekends, keeps the base, and thins to weekly before the daily window", () => {
    const days: string[] = [];
    for (let d = new Date("2024-01-06T12:00:00Z"); days.length < 900; ) {
      days.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const shown = axis(days);
    expect(shown[0]).toBe("2024-01-06"); // a Saturday, but the base
    expect(shown.at(-1)).toBe(days.at(-1));
    const weekdays = (from: string) => shown.filter((date) => date >= from);
    const cutoff = new Date(`${days.at(-1)}T12:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - DAILY_DAYS);
    const daily = weekdays(cutoff.toISOString().slice(0, 10));
    expect(daily.length).toBeGreaterThan(250);
    expect(shown.slice(1).every((date) => ![0, 6].includes(new Date(date).getUTCDay()))).toBe(true);
    // Before the window, one day a week: each a Friday.
    const weekly = shown.slice(1, shown.length - daily.length);
    expect(weekly.length).toBeGreaterThan(70);
    expect(weekly.every((date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 5)).toBe(true);
  });
});

describe("alignCloses", () => {
  it("carries the last close over a holiday and prices today at the live quote", () => {
    const series = {
      marketPrice: 12,
      closes: [
        { date: "2026-01-01", close: 10 },
        { date: "2026-01-05", close: 11 },
      ],
    };
    expect(
      alignCloses(["2025-12-31", "2026-01-02", "2026-01-05", "2026-01-06"], series, "2026-01-06")
    ).toEqual([null, 10, 11, 12]);
  });

  it("is all null for a symbol with no history", () => {
    expect(alignCloses(["2026-01-01"], undefined, "2026-01-01")).toEqual([null]);
  });
});

describe("slug", () => {
  it("is lowercase, unique, and never `all`", () => {
    const taken = new Set(["all"]);
    expect(slug("Interactive Brokers", taken)).toBe("interactive-brokers");
    expect(slug("Interactive Brokers", taken)).toBe("interactive-brokers-2");
    expect(slug("All", taken)).toBe("all-account");
    expect(slug("招商", taken)).toBe("account");
  });
});

describe("heldSymbols", () => {
  it("drops closed positions, heaviest first, once", () => {
    const held = heldSymbols([
      holding("KO", 0),
      holding("MSFT", 50),
      holding("BOXX", 750),
      holding("MSFT", 50),
    ]);
    expect(held.map((h) => h.symbol)).toEqual(["BOXX", "MSFT"]);
  });
});

describe("weigh", () => {
  it("shares everything in the account, US dollar cash included", () => {
    const weighed = weigh(
      // NVDA is left off the list but counted in the total.
      { holdings: [holding("BOXX", 700), holding("MSFT", 100)], total: 900 },
      [
        { currency: "USD", value: 50 },
        { currency: "USD", value: 50 },
      ]
    );
    expect(weighed.holdings.map((h) => [h.symbol, h.weight])).toEqual([
      ["BOXX", 0.7],
      ["MSFT", 0.1],
    ]);
    expect(weighed.cash).toEqual([{ currency: "USD", weight: 0.1 }]);
  });

  it("leaves cash in any other currency out of the weights", () => {
    const weighed = weigh({ holdings: [holding("BOXX", 900)], total: 900 }, [
      { currency: "USD", value: 100 },
      { currency: "CNY", value: 40 },
      { currency: "HKD", value: 1 },
    ]);
    expect(weighed.holdings.map((h) => [h.symbol, h.weight])).toEqual([["BOXX", 0.9]]);
    expect(weighed.cash).toEqual([{ currency: "USD", weight: 0.1 }]);
  });
});

describe("composeSite", () => {
  const history = [
    day("2026-01-01", 0, 0),
    day("2026-01-02", 1000, 1000),
    day("2026-01-05", 1100, 1000),
  ];
  const upstream = (): Upstream => ({
    portfolio: {
      days: history,
      holdings: { holdings: [holding("MSFT", 990)], total: 990 },
      cash: [{ currency: "USD", value: 110 }],
    },
    accounts: [
      {
        account: { id: "a1", name: "Interactive Brokers" },
        days: history,
        holdings: { holdings: [holding("MSFT", 1100)], total: 1100 },
        cash: [],
      },
      {
        account: { id: "a2", name: "Empty" },
        days: [day("2026-01-01", 0, 0)],
        holdings: { holdings: [], total: 0 },
        cash: [],
      },
    ],
    profiles: new Map([
      [
        "MSFT",
        {
          symbol: "MSFT",
          dataSource: "YAHOO",
          name: "Microsoft Corporation",
          kind: "stock",
          sector: "Technology",
          country: "US",
          url: "https://www.microsoft.com",
        },
      ],
    ]),
    closes: new Map([
      [
        "MSFT",
        {
          marketPrice: 500,
          closes: [
            { date: "2026-01-01", close: 400 },
            { date: "2026-01-02", close: 410 },
            { date: "2026-01-05", close: 450 },
          ],
        },
      ],
    ]),
    benchmark: { marketPrice: 700, closes: [{ date: "2026-01-01", close: 600 }] },
  });

  it("ships ratios, weights and public prices only", () => {
    const site = composeSite(
      upstream(),
      {
        symbols: new Map([["MSFT", "https://img.test/msft.webp"]]),
        accounts: new Map([["a1", "https://img.test/ibkr.webp"]]),
      },
      "2026-01-06",
      "2026-01-05"
    );
    expect(site.schemaVersion).toBe(SITE_VERSION);
    expect(site.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-05"]);
    expect(site.accounts.map((a) => [a.id, a.name, a.logo])).toEqual([
      ["all", "All accounts", null],
      ["ibkr", "IBKR", "https://img.test/ibkr.webp"],
    ]);
    expect(site.accounts[0]).toMatchObject({
      value: [0, 1, 1.1],
      invested: [0, 1, 1],
      best: [{ date: "2026-01-05", change: 0.1 }],
      holdings: [
        { symbol: "MSFT", weight: 0.9, performance: 0.25, cost: 400, since: "2026-01-02" },
      ],
      cash: [{ currency: "USD", weight: 0.1 }],
    });
    // The session's day is priced at the live quote.
    expect(site.symbols).toEqual([
      {
        symbol: "MSFT",
        name: "Microsoft Corporation",
        currency: "USD",
        kind: "stock",
        logo: "https://img.test/msft.webp",
        sector: "Technology",
        country: "US",
        url: "https://www.microsoft.com",
        closes: [400, 410, 500],
      },
    ]);
    expect(site.benchmark).toEqual({ symbol: "VOO", label: "S&P 500", closes: [600, 600, 700] });

    // No amount the ledger sent reaches the body.
    const text = JSON.stringify(site);
    for (const amount of ["1000", "1100", "990", "110"]) expect(text).not.toContain(amount);
  });

  it("refuses a portfolio with no history", () => {
    const empty = {
      ...upstream(),
      portfolio: { ...upstream().portfolio, days: [day("2026-01-01", 0, 0)] },
    };
    expect(() =>
      composeSite(empty, { symbols: new Map(), accounts: new Map() }, "2026-01-06", "2026-01-05")
    ).toThrow(/no history/);
  });
});

import { describe, expect, it } from "vitest";
import {
  alignCloses,
  axis,
  composeSite,
  DAILY_DAYS,
  growthIndex,
  heldSymbols,
  marketSession,
  SITE_VERSION,
  slug,
  toSessions,
  type Upstream,
} from "../../src/services/stocks/compose";
import type { GfDay, GfHolding } from "../../src/services/stocks/ghostfolio";

const day = (date: string, value: number, netPerformance: number, investment = 0): GfDay => ({
  date,
  value,
  netPerformance,
  investment,
});

const holding = (symbol: string, weight: number, extra: Partial<GfHolding> = {}): GfHolding => ({
  symbol,
  dataSource: "YAHOO",
  name: `${symbol} Inc.`,
  currency: "USD",
  subClass: "STOCK",
  cash: false,
  weight,
  ...extra,
});

describe("growthIndex", () => {
  it("starts at 1 the day before money goes in and chains each day's gain", () => {
    const index = growthIndex([
      day("2026-01-01", 0, 0),
      day("2026-01-02", 1010, 10, 1000),
      day("2026-01-05", 1111, 111),
    ]);
    expect([...index.keys()]).toEqual(["2026-01-01", "2026-01-02", "2026-01-05"]);
    expect(index.get("2026-01-02")).toBeCloseTo(1.01);
    expect(index.get("2026-01-05")).toBeCloseTo(1.01 * 1.1);
  });

  it("does not move when money comes in or goes out", () => {
    const index = growthIndex([
      day("2026-01-01", 0, 0),
      day("2026-01-02", 1000, 0, 1000),
      // A deposit of 9,000 on a flat day, then a 10% day on 10,000.
      day("2026-01-05", 10_000, 0, 9000),
      day("2026-01-06", 11_000, 1000),
      // Half sold at cost, no gain: the index holds.
      day("2026-01-07", 5500, 1000, -5500),
    ]);
    expect(index.get("2026-01-05")).toBeCloseTo(1);
    expect(index.get("2026-01-06")).toBeCloseTo(1.1);
    expect(index.get("2026-01-07")).toBeCloseTo(1.1);
  });

  it("counts a gain realised on the day it is sold", () => {
    const index = growthIndex([
      day("2026-01-01", 0, 0),
      day("2026-01-02", 1000, 0, 1000),
      // Everything sold for 1,100: value 0, gain 100 that day.
      day("2026-01-05", 0, 100, -1000),
      // Nothing held: the index rests.
      day("2026-01-06", 0, 100),
    ]);
    expect(index.get("2026-01-05")).toBeCloseTo(1.1);
    expect(index.get("2026-01-06")).toBeCloseTo(1.1);
  });

  it("is empty for an account that never held anything", () => {
    expect(growthIndex([day("2026-01-01", 0, 0), day("2026-01-02", 0, 0)]).size).toBe(0);
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
      [day("2026-10-20", 100, 0), day("2026-10-21", 101, 1), day("2026-10-22", 152, 2, 50)],
      "2026-10-21"
    );
    expect(folded).toEqual([day("2026-10-20", 100, 0), day("2026-10-21", 152, 2, 50)]);
  });

  it("leaves a chart that ends on the session alone", () => {
    const chart = [day("2026-10-21", 100, 0), day("2026-10-22", 101, 1)];
    expect(toSessions(chart, "2026-10-22")).toBe(chart);
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
  it("drops cash and closed positions, heaviest first", () => {
    const held = heldSymbols([
      holding("USD", 0.1, { cash: true, subClass: "CASH" }),
      holding("KO", 0),
      holding("MSFT", 0.05),
      holding("BOXX", 0.75, { subClass: "ETF" }),
    ]);
    expect(held.map((h) => h.symbol)).toEqual(["BOXX", "MSFT"]);
  });
});

describe("composeSite", () => {
  const chart = [
    day("2026-01-01", 0, 0),
    day("2026-01-02", 1000, 0, 1000),
    day("2026-01-05", 1100, 100),
  ];
  const upstream = (): Upstream => ({
    portfolio: {
      chart,
      holdings: [
        holding("MSFT", 0.9),
        holding("USD", 0.1, { cash: true, subClass: "CASH", name: "US Dollar" }),
      ],
    },
    accounts: [
      { account: { id: "a1", name: "IBKR" }, chart, holdings: [holding("MSFT", 1)] },
      { account: { id: "a2", name: "Empty" }, chart: [day("2026-01-01", 0, 0)], holdings: [] },
    ],
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

  it("ships returns, weights and public prices only", () => {
    const site = composeSite(
      upstream(),
      new Map([["MSFT", "https://img.test/msft.webp"]]),
      "2026-01-06",
      "2026-01-05"
    );
    expect(site.schemaVersion).toBe(SITE_VERSION);
    expect(site.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-05"]);
    expect(site.accounts.map((a) => [a.id, a.name])).toEqual([
      ["all", "All accounts"],
      ["ibkr", "IBKR"],
    ]);
    expect(site.accounts[0]).toMatchObject({
      index: [1, 1, 1.1],
      holdings: [{ symbol: "MSFT", weight: 0.9 }],
      cash: 0.1,
    });
    // The session's day is priced at the live quote.
    expect(site.symbols).toEqual([
      {
        symbol: "MSFT",
        name: "MSFT Inc.",
        currency: "USD",
        kind: "stock",
        logo: "https://img.test/msft.webp",
        closes: [400, 410, 500],
      },
    ]);
    expect(site.benchmark).toEqual({ symbol: "VOO", label: "S&P 500", closes: [600, 600, 700] });

    // No amount Ghostfolio sent reaches the body.
    const text = JSON.stringify(site);
    for (const amount of ["1000", "1100", "investment", "value", "quantity"]) {
      expect(text).not.toContain(amount);
    }
  });

  it("refuses a portfolio with no history", () => {
    const empty = { ...upstream(), portfolio: { chart: [day("2026-01-01", 0, 0)], holdings: [] } };
    expect(() => composeSite(empty, new Map(), "2026-01-06", "2026-01-05")).toThrow(/no history/);
  });
});

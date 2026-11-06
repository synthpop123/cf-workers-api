import { describe, expect, it } from "vitest";
import {
  alignCloses,
  axis,
  bestDays,
  capital,
  composeSite,
  DAILY_DAYS,
  dayReturn,
  fallsFrom,
  growthIndex,
  growthOn,
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

describe("growthOn", () => {
  it("keeps the dust rule the ratios cannot: a tiny balance doubling earns nothing", () => {
    // 10,000 in, all but 1 taken out, then the 1 doubles and halves.
    const history = [
      day("2026-01-01", 0, 0),
      day("2026-01-02", 10_000, 10_000),
      day("2026-01-05", 1, 1),
      day("2026-01-06", 2, 1),
      day("2026-01-07", 1, 1),
    ];
    const days = history.map((d) => d.date);
    expect(growthOn(days, growthIndex(history))).toEqual([1, 1, 1, 1, 1]);
  });

  it("carries the level over a day the index lacks and is null before the start", () => {
    const index = new Map([
      ["2026-01-02", 1],
      ["2026-01-05", 1.2],
    ]);
    expect(growthOn(["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06"], index)).toEqual([
      null,
      1,
      1.2,
      1.2,
    ]);
  });
});

describe("fallsFrom", () => {
  it("finds a fall inside a week the weekly axis keeps one day of", () => {
    // Mon 1,000 → Wed 2,000 → Fri 1,000, a year and more back; the axis
    // keeps only the Fridays, which read flat.
    const index = new Map([
      ["2024-01-05", 1],
      ["2024-01-08", 1],
      ["2024-01-10", 2],
      ["2024-01-12", 1],
      ["2026-01-02", 1],
    ]);
    const days = ["2024-01-05", "2024-01-12", "2026-01-02"];
    expect(fallsFrom(days, index)).toEqual([
      { from: "2024-01-05", depth: -0.5, peak: "2024-01-10", trough: "2024-01-12" },
      { from: "2024-01-12", depth: 0, peak: "2024-01-12", trough: "2024-01-12" },
    ]);
  });

  it("says nothing of a start inside the daily window, or before the account's", () => {
    const index = new Map([
      ["2026-01-02", 1],
      ["2026-01-05", 0.9],
    ]);
    expect(fallsFrom(["2025-01-01", "2026-01-02", "2026-01-05"], index)).toEqual([]);
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

describe("axis around money moving", () => {
  // Weekdays only, so a weekend never nets two movements on its own.
  const weekdays: string[] = [];
  for (let d = new Date("2024-01-01T12:00:00Z"); weekdays.length < 600; ) {
    if (d.getUTCDay() % 6 !== 0) weekdays.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Tuesday to Thursday of one week far before the daily window.
  const [out, back] = ["2024-03-12", "2024-03-14"];

  /** 10,000 in on the first day; 5,000 out on `out` and in again on
   *  `back`; the market swinging every day in between. */
  const ledger = weekdays.map((date, i) => {
    const invested = date >= out && date < back ? 5_000 : 10_000;
    const market = 1 + 0.2 * Math.sin(i / 3) + i / 2_000;
    return day(date, invested * market, i === 0 ? 0 : invested);
  });
  const prices = weekdays.map((date, i) => ({ date, close: 400 + 50 * Math.cos(i / 4) + i / 10 }));

  /** The page's formulas (homepage src/lib/client/portfolio.ts),
   *  over any series of the two. */
  function moneyReturn(
    value: number[],
    invested: number[],
    start: number,
    closes?: number[]
  ): number {
    const [v0, n0] = [value[start], invested[start]];
    let units = closes ? v0 / closes[start] : 0;
    let added = 0;
    const end = value.length - 1;
    for (let i = start + 1; i <= end; i++) {
      const flow = invested[i] - invested[i - 1];
      added += Math.max(0, flow);
      if (closes) units += flow / closes[i];
    }
    const now = closes ? units * closes[end] : value[end];
    return (now - v0 - (invested[end] - n0)) / (v0 + added);
  }
  function chained(value: number[], invested: number[], start: number): number {
    let level = 1;
    for (let i = start + 1; i < value.length; i++) {
      const flow = invested[i] - invested[i - 1];
      level *= (value[i] + Math.max(0, -flow)) / (value[i - 1] + Math.max(0, flow));
    }
    return level - 1;
  }

  it("keeps the day money moved and the day before, even in the weekly stretch", () => {
    const shown = axis(weekdays, [ledger]);
    expect(shown).toEqual(expect.arrayContaining(["2024-03-11", out, "2024-03-13", back]));
    expect(axis(weekdays)).not.toContain(out);
  });

  it("measures a range across the week as the daily days do", () => {
    const site = composeSite(
      {
        portfolio: { days: ledger, holdings: { holdings: [], total: 0 }, cash: [] },
        accounts: [],
        profiles: new Map(),
        closes: new Map(),
        benchmark: { marketPrice: prices.at(-1)?.close ?? 0, closes: prices },
      },
      { symbols: new Map(), accounts: new Map() },
      weekdays.at(-1) as string,
      weekdays.at(-1) as string
    );
    const [all] = site.accounts;
    const value = all.value as number[];
    const invested = all.invested as number[];
    const closes = site.benchmark.closes as number[];
    const daily = {
      value: ledger.map((entry) => entry.value),
      invested: ledger.map((entry) => entry.invested),
      closes: prices.map((price) => price.close),
    };
    // From the base, and from a Friday before the week, to the latest.
    for (const from of [weekdays[0], "2024-03-08"]) {
      const s = site.days.indexOf(from);
      const d = weekdays.indexOf(from);
      expect(moneyReturn(value, invested, s)).toBeCloseTo(
        moneyReturn(daily.value, daily.invested, d),
        5
      );
      expect(moneyReturn(value, invested, s, closes)).toBeCloseTo(
        moneyReturn(daily.value, daily.invested, d, daily.closes),
        5
      );
      expect(chained(value, invested, s)).toBeCloseTo(chained(daily.value, daily.invested, d), 5);
    }
    // Thinned without the week's two days, the same range reads otherwise.
    const weekly = axis(weekdays).map((date) => weekdays.indexOf(date));
    const pick = (series: number[]) => weekly.map((i) => series[i]);
    expect(
      Math.abs(
        moneyReturn(pick(daily.value), pick(daily.invested), 0) -
          moneyReturn(daily.value, daily.invested, 0)
      )
    ).toBeGreaterThan(0.01);
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
      growth: [1, 1, 1.1],
      falls: [],
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

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoToday } from "../../src/lib/http";
import { store } from "../../src/lib/snapshot";
import { moviesSite } from "../../src/services/movies";
import { musicSite } from "../../src/services/music";
import {
  nowSite,
  pickPortfolio,
  pickTokens,
  shiftMonths,
  TOKENS_DAYS,
  topModel,
} from "../../src/services/now";
import { portfolioSite } from "../../src/services/portfolio";
import { tokensSite } from "../../src/services/tokens/site";
import { call } from "../helpers";

const LISTEN = {
  at: "2026-09-27T09:00:00.000Z",
  title: "Let's Begin",
  artists: ["Devault"],
  url: "https://music.test/track/1",
  cover: { small: "https://music.test/s.webp", medium: "https://music.test/m.webp" },
};

const FILM = {
  title: "Make Zhonghe Great Again",
  year: 2025,
  url: "https://letterboxd.com/lkw123/film/x/",
  watched: "2026-09-22",
  rating: 1,
  rewatch: false,
  poster: "https://img.test/p.webp",
};

/** A portfolio view cut down to what the tile reads: the whole portfolio
 *  first, series that start after the axis does, a benchmark. */
const PORTFOLIO = {
  days: ["2026-06-30", "2026-07-01", "2026-07-20", "2026-07-23", "2026-07-24", "2026-10-23"],
  benchmark: { symbol: "VOO", label: "S&P 500", closes: [600, 601, 610, 612, 615, 650] },
  accounts: [
    {
      id: "all",
      value: [null, 0.5, 0.51, 1.05, 1.04, 1.1],
      invested: [null, 0.5, 0.5, 1, 1, 1],
    },
    { id: "ibkr", value: [1, 1, 1, 1, 1, 1], invested: [1, 1, 1, 1, 1, 1] },
  ],
  symbols: [],
};

/** From the last session on or before Jul 23, three months before. */
const PORTFOLIO_TILE = {
  days: ["2026-07-23", "2026-07-24", "2026-10-23"],
  value: [1.05, 1.04, 1.1],
  invested: [1, 1, 1],
  benchmark: [612, 615, 650],
};

const seed = async (today: string) => {
  await store(
    env,
    musicSite,
    JSON.stringify({
      schemaVersion: musicSite.version,
      stats: { plays: 1 },
      listens: [LISTEN, LISTEN],
    })
  );
  await store(
    env,
    moviesSite,
    JSON.stringify({ schemaVersion: moviesSite.version, profileUrl: "x", films: [FILM, FILM] })
  );
  await store(
    env,
    tokensSite,
    JSON.stringify({
      schemaVersion: tokensSite.version,
      daily: [
        { date: "2026-01-01", tokens: 5, cost: 1, messages: 1 },
        { date: today, tokens: 39_700_000, cost: 14.48, messages: 155, clients: {} },
      ],
      ranges: {
        week: {
          totals: { tokens: 40_000_000 },
          byModel: [{ model: "claude-opus-5-5", tokens: 38_000_000 }],
        },
      },
    })
  );
  await store(
    env,
    portfolioSite,
    JSON.stringify({ schemaVersion: portfolioSite.version, today, ...PORTFOLIO })
  );
};

beforeEach(() =>
  Promise.all(
    [musicSite, moviesSite, tokensSite, portfolioSite, nowSite].map(({ key }) =>
      env.CACHE.delete(key)
    )
  )
);
afterEach(() => vi.restoreAllMocks());

const zeros = (n: number) => Array.from({ length: n }, () => 0);

describe("pickTokens", () => {
  it("reads today's entry, a zero when there is none, null with no view", () => {
    const site = { daily: [{ date: "2026-09-27", tokens: 3, cost: 0.5, messages: 2 }] };
    expect(pickTokens(site, "2026-09-27")).toEqual({
      tokens: 3,
      cost: 0.5,
      messages: 2,
      recent: [...zeros(TOKENS_DAYS - 1), 3],
      top: null,
    });
    expect(pickTokens(site, "2026-09-28")).toEqual({
      tokens: 0,
      cost: 0,
      messages: 0,
      recent: [...zeros(TOKENS_DAYS - 2), 3, 0],
      top: null,
    });
    expect(pickTokens(null, "2026-09-28")).toBeNull();
  });

  it("keeps the last two weeks, oldest first, dropping anything older", () => {
    const site = {
      daily: [
        { date: "2026-09-13", tokens: 99, cost: 0, messages: 0 },
        { date: "2026-09-14", tokens: 7, cost: 0, messages: 0 },
        { date: "2026-09-20", tokens: 5, cost: 0, messages: 0 },
      ],
    };
    const { recent } = pickTokens(site, "2026-09-27")!;
    expect(recent).toHaveLength(TOKENS_DAYS);
    expect(recent[0]).toBe(7);
    expect(recent[6]).toBe(5);
    expect(recent.reduce((a, b) => a + b)).toBe(12);
  });
});

describe("topModel", () => {
  const site = (byModel: { model: string; tokens: number }[], total: number) => ({
    daily: [],
    ranges: { week: { totals: { tokens: total }, byModel } },
  });

  it("names the week's busiest model and its share of every token", () => {
    const week = site(
      [
        { model: "deepseek-v4.1-flash", tokens: 10 },
        { model: "claude-opus-5-5", tokens: 981 },
        { model: "unknown", tokens: 5000 },
      ],
      1000
    );
    expect(topModel(week)).toEqual({ model: "claude-opus-5-5", share: 0.981 });
  });

  it("is null for a quiet week or a view without one", () => {
    expect(topModel(site([], 0))).toBeNull();
    expect(topModel(site([{ model: "<synthetic>", tokens: 9 }], 9))).toBeNull();
    expect(topModel({ daily: [] })).toBeNull();
  });
});

describe("shiftMonths", () => {
  it("clamps to the target month's last day", () => {
    expect(shiftMonths("2026-10-23", -3)).toBe("2026-07-23");
    expect(shiftMonths("2026-05-31", -3)).toBe("2026-02-28");
    expect(shiftMonths("2026-01-15", -3)).toBe("2025-10-15");
  });
});

describe("pickPortfolio", () => {
  it("cuts the whole portfolio to its last three months", () => {
    expect(pickPortfolio(PORTFOLIO as never)).toEqual(PORTFOLIO_TILE);
  });

  it("starts where the account does when that is later", () => {
    const young = {
      ...PORTFOLIO,
      accounts: [
        {
          id: "all",
          value: [null, null, null, null, 1, 1.1],
          invested: [null, null, null, null, 1, 1],
        },
      ],
    };
    expect(pickPortfolio(young as never)).toEqual({
      days: ["2026-07-24", "2026-10-23"],
      value: [1, 1.1],
      invested: [1, 1],
      benchmark: [615, 650],
    });
  });

  it("is null with no view, no account or fewer than two days", () => {
    expect(pickPortfolio(null)).toBeNull();
    expect(pickPortfolio({ ...PORTFOLIO, accounts: [] } as never)).toBeNull();
    const fresh = {
      ...PORTFOLIO,
      accounts: [
        {
          id: "all",
          value: [null, null, null, null, null, 1],
          invested: [null, null, null, null, null, 1],
        },
      ],
    };
    expect(pickPortfolio(fresh as never)).toBeNull();
  });
});

describe("GET /now/site", () => {
  it("keeps one entry of each stored view, and asks no upstream", async () => {
    const today = isoToday();
    await seed(today);
    const fetched = vi.spyOn(globalThis, "fetch");
    const response = await call("/now/site");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: nowSite.version,
      today,
      listen: LISTEN,
      film: FILM,
      tokens: {
        tokens: 39_700_000,
        cost: 14.48,
        messages: 155,
        recent: [...zeros(TOKENS_DAYS - 1), 39_700_000],
        top: { model: "claude-opus-5-5", share: 0.95 },
      },
      portfolio: PORTFOLIO_TILE,
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("nulls a source with nothing stored, and never composes one", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const site = await (await call("/now/site")).json();
    expect(site).toMatchObject({ listen: null, film: null, tokens: null, portfolio: null });
    expect(fetched).not.toHaveBeenCalled();
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoToday } from "../../src/lib/http";
import { store } from "../../src/lib/snapshot";
import { flightsSite } from "../../src/services/flights";
import { moviesSite } from "../../src/services/movies";
import { musicSite } from "../../src/services/music";
import { nowSite, pickFlight, pickTokens } from "../../src/services/now";
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

const FLIGHTS = {
  airports: [
    { code: "JNH", city: "Jiaxing" },
    { code: "PEK", city: "Beijing" },
  ],
  last: {
    date: "2026-08-16",
    from: "JNH",
    to: "PEK",
    km: 1142,
    minutes: 135,
    airline: "Air China",
    aircraft: "Airbus A321",
  },
};

const FLIGHT = {
  date: "2026-08-16",
  from: { code: "JNH", city: "Jiaxing" },
  to: { code: "PEK", city: "Beijing" },
  km: 1142,
  minutes: 135,
  airline: "Air China",
  aircraft: "Airbus A321",
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
    })
  );
  await store(
    env,
    flightsSite,
    JSON.stringify({ schemaVersion: flightsSite.version, routes: [], ...FLIGHTS })
  );
};

beforeEach(() =>
  Promise.all(
    [musicSite, moviesSite, tokensSite, flightsSite, nowSite].map(({ key }) =>
      env.CACHE.delete(key)
    )
  )
);
afterEach(() => vi.restoreAllMocks());

describe("pickTokens", () => {
  it("reads today's entry, a zero when there is none, null with no view", () => {
    const site = { daily: [{ date: "2026-09-27", tokens: 3, cost: 0.5, messages: 2 }] };
    expect(pickTokens(site, "2026-09-27")).toEqual({ tokens: 3, cost: 0.5, messages: 2 });
    expect(pickTokens(site, "2026-09-28")).toEqual({ tokens: 0, cost: 0, messages: 0 });
    expect(pickTokens(null, "2026-09-28")).toBeNull();
  });
});

describe("pickFlight", () => {
  it("names each end by its city, null when there is no flight or no view", () => {
    expect(pickFlight(FLIGHTS as never)).toEqual(FLIGHT);
    const unknown = { airports: [], last: FLIGHTS.last } as never;
    expect(pickFlight(unknown)).toMatchObject({
      from: { code: "JNH", city: null },
      to: { code: "PEK", city: null },
    });
    expect(pickFlight({ airports: [], last: null } as never)).toBeNull();
    expect(pickFlight(null)).toBeNull();
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
      tokens: { tokens: 39_700_000, cost: 14.48, messages: 155 },
      flight: FLIGHT,
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("nulls a source with nothing stored, and never composes one", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const site = await (await call("/now/site")).json();
    expect(site).toMatchObject({ listen: null, film: null, tokens: null, flight: null });
    expect(fetched).not.toHaveBeenCalled();
  });
});

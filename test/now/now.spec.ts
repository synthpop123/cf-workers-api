import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoToday } from "../../src/lib/http";
import { store } from "../../src/lib/snapshot";
import { memosSite } from "../../src/services/memos";
import { moviesSite } from "../../src/services/movies";
import { musicSite } from "../../src/services/music";
import { nowSite, pickMemo, pickTokens } from "../../src/services/now";
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

const MEMO = {
  url: "https://mastodon.test/@lkw123/117342281905751669",
  at: "2026-09-27T09:25:27.717Z",
  edited: false,
  html: "<p>I like x.test &amp; Opus</p><p>second</p>",
  spoiler: "",
  sensitive: false,
  language: "en",
  emojis: [],
  media: [{ kind: "image" }],
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
    memosSite,
    JSON.stringify({ schemaVersion: memosSite.version, profileUrl: "x", memos: [MEMO, MEMO] })
  );
};

beforeEach(() =>
  Promise.all(
    [musicSite, moviesSite, tokensSite, memosSite, nowSite].map(({ key }) => env.CACHE.delete(key))
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

describe("pickMemo", () => {
  it("reduces the newest memo to one line, a warning in place of the words", () => {
    const site = { schemaVersion: 1, profileUrl: "x", memos: [MEMO] } as never;
    expect(pickMemo(site)).toEqual({
      at: MEMO.at,
      url: MEMO.url,
      text: "I like x.test & Opus second",
      cw: false,
      media: 1,
    });
    const warned = { memos: [{ ...MEMO, spoiler: "spoilers" }] } as never;
    expect(pickMemo(warned)).toMatchObject({ text: "spoilers", cw: true });
    expect(pickMemo(null)).toBeNull();
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
      memo: {
        at: MEMO.at,
        url: MEMO.url,
        text: "I like x.test & Opus second",
        cw: false,
        media: 1,
      },
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("nulls a source with nothing stored, and never composes one", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const site = await (await call("/now/site")).json();
    expect(site).toMatchObject({ listen: null, film: null, tokens: null, memo: null });
    expect(fetched).not.toHaveBeenCalled();
  });
});

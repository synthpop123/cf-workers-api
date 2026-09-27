import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoToday } from "../../src/lib/http";
import { refresh, store } from "../../src/lib/snapshot";
import { moviesSite } from "../../src/services/movies";
import { musicSite } from "../../src/services/music";
import { nowSite, pickTokens } from "../../src/services/now";
import { narrowStatus, plainText } from "../../src/services/now/mastodon";
import { tokensSite } from "../../src/services/tokens/site";
import { call, captureErrors } from "../helpers";

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

const STATUS = {
  id: "117342281905751669",
  created_at: "2026-09-27T09:25:27.717Z",
  url: "https://mastodon.test/@lkw123/117342281905751669",
  content:
    '<p>I like <a href="https://x.test/"><span class="invisible">https://</span>x.test</a> &amp; Opus</p><p>second</p>',
  spoiler_text: "",
  sensitive: false,
  media_attachments: [{ id: "1" }],
  account: { id: "1", acct: "lkw123" },
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
};

const mastodon = (answer: () => Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://mastodon.lkwplus.com");
    expect(url.pathname).toBe("/api/v1/accounts/114671030739656846/statuses");
    expect(url.searchParams.get("exclude_reblogs")).toBe("true");
    return answer();
  });

beforeEach(() =>
  Promise.all([musicSite, moviesSite, tokensSite, nowSite].map(({ key }) => env.CACHE.delete(key)))
);
afterEach(() => vi.restoreAllMocks());

describe("Mastodon narrowing", () => {
  it("turns status HTML into one line of plain text", () => {
    expect(plainText(STATUS.content)).toBe("I like x.test & Opus second");
    expect(plainText("a<br>b&#x27;s &#128512; &bogus;")).toBe("a b's 😀 &bogus;");
  });

  it("keeps only what the tile shows, the warning in place of the body", () => {
    expect(narrowStatus(STATUS)).toEqual({
      at: "2026-09-27T09:25:27.717Z",
      url: STATUS.url,
      text: "I like x.test & Opus second",
      cw: false,
      media: 1,
    });
    expect(narrowStatus({ ...STATUS, spoiler_text: "spoilers" })).toMatchObject({
      text: "spoilers",
      cw: true,
    });
    expect(() => narrowStatus({ ...STATUS, url: "javascript:alert(1)" })).toThrow("url");
    expect(() => narrowStatus({ ...STATUS, media_attachments: undefined })).toThrow();
  });
});

describe("pickTokens", () => {
  it("reads today's entry, a zero when there is none, null with no view", () => {
    const site = { daily: [{ date: "2026-09-27", tokens: 3, cost: 0.5, messages: 2 }] };
    expect(pickTokens(site, "2026-09-27")).toEqual({ tokens: 3, cost: 0.5, messages: 2 });
    expect(pickTokens(site, "2026-09-28")).toEqual({ tokens: 0, cost: 0, messages: 0 });
    expect(pickTokens(null, "2026-09-28")).toBeNull();
  });
});

describe("GET /now/site", () => {
  it("keeps one entry of each stored view and the newest memo", async () => {
    const today = isoToday();
    await seed(today);
    mastodon(() => Response.json([STATUS]));
    const response = await call("/now/site");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: nowSite.version,
      today,
      listen: LISTEN,
      film: FILM,
      tokens: { tokens: 39_700_000, cost: 14.48, messages: 155 },
      memo: {
        at: STATUS.created_at,
        url: STATUS.url,
        text: "I like x.test & Opus second",
        cw: false,
        media: 1,
      },
    });
  });

  it("nulls a source with nothing stored, and never composes one", async () => {
    const fetched = mastodon(() => Response.json([]));
    const site = await (await call("/now/site")).json();
    expect(site).toMatchObject({ listen: null, film: null, tokens: null, memo: null });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("keeps the last memo while the instance is down", async () => {
    await seed(isoToday());
    mastodon(() => Response.json([STATUS]));
    await refresh(env, nowSite);
    vi.restoreAllMocks();
    const logged = captureErrors();
    mastodon(() => new Response("down", { status: 502 }));
    const stored = await refresh(env, nowSite, isoToday(), null);
    expect(JSON.parse(stored.text).memo.url).toBe(STATUS.url);
    expect(logged).toHaveBeenCalledWith("Mastodon read failed", expect.any(Error));
  });
});

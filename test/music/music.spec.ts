import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_DAYS, composeSite, dayRange, LISTENS } from "../../src/services/music/compose";
import { narrowActivity, narrowListens, narrowStats } from "../../src/services/music/koito";
import { musicSite } from "../../src/services/music";
import { call } from "../helpers";

const STATS = {
  listen_count: 19835,
  track_count: 6313,
  album_count: 4943,
  artist_count: 2702,
  minutes_listened: 40712,
  days_active: 1493,
  longest_streak: 125,
  avg_daily_plays: 13.285332,
  tracks_per_artist: 2.3364174,
};

const listen = (id: number, time: string) => ({
  time,
  track: {
    id,
    title: `Track ${id}`,
    artists: [{ id: 1, name: "Aluna" }, { id: 2, name: "Riordan" }],
    image: {
      xs: `/image/${id}/64x64.webp`,
      small: `/image/${id}/128x128.webp`,
      medium: `/image/${id}/300x300.webp`,
    },
  },
});

const ACTIVITY = {
  activity: [
    { start_time: "2026-09-25T00:00:00+08:00", listens: 13 },
    { start_time: "2026-09-26T00:00:00+08:00", listens: 40 },
  ],
  streak: 12,
};

afterEach(() => vi.restoreAllMocks());

describe("Koito narrowing", () => {
  it("keeps the stats the page shows and rejects a renamed one", () => {
    expect(narrowStats(STATS)).not.toHaveProperty("tracks_per_artist");
    expect(() => narrowStats({ ...STATS, listen_count: undefined })).toThrow("listen_count");
  });

  it("drops listens it cannot render", () => {
    const items = [listen(1, "2026-09-26T05:50:34Z"), { time: "x", track: { id: 2 } }, null];
    expect(narrowListens({ items })).toHaveLength(1);
    expect(() => narrowListens({})).toThrow();
    expect(narrowActivity(ACTIVITY)).toHaveLength(2);
  });
});

describe("composeSite", () => {
  const data = {
    stats: narrowStats(STATS),
    activity: narrowActivity(ACTIVITY),
    listens: narrowListens({
      items: Array.from({ length: 14 }, (_, i) => listen(i + 1, "2026-09-26T05:50:34Z")),
    }),
  };

  it("zero-fills a dense year ending today", () => {
    const site = composeSite(data, "https://music.test/", "2026-09-26");
    expect(site.activity).toHaveLength(ACTIVITY_DAYS);
    expect(site.activity.at(-1)).toEqual({ date: "2026-09-26", plays: 40 });
    expect(site.activity.at(-2)).toEqual({ date: "2026-09-25", plays: 13 });
    expect(site.activity.at(-3)).toEqual({ date: "2026-09-24", plays: 0 });
    expect(site.activity[0].date).toBe(dayRange("2026-09-26", ACTIVITY_DAYS)[0]);
  });

  it("ships absolute URLs and the listens the page shows", () => {
    const site = composeSite(data, "https://music.test/", "2026-09-26");
    expect(site.stats).toEqual({
      plays: 19835,
      tracks: 6313,
      albums: 4943,
      artists: 2702,
      minutes: 40712,
      daysActive: 1493,
      avgDailyPlays: 13.3,
      longestStreak: 125,
    });
    expect(site.listens).toHaveLength(LISTENS);
    expect(site.listens[0]).toEqual({
      at: "2026-09-26T05:50:34.000Z",
      title: "Track 1",
      artists: ["Aluna", "Riordan"],
      url: "https://music.test/track/1",
      cover: {
        small: "https://music.test/image/1/128x128.webp",
        medium: "https://music.test/image/1/300x300.webp",
      },
    });
  });
});

describe("GET /music/site", () => {
  it("composes the three Koito calls into one snapshot", async () => {
    await env.CACHE.delete(musicSite.key);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://music.lkwplus.com");
      if (url.pathname.endsWith("/stats")) return Response.json(STATS);
      if (url.pathname.endsWith("/listen-activity")) {
        expect(url.searchParams.get("tz")).toBe("Asia/Shanghai");
        return Response.json(ACTIVITY);
      }
      expect(url.searchParams.get("limit")).toBe(String(LISTENS));
      return Response.json({ items: [listen(7, "2026-09-26T05:50:34Z")] });
    });
    const response = await call("/music/site");
    expect(response.status).toBe(200);
    const site = await response.json<{ schemaVersion: number; listens: unknown[] }>();
    expect(site.schemaVersion).toBe(musicSite.version);
    expect(site.listens).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoToday, shiftDays } from "../../src/lib/http";
import {
  composeSiteBody,
  RECENT_DAYS,
  SITE_VERSION,
  switchSite,
  TITLE_OVERRIDES,
} from "../../src/services/switch/site";
import { refresh } from "../../src/lib/snapshot";
import { call } from "../helpers";

const today = isoToday();
const yesterday = shiftDays(today, -1);
const longAgo = shiftDays(today, -(RECENT_DAYS + 5));

async function clear() {
  await env.SWITCH_DB.batch(
    [
      "daily_games",
      "daily_players",
      "daily_summaries",
      "games",
      "devices",
      "players",
      "exchange_rates",
    ].map((table) => env.SWITCH_DB.prepare(`DELETE FROM ${table}`))
  );
}

async function seed() {
  const now = Date.now();
  await env.SWITCH_DB.batch([
    env.SWITCH_DB.prepare(
      `INSERT INTO devices (id, label, region, platform_generation, icon_light_key, icon_dark_key, paired_at, first_seen, last_seen, raw)
       VALUES ('dev', 'Test Switch', 'JAPAN', 'P01', 'switch/devices/dev-light.png', NULL, 1787927289000, ?, ?, '{}')`
    ).bind(now, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO daily_summaries (device_id, date, result, playing_time, misc_time, observed_at, updated_at, raw)
       VALUES ('dev', ?, 'ACHIEVED', 40, 0, 1787980089000, ?, '{}')`
    ).bind(longAgo, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO daily_summaries (device_id, date, result, playing_time, misc_time, observed_at, updated_at, raw)
       VALUES ('dev', ?, 'CALCULATING', 90, 25, 1787980089000, ?, '{}')`
    ).bind(today, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO daily_games (device_id, date, player_id, application_id, playing_time, updated_at)
       VALUES ('dev', ?, 'p1', 'OLD', 40, ?)`
    ).bind(longAgo, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO daily_games (device_id, date, player_id, application_id, playing_time, updated_at)
       VALUES ('dev', ?, 'p1', 'NEW', 65, ?)`
    ).bind(today, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO games (application_id, title, image_key, total_playing_time, day_count, first_played_date, last_played_date, first_seen, updated_at)
       VALUES ('OLD', 'Old Game', NULL, 40, 1, ?, ?, ?, ?)`
    ).bind(longAgo, longAgo, now, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO games (application_id, title, store_title, image_key, shop_url, total_playing_time, day_count, first_played_date, last_played_date, price_hkd_cents, first_seen, updated_at)
       VALUES ('NEW', '新游戏', 'New Game', 'switch/games/abc_256-128.webp', 'https://shop.example/new', 65, 1, ?, ?, 32900, ?, ?)`
    ).bind(today, today, now, now),
    env.SWITCH_DB.prepare(
      `INSERT INTO exchange_rates (pair, rate, captured_at) VALUES ('HKD/CNY', 0.86, ?)`
    ).bind(now),
  ]);
}

describe("composeSiteBody", () => {
  beforeEach(clear);

  it("returns an empty but valid payload with no data", async () => {
    const site = await composeSiteBody(env);
    expect(site.schemaVersion).toBe(SITE_VERSION);
    expect(site.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(site.activity).toEqual([]);
    expect(site.games).toEqual([]);
    expect(site).not.toHaveProperty("devices");
    expect(site).not.toHaveProperty("generatedAt");
    expect(site.stats.totalMinutes).toBe(0);
    expect(site.stats.libraryValueCny).toBeNull();
    expect(site.observedAt).toBeNull();
  });

  it("shapes stats, a dense series, ranked games", async () => {
    await seed();
    const site = await composeSiteBody(env);

    expect(site.stats).toMatchObject({
      totalMinutes: 105,
      gameCount: 2,
      daysActive: 2,
      lastPlayedDate: today,
      // Only the priced title counts, converted at the stored rate.
      libraryValueCny: 283,
      pricedGameCount: 1,
    });

    // Time in games throughout: the console also logged 25 misc minutes
    // today, and neither the series nor the total counts them.
    expect(site.activity).toHaveLength(RECENT_DAYS + 6);
    expect(site.activity[0]).toEqual({ date: longAgo, minutes: 40 });
    expect(site.activity.at(-1)).toEqual({ date: today, minutes: 65 });
    expect(site.activity.find((d) => d.date === yesterday)?.minutes).toBe(0);

    expect(site.games.map((g) => g.applicationId)).toEqual(["NEW", "OLD"]);
    expect(site.games[0]).toMatchObject({
      // The storefront's name, not the console's.
      title: "New Game",
      recentMinutes: 65,
      totalMinutes: 65,
      shopUrl: "https://shop.example/new",
      imageUrl: `${env.IMAGE_BASE_URL}/switch/games/abc_256-128.webp`,
    });
    // Outside the recent window, so the lifetime total stands alone.
    expect(site.games[1]).toMatchObject({ totalMinutes: 40, recentMinutes: 0 });

    expect(site.observedAt).toBe(new Date(1787980089000).toISOString());
  });

  it("lets a hand-set name win over the store's and the console's", async () => {
    await seed();
    const [id, name] = [...TITLE_OVERRIDES][0];
    const now = Date.now();
    await env.SWITCH_DB.prepare(
      `INSERT INTO games (application_id, title, store_title, total_playing_time, day_count, first_seen, updated_at)
       VALUES (?, 'コンソール名', 'Store Name', 5, 1, ?, ?)`
    )
      .bind(id, now, now)
      .run();
    const site = await composeSiteBody(env);
    expect(site.games.find((g) => g.applicationId === id)?.title).toBe(name);
    expect(site.games.find((g) => g.applicationId === "NEW")?.title).toBe("New Game");
  });

  it("never leaks device serials or player identity", async () => {
    await seed();
    const body = JSON.stringify(await composeSiteBody(env));
    for (const field of ["serial", "nsaId", "playerId", "unlockCode", "raw"]) {
      expect(body).not.toContain(field);
    }
  });
});

describe("GET /switch/site", () => {
  beforeEach(async () => {
    await clear();
    await env.CACHE.delete(switchSite.key);
  });
  afterEach(() => vi.useRealTimers());

  const read = (etag?: string) =>
    call("/switch/site", { headers: etag ? { "If-None-Match": etag } : {} });

  it("reuses unchanged sync bytes and ETag but revalidates on data or day changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T05:00:00Z"));
    await refresh(env, switchSite);
    const first = await read();
    const etag = first.headers.get("ETag")!;
    const bytes = await first.text();
    vi.setSystemTime(new Date("2026-09-06T06:00:00Z"));
    await refresh(env, switchSite);
    expect(await (await read()).text()).toBe(bytes);
    const unchanged = await read(etag);
    expect(unchanged.status).toBe(304);
    // The edge hands the browser a weakened tag, which it echoes back.
    expect((await read(`W/${etag}`)).status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("Access-Control-Allow-Origin")).toBe("*");

    await env.CACHE.delete(switchSite.key);
    expect((await read(etag)).status).toBe(304);

    await seed();
    await refresh(env, switchSite);
    const changed = await read(etag);
    expect(changed.status).toBe(200);
    const changedTag = changed.headers.get("ETag")!;
    vi.setSystemTime(new Date("2026-09-07T05:00:00Z"));
    const nextDay = await read(changedTag);
    expect(nextDay.status).toBe(200);
    expect((await nextDay.json<{ today: string }>()).today).toBe("2026-09-07");
    const cached = await env.CACHE.getWithMetadata<{ day: string }>(switchSite.key, {
      type: "text",
    });
    expect(cached.metadata?.day).toBe("2026-09-07");
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../../src/services/switch/sync";
import type { Env } from "../../src/env";
import type { DailySummary } from "../../src/services/switch/moon/types";
import { captureErrors, imageResponse } from "../helpers";

const bindings = { ...env, PCTL_SESSION_TOKEN: "test-session" } as Env;
const cover = "https://example.com/i/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_256";
const day = (date: string, title: string, minutes: number): DailySummary => ({
  date,
  result: "ACHIEVED",
  playingTime: minutes + 10,
  miscTime: 10,
  players: [
    {
      profile: { playerId: "player", nickname: "Player" },
      playingTime: minutes,
      playedGames: [
        {
          applicationId: "GAME",
          playingTime: minutes - 5,
          meta: { title, imageUri: { medium: cover } },
        },
        { applicationId: "GAME", playingTime: 5, meta: { title, imageUri: { medium: cover } } },
      ],
    },
  ],
});
let days: DailySummary[];
/** Further consoles beyond "device", each with its own days; none has a whitelist. */
let extraDevices: Map<string, DailySummary[]>;
let whitelist: { applicationId: string; title?: string; firstPlayDate?: string }[];
let failDaily: boolean;
let failExtras: boolean;

beforeEach(async () => {
  await env.SWITCH_DB.batch(
    [
      "daily_games",
      "daily_players",
      "daily_summaries",
      "setting_snapshots",
      "players",
      "games",
      "devices",
      "account",
      "sync_runs",
      "exchange_rates",
    ].map((t) => env.SWITCH_DB.prepare(`DELETE FROM ${t}`))
  );
  days = [day("2026-09-01", "Older", 20), day("2026-09-02", "Latest", 30)];
  extraDevices = new Map();
  whitelist = [{ applicationId: "GAME", title: "Whitelist", firstPlayDate: "2026-08-01" }];
  await env.IMAGES.delete("switch/games/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_256-128.webp");
  failDaily = false;
  failExtras = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const deviceId = url.searchParams.get("deviceId") ?? "device";
    if (url.hostname === "accounts.nintendo.com") return Response.json({ id_token: "test-id" });
    if (url.pathname.endsWith("fetchUser"))
      return Response.json({ user: { nintendoAccountId: "account", nickname: "Owner" } });
    if (url.pathname.endsWith("fetchOwnedDevices"))
      return Response.json({
        ownedDevices: ["device", ...extraDevices.keys()].map((id) => ({
          deviceId: id,
          label: `Switch ${id}`,
          device: { id, synchronizedUnlockCode: "private-pin" },
        })),
      });
    if (url.pathname.endsWith("fetchDailySummaries"))
      return failDaily
        ? new Response("", { status: 503 })
        : Response.json({
            dailySummaries: extraDevices.get(deviceId) ?? days,
            lastUpdatedAt: 1788307200,
          });
    if (url.pathname.endsWith("fetchParentalControlSetting"))
      return failExtras
        ? new Response("", { status: 503 })
        : Response.json({
            parentalControlSetting: {
              deviceId,
              etag: `setting-${deviceId}`,
              unlockCode: "private-pin",
              customSettings: { synchronizedUnlockCode: "private-pin" },
              whitelistedApplicationList: deviceId === "device" ? whitelist : [],
            },
          });
    if (failExtras) throw new Error("Optional source unavailable");
    if (url.hostname === "example.com") return imageResponse();
    if (url.hostname === "api.frankfurter.dev") return Response.json({ rates: { CNY: 0.86 } });
    if (url.hostname === "ec.nintendo.com") return new Response("", { status: 404 });
    throw new Error(`Unexpected test URL: ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());
const game = () =>
  env.SWITCH_DB.prepare("SELECT * FROM games WHERE application_id = 'GAME'").first();

describe("runSync", () => {
  it("sums repeated game entries, enriches without replacing titles, and redacts PINs", async () => {
    const result = await runSync(bindings);
    expect(result).toMatchObject({ ok: true, deviceCount: 1, dayCount: 2, gameCount: 1 });
    expect(await game()).toMatchObject({
      title: "Latest",
      total_playing_time: 50,
      day_count: 2,
      first_play_date: "2026-08-01",
      first_played_date: "2026-09-01",
      last_played_date: "2026-09-02",
    });
    for (const table of ["devices", "setting_snapshots", "daily_summaries", "account"]) {
      const rows = await env.SWITCH_DB.prepare(`SELECT raw FROM ${table}`).all();
      expect(JSON.stringify(rows)).not.toMatch(/private-pin|unlockCode|synchronizedUnlockCode/);
    }
    expect(
      await env.SWITCH_DB.prepare("SELECT status FROM sync_runs WHERE id = ?")
        .bind(result.syncId)
        .first()
    ).toEqual({ status: "ok" });
  });

  it("recomputes totals and preserves days outside the rolling window on repeat syncs", async () => {
    await runSync(bindings);
    await env.SWITCH_DB.prepare(
      "UPDATE games SET first_seen = 42, shop_url = 'https://shop.example/game'"
    ).run();
    days = [day("2026-09-02", "Latest", 40)];
    await runSync(bindings);
    await runSync(bindings);
    expect(await game()).toMatchObject({
      total_playing_time: 60,
      day_count: 2,
      first_seen: 42,
      shop_url: "https://shop.example/game",
    });
  });

  it("chooses the newest title even when Nintendo returns newest days first", async () => {
    days[0].players![0].playedGames!.forEach((game) => {
      game.meta!.imageUri = {
        medium: "https://example.com/i/c/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_256",
      };
    });
    days.reverse();
    await runSync(bindings);
    expect(await game()).toMatchObject({ title: "Latest", image_medium: cover });
  });

  it("merges one title across consoles: minutes add up, the newest day names it", async () => {
    // The second console is iterated last but its day is older, so under a
    // last-writer-wins rule it would rename the game and drop the first
    // console's whitelist enrichment.
    extraDevices.set("second", [day("2026-08-30", "Stale name", 15)]);
    const result = await runSync(bindings);
    expect(result).toMatchObject({ deviceCount: 2, dayCount: 3, gameCount: 1 });
    expect(await game()).toMatchObject({
      title: "Latest",
      total_playing_time: 65,
      day_count: 3,
      first_play_date: "2026-08-01",
      first_played_date: "2026-08-30",
      last_played_date: "2026-09-02",
    });
    expect(
      await env.SWITCH_DB.prepare("SELECT COUNT(*) AS n FROM daily_games").first<{ n: number }>()
    ).toEqual({ n: 3 });
    expect(
      await env.SWITCH_DB.prepare(
        "SELECT device_id FROM setting_snapshots ORDER BY device_id"
      ).all()
    ).toMatchObject({ results: [{ device_id: "device" }, { device_id: "second" }] });
  });

  it("catalogs a whitelisted title nobody has played, at zero minutes", async () => {
    whitelist.push({ applicationId: "OWNED", title: "Owned only", firstPlayDate: "2026-07-01" });
    await runSync(bindings);
    expect(
      await env.SWITCH_DB.prepare("SELECT * FROM games WHERE application_id = 'OWNED'").first()
    ).toMatchObject({
      title: "Owned only",
      first_play_date: "2026-07-01",
      total_playing_time: 0,
      day_count: 0,
      first_played_date: null,
    });
    // Zero rows are dropped from the public ranking, from the count and from
    // the library value alike.
    const site = JSON.parse((await env.CACHE.get("switch:site")) ?? "{}");
    expect(site.stats.gameCount).toBe(1);
    expect(site.games.map((g: { applicationId: string }) => g.applicationId)).toEqual(["GAME"]);
  });

  it("records upstream failure without partially writing the sync", async () => {
    failDaily = true;
    await expect(runSync(bindings)).rejects.toThrow("Moon API 503");
    expect(await game()).toBeNull();
    expect(await env.SWITCH_DB.prepare("SELECT status FROM sync_runs").first()).toEqual({
      status: "error",
    });
  });

  it("keeps syncing when optional settings, artwork, stores and rates fail", async () => {
    const logged = captureErrors();
    failExtras = true;
    expect(await runSync(bindings)).toMatchObject({ ok: true, priceCount: 0 });
    expect(await game()).toMatchObject({
      total_playing_time: 50,
      first_play_date: null,
      image_key: null,
    });
    expect(logged).toHaveBeenCalled();
  });
});

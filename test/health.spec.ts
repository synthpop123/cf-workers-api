import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUE_BY } from "../src/health";
import { store } from "../src/lib/snapshot";
import { TRIGGERS } from "../src/schedule";
import { SERVICES } from "../src/services";
import { call } from "./helpers";

const seed = (day: string) =>
  Promise.all(
    SERVICES.map(({ site }) =>
      store(env, site, JSON.stringify({ schemaVersion: site.version }), day)
    )
  );

beforeEach(async () => {
  await Promise.all(SERVICES.map(({ site }) => env.CACHE.delete(site.key)));
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("GET /health", () => {
  it("is ok while every scheduled view is of today", async () => {
    vi.setSystemTime(new Date("2026-09-06T05:00:00Z")); // 13:00 in Shanghai
    await seed("2026-09-06");
    const response = await call("/health");
    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; views: Record<string, unknown> }>();
    expect(body.ok).toBe(true);
    expect(body.views.music).toEqual({
      day: "2026-09-06",
      changedAt: "2026-09-06T05:00:00.000Z",
      overdue: false,
    });
  });

  it("is 503 once a scheduled view is a day behind past its first run", async () => {
    vi.setSystemTime(new Date("2026-09-06T05:00:00Z"));
    await seed("2026-09-06");
    await store(env, SERVICES[1].site, "{}", "2026-09-05"); // switch
    const response = await call("/health");
    expect(response.status).toBe(503);
    const body = await response.json<{ views: Record<string, { overdue: boolean }> }>();
    expect(body.views.switch.overdue).toBe(true);
    expect(body.views.music.overdue).toBe(false);
  });

  it("gives each view until its first run of the day, and tokens for good", async () => {
    vi.setSystemTime(new Date("2026-09-05T16:10:00Z")); // 00:10 on the 6th
    await seed("2026-09-05");
    expect((await call("/health")).status).toBe(200);

    vi.setSystemTime(new Date("2026-09-05T17:00:00Z")); // 01:00: the heartbeat is past
    const body = await (await call("/health")).json<{
      views: Record<string, { overdue: boolean }>;
    }>();
    expect(body.views.music.overdue).toBe(true);
    expect(body.views.switch.overdue).toBe(false); // its sync is at 09:00
    expect(body.views.tokens.overdue).toBe(false); // written by submissions
  });

  it("covers every service but tokens, which no schedule writes", () => {
    const scheduled = SERVICES.map(({ name }) => name).filter((name) => name !== "tokens");
    expect(Object.keys(DUE_BY).sort()).toEqual([...scheduled].sort());
    expect(TRIGGERS.size).toBe(2);
  });
});

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDue, minuteOfDay, runScheduled, TRIGGERS } from "../src/schedule";
import { captureErrors } from "./helpers";

/** An instant given as Asia/Shanghai wall-clock time. */
const local = (time: string) => new Date(`2026-09-26T${time}:00+08:00`);

afterEach(() => vi.restoreAllMocks());

describe("triggers", () => {
  it("are exactly the cron triggers wrangler.jsonc declares", () => {
    expect([...TRIGGERS.keys()].sort()).toEqual([...env.TEST_CRONS].sort());
  });

  it("put every heartbeat cadence on a five-minute tick", () => {
    for (const job of TRIGGERS.get("*/5 * * * *") ?? []) {
      const cadence = job.cadence;
      if (!cadence) continue;
      if ("every" in cadence) expect(cadence.every % 5, job.name).toBe(0);
      else expect(Number(cadence.at.split(":")[1]) % 5, job.name).toBe(0);
    }
  });
});

describe("cadence", () => {
  it("counts minutes in the site's zone", () => {
    expect(minuteOfDay(local("00:00"))).toBe(0);
    expect(minuteOfDay(new Date("2026-09-26T01:00:00Z"))).toBe(9 * 60);
  });

  it("runs `every` jobs on multiples from midnight and `at` jobs once a day", () => {
    expect(isDue({ every: 30 }, local("10:30"))).toBe(true);
    expect(isDue({ every: 30 }, local("10:35"))).toBe(false);
    expect(isDue({ at: "00:00" }, local("00:00"))).toBe(true);
    expect(isDue({ at: "00:00" }, local("12:00"))).toBe(false);
    expect(isDue(undefined, local("12:34"))).toBe(true);
  });
});

describe("runScheduled", () => {
  const upstreams = () => {
    const hosts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
      return new Response("down", { status: 503 });
    });
    return hosts;
  };

  it("asks only the upstreams whose jobs are due", async () => {
    const logged = captureErrors();
    const hosts = upstreams();
    await runScheduled("*/5 * * * *", local("10:05"), env);
    expect(new Set(hosts)).toEqual(new Set(["music.lkwplus.com", "mastodon.lkwplus.com"]));

    hosts.length = 0;
    await runScheduled("*/5 * * * *", local("00:00"), env);
    expect(new Set(hosts)).toEqual(
      new Set(["music.lkwplus.com", "mastodon.lkwplus.com", "letterboxd.com", "flight.lkwplus.com"])
    );
    expect(logged).toHaveBeenCalled();
  });

  it("logs a failing job instead of throwing", async () => {
    upstreams();
    const logged = captureErrors();
    await expect(runScheduled("*/5 * * * *", local("10:05"), env)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith("refresh music:site failed", expect.any(Error));
  });
});

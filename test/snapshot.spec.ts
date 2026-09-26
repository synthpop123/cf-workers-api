import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  load,
  read,
  refresh,
  serve,
  siteHandler,
  type Snapshot,
  type SnapshotMeta,
} from "../src/lib/snapshot";

/** A snapshot whose body the test controls, counting compositions. */
function fake(initial: string) {
  const state = { body: initial, fail: false, composed: 0 };
  const snapshot: Snapshot = {
    key: "test:site",
    version: 3,
    compose: async (_env, today) => {
      state.composed += 1;
      if (state.fail) throw new Error("upstream down");
      return JSON.stringify({ schemaVersion: 3, today, body: state.body });
    },
  };
  return { snapshot, state };
}

const meta = async (key: string) =>
  (await env.CACHE.getWithMetadata<SnapshotMeta>(key)).metadata;

beforeEach(async () => {
  await env.CACHE.delete("test:site");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-06T05:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("snapshots", () => {
  it("composes on a miss and serves the stored copy after", async () => {
    const { snapshot, state } = fake("a");
    const first = await load(env, snapshot);
    expect(JSON.parse(first!.text)).toMatchObject({ body: "a", today: "2026-09-06" });
    expect(first!.meta).toMatchObject({ version: 3, day: "2026-09-06" });
    expect(first!.meta.etag).toMatch(/^"[0-9a-f]{64}"$/);

    state.body = "b";
    expect(JSON.parse((await load(env, snapshot))!.text).body).toBe("a");
    expect(state.composed).toBe(1);
  });

  it("skips the write when neither the bytes nor the day moved", async () => {
    const { snapshot, state } = fake("a");
    const first = await refresh(env, snapshot);
    vi.setSystemTime(new Date("2026-09-06T06:00:00Z"));
    const put = vi.spyOn(env.CACHE, "put");
    const again = await refresh(env, snapshot);
    expect(put).not.toHaveBeenCalled();
    expect(again.meta).toEqual(first.meta);

    state.body = "b";
    const changed = await refresh(env, snapshot);
    expect(put).toHaveBeenCalledTimes(1);
    expect(changed.meta.etag).not.toBe(first.meta.etag);
    expect(changed.meta.changedAt).toBe(Date.parse("2026-09-06T06:00:00Z"));
  });

  it("recomposes a copy from another day before serving it", async () => {
    const { snapshot, state } = fake("a");
    await refresh(env, snapshot);
    vi.setSystemTime(new Date("2026-09-06T16:30:00Z")); // 00:30 next day in Shanghai
    const next = await load(env, snapshot);
    expect(state.composed).toBe(2);
    expect(JSON.parse(next!.text).today).toBe("2026-09-07");
    expect((await meta("test:site"))?.day).toBe("2026-09-07");
  });

  it("serves an earlier day's copy when the recompose fails", async () => {
    const { snapshot, state } = fake("a");
    await refresh(env, snapshot);
    vi.setSystemTime(new Date("2026-09-08T05:00:00Z"));
    state.fail = true;
    const stale = await load(env, snapshot);
    expect(JSON.parse(stale!.text).today).toBe("2026-09-06");
  });

  it("never serves a copy of another schema version", async () => {
    const { snapshot, state } = fake("a");
    await refresh(env, { ...snapshot, version: 2 });
    expect(await read(env, snapshot)).toBeNull();
    state.fail = true;
    expect(await load(env, snapshot)).toBeNull();
  });

  it("serves 200 and 304 with one header set, matching weakened ETags", async () => {
    const { snapshot } = fake("a");
    const stored = await refresh(env, snapshot);
    const full = serve(new Request("https://api.test/"), stored);
    expect(full.status).toBe(200);
    expect(full.headers.get("Cache-Control")).toBe("no-cache");
    expect(full.headers.get("Last-Modified")).toBe("Sun, 06 Sep 2026 05:00:00 GMT");

    for (const tag of [stored.meta.etag, `W/${stored.meta.etag}`, `"x", W/${stored.meta.etag}`]) {
      const response = serve(
        new Request("https://api.test/", { headers: { "If-None-Match": tag } }),
        stored
      );
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(stored.meta.etag);
    }
  });

  it("answers 503 when there is nothing to serve", async () => {
    const { snapshot, state } = fake("a");
    state.fail = true;
    const handler = siteHandler(snapshot);
    const response = await handler(new Request("https://api.test/"), env, {} as ExecutionContext);
    expect(response.status).toBe(503);
  });
});

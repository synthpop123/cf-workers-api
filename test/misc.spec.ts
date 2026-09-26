import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../src/lib/snapshot";
import { flightsSite } from "../src/services/flights";
import { moviesSite } from "../src/services/movies";
import { musicSite } from "../src/services/music";
import { switchSite } from "../src/services/switch/site";
import { call, captureErrors } from "./helpers";

const SNAPSHOTS = [flightsSite, moviesSite, musicSite, switchSite];

beforeEach(async () => {
  await Promise.all(SNAPSHOTS.map((snapshot) => env.CACHE.delete(snapshot.key)));
  // No upstream answers: every section must come from what is stored.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
});
afterEach(() => vi.restoreAllMocks());

const seed = () =>
  Promise.all(
    [flightsSite, moviesSite, musicSite].map((snapshot) =>
      store(env, snapshot, JSON.stringify({ schemaVersion: snapshot.version, of: snapshot.key }))
    )
  );

describe("GET /misc", () => {
  it("bundles each stored snapshot verbatim under its section", async () => {
    await seed();
    await store(env, switchSite, JSON.stringify({ of: "switch" }));
    const response = await call("/misc");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      flights: { schemaVersion: flightsSite.version, of: "flights:site" },
      movies: { schemaVersion: moviesSite.version, of: "movies:site" },
      music: { schemaVersion: musicSite.version, of: "music:site" },
      switch: { of: "switch" },
    });
  });

  it("nulls only the section that has nothing to serve", async () => {
    const logged = captureErrors();
    await seed();
    await env.CACHE.delete(musicSite.key);
    const body = await (await call("/misc")).json<Record<string, unknown>>();
    expect(body.music).toBeNull();
    expect(body.flights).not.toBeNull();
    expect(logged).toHaveBeenCalled();
  });

  it("304s until any one section changes", async () => {
    await seed();
    const etag = (await call("/misc")).headers.get("ETag")!;
    const again = await call("/misc", { headers: { "If-None-Match": `W/${etag}` } });
    expect(again.status).toBe(304);

    await store(env, moviesSite, JSON.stringify({ schemaVersion: moviesSite.version, new: 1 }));
    const changed = await call("/misc", { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
  });
});

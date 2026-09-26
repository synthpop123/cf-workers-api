import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refresh } from "../../src/lib/snapshot";
import { flightsSite } from "../../src/services/flights";
import { SITE_VERSION } from "../../src/services/flights/compose";
import { call } from "../helpers";
import { upstream } from "./fixtures";

/** Answer AirTrail's list with these flights, checking the key goes along. */
const airtrail = (flights: unknown[]) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe("https://flight.lkwplus.com/api/flight/list");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    return Response.json({ success: true, flights });
  });

beforeEach(async () => {
  await env.CACHE.delete(flightsSite.key);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /flights/site", () => {
  it("composes from AirTrail on first read, redacted, and serves the stored copy after", async () => {
    const fetchSpy = airtrail([upstream()]);

    const first = await call("/flights/site");
    expect(first.status).toBe(200);
    const text = await first.text();
    expect(text).not.toContain("JYV0WB");
    expect(text).not.toContain("CCA1502");
    const body = JSON.parse(text);
    expect(body.schemaVersion).toBe(SITE_VERSION);
    expect(body.routes[0]).toMatchObject({ from: "PEK", to: "SHA", flights: 1 });

    expect((await call("/flights/site")).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when AirTrail is down and nothing is stored", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    const response = await call("/flights/site");
    expect(response.status).toBe(503);
  });

  it("is refreshed by the heartbeat rather than by reads", async () => {
    const fetchSpy = airtrail([upstream()]);
    await refresh(env, flightsSite);
    fetchSpy.mockClear();
    const response = await call("/flights/site");
    expect((await response.json<{ routes: unknown[] }>()).routes).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

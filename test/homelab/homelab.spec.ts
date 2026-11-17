import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homelabSite, METRICS_EVERY_MS, refreshHomelab } from "../../src/services/homelab";
import { narrowContainers, narrowSystems } from "../../src/services/homelab/beszel";
import { composeSite, type Site, stateOf } from "../../src/services/homelab/compose";
import { call } from "../helpers";

const NOW = Date.parse("2026-11-17T11:20:00Z");

const system = (id: string, name: string, status = "up", cpu = 27.4) => ({
  id,
  name,
  status,
  updated: "2026-11-17 11:19:42.824Z",
  info: { cpu, mp: 49.57, dp: 54.05, la: [2.6, 1.294, 0.84], u: 8227422, v: "0.21.2", bb: 3980989 },
  expand: {
    system_details_via_system: [
      {
        cores: 6,
        memory: 25197510656,
        arch: "x86_64",
        os_name: "Debian GNU/Linux 12 (bookworm)",
        hostname: "secret-hostname",
      },
    ],
  },
});

const container = (system: string, name: string, health: number, agoMs = 20_000) => ({
  system,
  name,
  health,
  updated: NOW - agoMs,
  image: "private/image:1",
  status: "Up 3 minutes",
});

const SYSTEMS = { items: [system("b", "Oracle ARM"), system("a", "Famesystems")] };
const CONTAINERS = {
  items: [
    container("a", "plex", 2),
    container("a", "plex", 2, 300_000), // the record of the container it replaced
    container("a", "gone", 2, 400_000), // removed, still held by the hub
    container("a", "kometa", 0),
    container("a", "n8n", 1),
    container("b", "sure", 3),
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("Beszel narrowing", () => {
  it("keeps the fields the view reads and drops the rest", () => {
    const [host] = narrowSystems({ items: [system("a", "Famesystems")] });
    expect(host.details).toEqual({
      cores: 6,
      memory: 25197510656,
      arch: "x86_64",
      os: "Debian GNU/Linux 12 (bookworm)",
    });
    expect(JSON.stringify(host)).not.toContain("secret-hostname");
    expect(host.updated).toBe(Date.parse("2026-11-17T11:19:42.824Z"));
  });

  it("rejects a renamed field or an unknown state", () => {
    const broken = system("a", "x");
    expect(() =>
      narrowSystems({ items: [{ ...broken, info: { ...broken.info, mp: undefined } }] })
    ).toThrow("mp");
    expect(() => narrowSystems({ items: [system("a", "x", "exploded")] })).toThrow("status");
    expect(() => narrowContainers({ items: [container("a", "x", 4)] })).toThrow("health");
    expect(() => narrowContainers({})).toThrow();
  });
});

describe("composeSite", () => {
  const data = { systems: narrowSystems(SYSTEMS), containers: narrowContainers(CONTAINERS) };

  it("keeps each host's latest report, one record per name", () => {
    const site = composeSite(data, "2026-11-17");
    expect(site.hosts.map((host) => host.name)).toEqual(["Famesystems", "Oracle ARM"]);
    const [fame, arm] = site.hosts;
    expect(fame.containers).toEqual([
      { name: "kometa", health: "none" },
      { name: "n8n", health: "starting" },
      { name: "plex", health: "healthy" },
    ]);
    expect(fame.health).toEqual({ healthy: 1, starting: 1, unhealthy: 0, none: 1 });
    expect(arm.health.unhealthy).toBe(1);
    expect(fame).toMatchObject({
      status: "up",
      cpu: 27,
      memory: 50,
      disk: 54,
      load: [2.6, 1.29, 0.84],
      cores: 6,
      seenAt: "2026-11-17T11:19:42.824Z",
    });
    expect(fame.bootedAt).toMatch(/:00\.000Z$/);
    expect(JSON.stringify(site)).not.toContain("private/image");
  });

  it("reports no metrics or containers for a host that is not up", () => {
    const down = composeSite(
      {
        systems: narrowSystems({ items: [system("a", "Famesystems", "down")] }),
        containers: data.containers,
      },
      "2026-11-17"
    );
    expect(down.hosts[0]).toMatchObject({
      status: "down",
      cpu: null,
      load: null,
      bootedAt: null,
      containers: [],
    });
  });

  it("states health apart from the metrics", () => {
    const busy = composeSite(
      {
        systems: narrowSystems({ items: [system("a", "Famesystems", "up", 90)] }),
        containers: data.containers,
      },
      "2026-11-17"
    );
    const calm = composeSite(
      {
        systems: narrowSystems({ items: [system("a", "Famesystems", "up", 3)] }),
        containers: data.containers,
      },
      "2026-11-17"
    );
    expect(stateOf(busy)).toBe(stateOf(calm));
  });
});

/** Answers the three Beszel calls; `cpu` and `health` vary per test. */
function mockBeszel(state: { cpu: number; health: number }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://beszel.lkwplus.com");
    if (url.pathname.endsWith("/auth-with-password")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        identity: "monitor@example.test",
        password: "test-beszel-password",
      });
      return Response.json({ token: "pb-token" });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("pb-token");
    if (url.pathname.includes("/systems/")) {
      return Response.json({ items: [system("a", "Famesystems", "up", state.cpu)] });
    }
    return Response.json({ items: [container("a", "plex", state.health)] });
  });
}

describe("GET /homelab/site", () => {
  it("composes the Beszel calls into one snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await env.CACHE.delete(homelabSite.key);
    const fetchSpy = mockBeszel({ cpu: 10, health: 2 });
    const response = await call("/homelab/site");
    expect(response.status).toBe(200);
    const site = await response.json<Site>();
    expect(site.schemaVersion).toBe(homelabSite.version);
    expect(site.hosts[0].containers).toEqual([{ name: "plex", health: "healthy" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("refreshHomelab", () => {
  it("stores health at once, and metrics only once they are stale", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    await env.CACHE.delete(homelabSite.key);
    const state = { cpu: 10, health: 2 };
    mockBeszel(state);
    const put = vi.spyOn(env.CACHE, "put");
    const today = "2026-11-17";

    await refreshHomelab(env, today);
    expect(put).toHaveBeenCalledTimes(1);

    state.cpu = 80; // the metrics moved, nothing else
    await refreshHomelab(env, today);
    expect(put).toHaveBeenCalledTimes(1);

    state.health = 3; // a container turned unhealthy
    await refreshHomelab(env, today);
    expect(put).toHaveBeenCalledTimes(2);

    state.cpu = 5;
    clock.mockReturnValue(NOW + METRICS_EVERY_MS);
    await refreshHomelab(env, today);
    expect(put).toHaveBeenCalledTimes(3);
    const stored = JSON.parse((await env.CACHE.get(homelabSite.key)) ?? "") as Site;
    expect(stored.hosts[0]).toMatchObject({ cpu: 5, health: { unhealthy: 1 } });
  });
});

import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/lib/router";
import { call, captureErrors } from "./helpers";

describe("routing", () => {
  it.each([
    ["/health", "GET", 200],
    ["/switch/sync", "POST", 401],
    ["/switch/sync", "GET", 405],
    ["/tokens/api/submit", "POST", 401],
    ["/tokens/site", "OPTIONS", 204],
    ["/api/site", "GET", 404],
    ["/missing", "GET", 404],
  ])("answers %s %s with %i and the static CORS set", async (path, method, status) => {
    const response = await call(path, {
      method,
      headers: { Origin: "https://untrusted.example" },
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers HEAD for a GET route with the headers and no body", async () => {
    const response = await call("/health", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.text()).toBe("");
  });

  it("names the methods a known path takes", async () => {
    const response = await call("/flights/site", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("lists the services on /health", async () => {
    expect(await (await call("/health")).json()).toEqual({
      ok: true,
      services: ["tokens", "switch", "flights", "music", "movies", "memos", "now"],
    });
  });

  it("answers a thrown handler with JSON and CORS, not the runtime's bare 500", async () => {
    const logged = captureErrors();
    const router = createRouter([
      [
        "GET /boom",
        () => {
          throw new Error("boom");
        },
      ],
    ]);
    const response = await router(
      new Request("https://api.test/boom"),
      env,
      createExecutionContext()
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "Internal error" });
    expect(logged).toHaveBeenCalled();
  });

  it("refuses a duplicate route", () => {
    const ok = () => new Response();
    expect(() =>
      createRouter([
        ["GET /a", ok],
        ["GET /a", ok],
      ])
    ).toThrow("Duplicate route");
  });
});

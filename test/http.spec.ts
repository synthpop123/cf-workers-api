import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOk, fetchUpstream, shiftDays } from "../src/lib/http";

describe("shiftDays", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("fetchUpstream", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bounds every request with a timeout unless the caller brings a signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await fetchUpstream("https://upstream.test/");
    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    const own = new AbortController().signal;
    await fetchUpstream("https://upstream.test/", { signal: own });
    expect(spy.mock.calls[1][1]?.signal).toBe(own);
  });

  it("fetchOk names the upstream when it answers non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    await expect(fetchOk("Koito stats", "https://upstream.test/")).rejects.toThrow(
      "Koito stats answered 503"
    );
  });
});

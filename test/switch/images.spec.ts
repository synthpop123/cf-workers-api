import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedKeys, publicUrl } from "../../src/lib/images";
import { coverSource, mirrorCover } from "../../src/services/switch/images";
import { captureErrors, imageResponse } from "../helpers";

const HASH = "f17751dcb0b347249d0aaf783edf1ea5";
const CDN = "https://atum-img-lp1.cdn.nintendo.net";
const SOURCE = `${CDN}/i/c/${HASH}_256`;

afterEach(() => vi.restoreAllMocks());

/** Stand in for the Nintendo CDN and count how often it is actually hit. */
function cdn(status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      status === 200 ? imageResponse() : new Response("", { status })
    );
}

describe("coverSource", () => {
  it("prefers the mirrored size and falls back through the bag", () => {
    expect(coverSource({ small: "s", medium: "m", large: "l" })).toBe("m");
    expect(coverSource({ small: "s", large: "l" })).toBe("s");
    expect(coverSource(undefined)).toBeNull();
  });
});

describe("mirrorCover", () => {
  it("copies a cover once, as WebP, keyed by the upstream hash", async () => {
    const key = `switch/games/${HASH}_256-128.webp`;
    await env.IMAGES.delete(key);
    const fetched = cdn();

    expect(await mirrorCover(env, SOURCE)).toEqual({ key, copied: true });
    const object = await env.IMAGES.get(key);
    expect(object?.httpMetadata?.contentType).toBe("image/webp");
    expect(object?.httpMetadata?.cacheControl).toContain("immutable");

    expect(await mirrorCover(env, SOURCE)).toEqual({ key, copied: false });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("ignores URLs that are not content-addressed covers", async () => {
    const fetched = cdn();
    expect(await mirrorCover(env, "https://example.com/cover.png")).toEqual({
      key: null,
      copied: false,
    });
    expect(await mirrorCover(env, null)).toEqual({ key: null, copied: false });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("leaves the key null when the CDN refuses", async () => {
    const missing = "0".repeat(32);
    await env.IMAGES.delete(`switch/games/${missing}_256-128.webp`);
    cdn(404);
    expect(await mirrorCover(env, `${CDN}/i/c/${missing}_256`)).toEqual({
      key: null,
      copied: false,
    });
  });

  it("stores nothing when the bytes are not an image", async () => {
    const other = "1".repeat(32);
    const key = `switch/games/${other}_256-128.webp`;
    await env.IMAGES.delete(key);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-an-image"));
    const errors = captureErrors();
    expect(await mirrorCover(env, `${CDN}/i/c/${other}_256`)).toEqual({ key: null, copied: false });
    expect(await env.IMAGES.head(key)).toBeNull();
    expect(errors).toHaveBeenCalled();
  });
});

describe("publicUrl", () => {
  it("joins the configured base with the object key", () => {
    expect(publicUrl(env, "switch/games/x.jpg")).toBe(`${env.IMAGE_BASE_URL}/switch/games/x.jpg`);
    expect(publicUrl(env, null)).toBeNull();
  });
});

describe("linkedKeys", () => {
  it("reads back every key a stored body links, and nothing else", () => {
    const body = JSON.stringify({
      poster: publicUrl(env, "movies/posters/a-1f-320.webp"),
      srcset: `${publicUrl(env, "memos/media/7-640.webp")} 640w`,
      elsewhere: "https://example.com/movies/posters/b.webp",
    });
    expect(linkedKeys(env, body)).toEqual(
      new Set(["movies/posters/a-1f-320.webp", "memos/media/7-640.webp"])
    );
    expect(linkedKeys(env, null)).toEqual(new Set());
  });
});

describe("known cover keys", () => {
  it("skips R2 only when the stored key matches the current content hash", async () => {
    const head = vi.spyOn(env.IMAGES, "head");
    const key = `switch/games/${HASH}_256-128.webp`;
    expect(await mirrorCover(env, SOURCE, new Set([key]))).toEqual({ key, copied: false });
    expect(head).not.toHaveBeenCalled();
    cdn();
    // A key from before the covers were resized counts as another key.
    await mirrorCover(env, SOURCE, new Set([`switch/games/${HASH}_256.jpg`]));
    expect(head).toHaveBeenCalledTimes(1);
  });
});

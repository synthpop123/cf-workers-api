import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memosSite } from "../../src/services/memos";
import { composeSite, toMedia } from "../../src/services/memos/compose";
import { narrowStatus, plainText } from "../../src/services/memos/mastodon";
import { linkedKeys } from "../../src/lib/images";
import { MAX_NEW, mirrorMedia, plan } from "../../src/services/memos/media";
import { call, captureErrors, imageResponse } from "../helpers";

const FILES = "https://mastodon-files.test/media_attachments/files";

const photo = (id: string, width = 4000, height = 3000) => ({
  id,
  type: "image",
  url: `${FILES}/${id}/original/a.jpg`,
  preview_url: `${FILES}/${id}/small/a.jpg`,
  description: " A cat ",
  blurhash: "UKO2?U%2Tw=w",
  meta: { original: { width, height }, small: { width: 640, height: 480 } },
});

const status = (over: Record<string, unknown> = {}) => ({
  id: "117342281905751669",
  created_at: "2026-09-27T09:25:27.717Z",
  edited_at: null,
  url: "https://mastodon.test/@lkw123/117342281905751669",
  content:
    '<p>I like <a href="https://x.test/"><span class="invisible">https://</span>x.test</a> &amp; Opus</p><p>second</p>',
  spoiler_text: "",
  sensitive: false,
  language: "en",
  visibility: "public",
  account: { id: "1", acct: "lkw123", note: "private-ish" },
  emojis: [{ shortcode: "blobcat", url: "https://mastodon-files.test/emoji/blobcat.png" }],
  media_attachments: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("Mastodon narrowing", () => {
  it("keeps only the fields the thread reads", () => {
    const narrowed = narrowStatus(status({ media_attachments: [photo("1")] }));
    expect(narrowed).toEqual({
      url: "https://mastodon.test/@lkw123/117342281905751669",
      createdAt: "2026-09-27T09:25:27.717Z",
      edited: false,
      content: expect.stringContaining("I like"),
      spoiler: "",
      sensitive: false,
      language: "en",
      emojis: [{ shortcode: "blobcat", url: "https://mastodon-files.test/emoji/blobcat.png" }],
      media: [
        {
          id: "1",
          type: "image",
          url: `${FILES}/1/original/a.jpg`,
          previewUrl: `${FILES}/1/small/a.jpg`,
          description: "A cat",
          width: 4000,
          height: 3000,
        },
      ],
    });
    expect(JSON.stringify(narrowed)).not.toContain("private-ish");
  });

  it("throws on a renamed field and drops links that are not http(s)", () => {
    expect(() => narrowStatus(status({ url: "javascript:alert(1)" }))).toThrow("url");
    expect(() => narrowStatus(status({ media_attachments: undefined }))).toThrow();
    const emojis = [{ shortcode: "x", url: "data:image/png;base64,AAAA" }];
    expect(narrowStatus(status({ emojis })).emojis).toEqual([]);
  });

  it("turns status HTML into one line of plain text", () => {
    expect(plainText(status().content as string)).toBe("I like x.test & Opus second");
    expect(plainText("a<br>b&#x27;s &#128512; &bogus;")).toBe("a b's 😀 &bogus;");
  });
});

describe("composeSite", () => {
  it("resolves attachments to what renders", () => {
    const [video, gifv, audio, unknown] = ["video", "gifv", "audio", "unknown"].map((type, i) => ({
      ...narrowStatus(status({ media_attachments: [photo(String(i))] })).media[0],
      type,
    }));
    expect(toMedia(video, undefined)).toMatchObject({
      kind: "video",
      src: video.previewUrl,
      loop: false,
    });
    expect(toMedia(gifv, undefined)).toMatchObject({ kind: "video", loop: true });
    expect(toMedia(audio, undefined)).toMatchObject({ kind: "audio", src: null });
    expect(toMedia(unknown, undefined)).toBeNull();
  });

  it("serves a photo from its copies, or from the instance until they exist", () => {
    const attachment = narrowStatus(status({ media_attachments: [photo("9")] })).media[0];
    const copies = [
      { url: "https://img.test/memos/media/9-640.webp", width: 640 },
      { url: "https://img.test/memos/media/9-1600.webp", width: 1600 },
    ];
    expect(toMedia(attachment, copies)).toMatchObject({
      src: copies[0].url,
      srcset: `${copies[0].url} 640w, ${copies[1].url} 1600w`,
      href: attachment.url,
      alt: "A cat",
    });
    expect(toMedia(attachment, undefined)).toMatchObject({
      src: attachment.previewUrl,
      srcset: null,
    });
  });

  it("drops a memo with nothing to show", () => {
    const empty = narrowStatus(status({ content: "<p></p>" }));
    const site = composeSite("https://mastodon.test/@lkw123", [empty], new Map());
    expect(site.memos).toEqual([]);
  });
});

describe("mirrorMedia", () => {
  beforeEach(async () => {
    const listed = await env.IMAGES.list({ prefix: "memos/" });
    await Promise.all(listed.objects.map(({ key }) => env.IMAGES.delete(key)));
  });

  it("plans one copy per distinct width, never wider than the original", () => {
    const [small] = narrowStatus(status({ media_attachments: [photo("5", 600, 400)] })).media;
    expect(plan(env, small).map(({ width }) => width)).toEqual([600]);
    const [large] = narrowStatus(status({ media_attachments: [photo("6")] })).media;
    expect(plan(env, large).map(({ width }) => width)).toEqual([640, 1600]);
  });

  it("copies new photos once, within a budget, and trusts the previous body", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const photos = Array.from({ length: MAX_NEW + 2 }, (_, i) => photo(String(100 + i)));
    const statuses = [narrowStatus(status({ media_attachments: photos }))];

    const first = await mirrorMedia(env, statuses, new Set());
    expect(first.size).toBe(MAX_NEW);
    expect(fetched).toHaveBeenCalledTimes(MAX_NEW * 2);
    const object = await env.IMAGES.get("memos/media/100-640.webp");
    expect(object?.httpMetadata?.contentType).toBe("image/webp");

    fetched.mockClear();
    const previous = JSON.stringify(composeSite("p", statuses, first));
    const second = await mirrorMedia(env, statuses, linkedKeys(env, previous));
    expect(second.size).toBe(MAX_NEW + 2);
    expect(fetched).toHaveBeenCalledTimes(2 * 2);
  });
});

describe("GET /memos/site", () => {
  beforeEach(() => env.CACHE.delete(memosSite.key));

  it("composes the newest statuses into a versioned snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "mastodon-files.test") return imageResponse();
      expect(url.origin).toBe("https://mastodon.lkwplus.com");
      expect(url.pathname).toBe("/api/v1/accounts/114671030739656846/statuses");
      expect(url.searchParams.get("exclude_reblogs")).toBe("true");
      return Response.json([status({ media_attachments: [photo("7")] })]);
    });
    const response = await call("/memos/site");
    expect(response.status).toBe(200);
    const site = await response.json<{
      schemaVersion: number;
      profileUrl: string;
      memos: { media: { srcset: string }[] }[];
    }>();
    expect(site.schemaVersion).toBe(memosSite.version);
    expect(site.profileUrl).toBe("https://mastodon.lkwplus.com/@lkw123");
    expect(site.memos[0].media[0].srcset).toContain("/memos/media/7-1600.webp 1600w");
  });

  it("answers 503 with nothing stored and the instance down", async () => {
    const logged = captureErrors();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    expect((await call("/memos/site")).status).toBe(503);
    expect(logged).toHaveBeenCalled();
  });
});

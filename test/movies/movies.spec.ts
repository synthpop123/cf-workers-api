import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moviesSite } from "../../src/services/movies";
import { composeSite, FILMS, latest } from "../../src/services/movies/compose";
import { decodeXml, parseFeed } from "../../src/services/movies/letterboxd";
import { posterSource } from "../../src/services/movies/posters";
import { call } from "../helpers";

const POSTER =
  "https://a.ltrbxd.com/resized/film-poster/1/9/7/0/1/2/197012-the-hateful-eight-0-600-0-900-crop.jpg?v=0428be5b84";

const item = (fields: Record<string, string>, poster = POSTER) =>
  `<item> <title>x</title> <link>${fields.link ?? "https://letterboxd.com/lkw123/film/x/"}</link>` +
  Object.entries(fields)
    .filter(([name]) => name !== "link")
    .map(([name, value]) => ` <letterboxd:${name}>${value}</letterboxd:${name}>`)
    .join("") +
  ` <description><![CDATA[ <p><img src="${poster}"/></p> <p>Watched.</p> ]]></description> </item>`;

const FEED = `<?xml version='1.0' encoding='utf-8'?><rss><channel>
${item({ watchedDate: "2026-09-20", rewatch: "No", filmTitle: "The Hateful Eight", filmYear: "2015", memberRating: "4.0" })}
${item({ watchedDate: "2026-09-22", rewatch: "Yes", filmTitle: "Fast &amp; Furious", filmYear: "2009" })}
<item> <title>A list</title> <link>https://letterboxd.com/lkw123/list/faves/</link> <description>list</description> </item>
</channel></rss>`;

beforeEach(async () => {
  await env.CACHE.delete(moviesSite.key);
});
afterEach(() => vi.restoreAllMocks());

describe("parseFeed", () => {
  it("keeps diary entries only, decoded and typed", () => {
    const entries = parseFeed(FEED);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: "The Hateful Eight",
      year: 2015,
      url: "https://letterboxd.com/lkw123/film/x/",
      watched: "2026-09-20",
      rating: 4,
      rewatch: false,
      poster: POSTER,
    });
    expect(entries[1]).toMatchObject({ title: "Fast & Furious", rating: null, rewatch: true });
  });

  it("decodes named and numeric references", () => {
    expect(decodeXml("&lt;&#233;&#xE9;&amp;amp;&gt;")).toBe("<éé&amp;>");
  });
});

describe("composition", () => {
  it("orders by watched date, not log order, and keeps the wall's worth", () => {
    const entries = parseFeed(FEED);
    expect(latest(entries).map((entry) => entry.watched)).toEqual(["2026-09-22", "2026-09-20"]);
    const many = Array.from({ length: 12 }, () => entries[0]);
    expect(latest(many)).toHaveLength(FILMS);
    expect(composeSite("lkw123", []).profileUrl).toBe("https://letterboxd.com/lkw123/");
  });

  it("maps a poster to its 460×690 crop and a versioned key", () => {
    expect(posterSource(POSTER)).toEqual({
      source: POSTER.replace("-0-600-0-900-crop", "-0-460-0-690-crop"),
      key: "movies/posters/197012-the-hateful-eight-0428be5b84.jpg",
    });
    // A poster the member picked for their diary lives under another path
    // and takes the same crops.
    const custom =
      "https://a.ltrbxd.com/resized/sm/upload/sw/w2/ep/v4/9O50TVszkz0dcP5g6Ej33UhR7vw-0-600-0-900-crop.jpg?v=5a65f5202f";
    expect(posterSource(custom)).toEqual({
      source: custom.replace("-0-600-0-900-crop", "-0-460-0-690-crop"),
      key: "movies/posters/9O50TVszkz0dcP5g6Ej33UhR7vw-5a65f5202f.jpg",
    });
    expect(posterSource("https://s.ltrbxd.com/static/img/empty-poster-230.png")).toBeNull();
    expect(posterSource("https://evil.example/resized/x-0-600-0-900-crop.jpg")).toBeNull();
  });
});

describe("GET /movies/site", () => {
  it("reads the feed, mirrors posters once and serves img.lkwplus.com URLs", async () => {
    const key = "movies/posters/197012-the-hateful-eight-0428be5b84.jpg";
    await env.IMAGES.delete(key);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://letterboxd.com/lkw123/rss/") return new Response(FEED);
      expect(url).toContain("-0-460-0-690-crop.jpg");
      return new Response("jpeg-bytes");
    });

    const response = await call("/movies/site");
    expect(response.status).toBe(200);
    const site = await response.json<{ films: { poster: string | null }[] }>();
    expect(site.films.map((film) => film.poster)).toEqual([
      `https://img.lkwplus.com/${key}`,
      `https://img.lkwplus.com/${key}`,
    ]);
    // One feed read, one poster copy: the second film shares the poster.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await (await env.IMAGES.get(key))?.text()).toBe("jpeg-bytes");
  });
});

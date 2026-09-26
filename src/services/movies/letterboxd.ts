/**
 * The Letterboxd side: the member's public RSS feed, fetched and parsed
 * into the diary entries it carries. The feed is a fixed, well-known
 * shape (RSS 2.0 plus `letterboxd:` elements), so it is read with a few
 * anchored patterns rather than an XML parser the runtime doesn't have.
 *
 * Only diary entries are kept — items with a `letterboxd:watchedDate`.
 * The same feed also carries lists, which have none.
 */

export interface DiaryEntry {
  title: string;
  year: number | null;
  /** The member's page for this viewing. */
  url: string;
  /** `YYYY-MM-DD`, the day the member logged it as watched. */
  watched: string;
  /** Half-star steps, 0.5–5; null when unrated. */
  rating: number | null;
  rewatch: boolean;
  /** The poster Letterboxd embeds in the item, at whatever size it chose. */
  poster: string | null;
}

const TIMEOUT_MS = 10_000;

export function feedUrl(user: string): string {
  return `https://letterboxd.com/${encodeURIComponent(user)}/rss/`;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Undo XML escaping: the five named entities and numeric references. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function element(item: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  if (!match) return null;
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(inner);
  return cdata ? cdata[1] : decodeXml(inner);
}

export function parseFeed(xml: string): DiaryEntry[] {
  const entries: DiaryEntry[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const watched = element(item, "letterboxd:watchedDate");
    const title = element(item, "letterboxd:filmTitle");
    const url = element(item, "link");
    if (!watched || !/^\d{4}-\d{2}-\d{2}$/.test(watched) || !title || !url) continue;
    if (!/^https:\/\/letterboxd\.com\//.test(url)) continue;

    const year = Number(element(item, "letterboxd:filmYear"));
    const rating = Number(element(item, "letterboxd:memberRating"));
    const description = element(item, "description") ?? "";
    const poster = /<img src="(https:\/\/[^"]+)"/.exec(description)?.[1] ?? null;

    entries.push({
      title,
      year: Number.isInteger(year) && year > 0 ? year : null,
      url,
      watched,
      rating: rating > 0 && rating <= 5 ? rating : null,
      rewatch: element(item, "letterboxd:rewatch") === "Yes",
      poster: poster ? decodeXml(poster) : null,
    });
  }
  return entries;
}

export async function fetchDiary(user: string): Promise<DiaryEntry[]> {
  const response = await fetch(feedUrl(user), {
    headers: { Accept: "application/rss+xml, application/xml" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Letterboxd answered ${response.status}`);
  return parseFeed(await response.text());
}

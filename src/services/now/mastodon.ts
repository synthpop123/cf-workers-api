/**
 * The newest status on the member's Mastodon account (`MASTODON_URL`,
 * `MASTODON_ACCOUNT`), boosts and replies excluded, narrowed by hand to
 * what the Now section shows: when, where it lives, one line of text and
 * how many attachments it carries. The status HTML never leaves here;
 * the page gets plain text, so it has nothing to sanitize.
 */

const TIMEOUT_MS = 10_000;

export interface Memo {
  /** ISO instant the status was posted. */
  at: string;
  url: string;
  /** Plain text: the content warning when there is one, else the body. */
  text: string;
  /** True when `text` is a content warning standing in for the body. */
  cw: boolean;
  /** Attachments of any kind. */
  media: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/** Status HTML to one run of plain text. Mastodon wraps paragraphs in
 *  `<p>`, breaks lines with `<br>`, and hides the scheme and tail of a
 *  long link in `<span class="invisible">`, which a reader never sees. */
export function plainText(html: string): string {
  return html
    .replace(/<span class="invisible">[^<]*<\/span>/g, "")
    .replace(/<br\s*\/?>|<\/p>\s*<p>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== "#") return ENTITIES.get(name.toLowerCase()) ?? entity;
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** One status, or a throw naming the field that no longer fits. */
export function narrowStatus(status: unknown): Memo {
  if (!isRecord(status)) throw new Error("Mastodon status is not an object");
  const { created_at: at, url, content, spoiler_text: spoiler, media_attachments: media } = status;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error("created_at");
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("url");
  if (typeof content !== "string") throw new Error("content");
  if (typeof spoiler !== "string") throw new Error("spoiler_text");
  if (!Array.isArray(media)) throw new Error("media_attachments");
  const warning = plainText(spoiler);
  return {
    at: new Date(at).toISOString(),
    url,
    text: warning || plainText(content),
    cw: warning !== "",
    media: media.length,
  };
}

/** The newest status, or null when the account has none. Rejects when
 *  the instance does. */
export async function fetchLatestMemo(instance: string, account: string): Promise<Memo | null> {
  const url = new URL(`/api/v1/accounts/${encodeURIComponent(account)}/statuses`, instance);
  url.search = "exclude_replies=true&exclude_reblogs=true&limit=1";
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Mastodon answered ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Mastodon statuses is not a list");
  return body.length ? narrowStatus(body[0]) : null;
}

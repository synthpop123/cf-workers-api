/**
 * The member's public Mastodon statuses (`MASTODON_URL`,
 * `MASTODON_ACCOUNT`), boosts and replies excluded, narrowed by hand to
 * the fields the memos view reads. A renamed or retyped field throws,
 * which fails the composition instead of shipping a different shape.
 * Everything else on a status (account, application, mentions, counts,
 * visibility, the attachment ids' blurhashes) is never typed.
 */

const TIMEOUT_MS = 10_000;

export interface Emoji {
  shortcode: string;
  url: string;
}

export interface Attachment {
  id: string;
  /** Mastodon's own: image, gifv, video, audio, unknown. */
  type: string;
  url: string;
  previewUrl: string | null;
  description: string | null;
  /** The original's size, when Mastodon measured it. */
  width: number | null;
  height: number | null;
}

export interface Status {
  url: string;
  createdAt: string;
  edited: boolean;
  /** Status HTML as Mastodon renders it. The page sanitizes it. */
  content: string;
  spoiler: string;
  sensitive: boolean;
  language: string | null;
  emojis: Emoji[];
  media: Attachment[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHttp = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//.test(value);

const dimension = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

function narrowAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) throw new Error("media_attachments[] is not an object");
  const { id, type, url, preview_url: preview, description, meta } = value;
  if (typeof id !== "string" || typeof type !== "string") throw new Error("attachment id/type");
  // A failed transcode leaves an attachment with no file: nothing to show.
  if (!isHttp(url)) return null;
  const original = isRecord(meta) && isRecord(meta.original) ? meta.original : {};
  return {
    id,
    type,
    url,
    previewUrl: isHttp(preview) ? preview : null,
    description: typeof description === "string" && description.trim() ? description.trim() : null,
    width: dimension(original.width),
    height: dimension(original.height),
  };
}

/** One status, or a throw naming the field that no longer fits. */
export function narrowStatus(status: unknown): Status {
  if (!isRecord(status)) throw new Error("Mastodon status is not an object");
  const {
    url,
    created_at: createdAt,
    edited_at: editedAt,
    content,
    spoiler_text: spoiler,
    sensitive,
    language,
    emojis,
    media_attachments: media,
  } = status;
  if (!isHttp(url)) throw new Error("url");
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("created_at");
  }
  if (typeof content !== "string") throw new Error("content");
  if (typeof spoiler !== "string") throw new Error("spoiler_text");
  if (!Array.isArray(emojis)) throw new Error("emojis");
  if (!Array.isArray(media)) throw new Error("media_attachments");
  return {
    url,
    createdAt: new Date(createdAt).toISOString(),
    edited: typeof editedAt === "string",
    content,
    spoiler: spoiler.trim(),
    sensitive: sensitive === true,
    language: typeof language === "string" ? language : null,
    emojis: emojis.flatMap((emoji) =>
      isRecord(emoji) && typeof emoji.shortcode === "string" && isHttp(emoji.url)
        ? [{ shortcode: emoji.shortcode, url: emoji.url }]
        : []
    ),
    media: media.flatMap((attachment) => {
      const item = narrowAttachment(attachment);
      return item ? [item] : [];
    }),
  };
}

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

/** The newest `limit` statuses. Rejects when the instance does. */
export async function fetchStatuses(
  instance: string,
  account: string,
  limit: number
): Promise<Status[]> {
  const url = new URL(`/api/v1/accounts/${encodeURIComponent(account)}/statuses`, instance);
  url.search = `exclude_replies=true&exclude_reblogs=true&limit=${limit}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Mastodon answered ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Mastodon statuses is not a list");
  return body.map(narrowStatus);
}

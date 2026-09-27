/**
 * The pure layer: narrowed statuses and their stored photo copies in, the
 * public /memos/site body out.
 *
 * Each memo is what the thread on lkwplus.com/memos draws: its permalink,
 * time, the status HTML (the page runs it through its own allow-list
 * sanitizer), the content warning, custom emoji and attachments already
 * resolved to what renders — a photo as a `src` plus a `srcset` of its
 * stored copies, a video or gifv as the file with its preview as poster,
 * audio as the file. Alt text is the attachment's own description or
 * null; the page supplies a fallback from the memo's words.
 */

import { type Emoji, plainText, type Status } from "./mastodon";
import type { Rendition } from "./media";

export const SITE_VERSION = 1;
/** How many memos the thread shows. */
export const MEMOS = 20;

export type MediaKind = "image" | "video" | "audio";

export interface SiteMedia {
  kind: MediaKind;
  /** The original file: a photo's link target, a video's or audio's source. */
  href: string;
  /** What paints first: the photo, or a video's poster frame. */
  src: string | null;
  srcset: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  /** gifv: an mp4 standing in for a GIF, played muted on a loop. */
  loop: boolean;
}

export interface SiteMemo {
  url: string;
  at: string;
  edited: boolean;
  html: string;
  spoiler: string;
  sensitive: boolean;
  language: string | null;
  emojis: Emoji[];
  media: SiteMedia[];
}

export interface Site {
  schemaVersion: number;
  profileUrl: string;
  memos: SiteMemo[];
}

/** Mastodon attachment type → what it renders as. `unknown` (a failed
 *  transcode) has no entry, so it is dropped. */
const KINDS = new Map<string, MediaKind>([
  ["image", "image"],
  ["gifv", "video"],
  ["video", "video"],
  ["audio", "audio"],
]);

export function toMedia(
  attachment: Status["media"][number],
  copies: Rendition[] | undefined
): SiteMedia | null {
  const kind = KINDS.get(attachment.type);
  if (!kind) return null;
  const { url: href, previewUrl, width, height, description: alt } = attachment;
  const base = { kind, href, width, height, alt, loop: attachment.type === "gifv" };
  if (kind !== "image") return { ...base, src: kind === "video" ? previewUrl : null, srcset: null };
  if (!copies?.length) return { ...base, src: previewUrl ?? href, srcset: null };
  return {
    ...base,
    src: copies[0].url,
    srcset:
      copies.length > 1 ? copies.map(({ url, width }) => `${url} ${width}w`).join(", ") : null,
  };
}

/** A memo, or null for one left with nothing to show: no words, no
 *  warning, no attachment the page can render. */
export function toMemo(status: Status, mirrored: Map<string, Rendition[]>): SiteMemo | null {
  const media = status.media.flatMap((attachment) => {
    const item = toMedia(attachment, mirrored.get(attachment.id));
    return item ? [item] : [];
  });
  if (!plainText(status.content) && !status.spoiler && media.length === 0) return null;
  return {
    url: status.url,
    at: status.createdAt,
    edited: status.edited,
    html: status.content,
    spoiler: status.spoiler,
    sensitive: status.sensitive,
    language: status.language,
    emojis: status.emojis,
    media,
  };
}

export function composeSite(
  profileUrl: string,
  statuses: Status[],
  mirrored: Map<string, Rendition[]>
): Site {
  return {
    schemaVersion: SITE_VERSION,
    profileUrl,
    memos: statuses.flatMap((status) => {
      const memo = toMemo(status, mirrored);
      return memo ? [memo] : [];
    }),
  };
}

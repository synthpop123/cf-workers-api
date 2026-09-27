/**
 * Photos attached to memos are copied into R2 (`memos/media/…`) as WebP
 * at two widths, scaled down with their ratio kept (lib/images.ts): 640
 * for a grid cell and 1600 for a dense screen or the lightbox. Mastodon's
 * own files are the phone's originals, several megabytes each, and were
 * what made /memos the slowest page on the site.
 *
 * The key is the attachment's id and the requested width. An attachment
 * never changes its file, so a key is copied once. The previous body
 * already names every copy that exists, so a copy found there is taken as
 * present without asking R2; only new attachments cost a fetch, and at
 * most `MAX_NEW` of them per run, so a burst of posts cannot spend the
 * invocation's subrequests. One that waits keeps Mastodon's own file for
 * now (the instance is self-hosted, so that is no one else's CDN) and is
 * copied on a later run.
 *
 * Video, gifv and audio are streamed from the instance as they are: the
 * Images binding transforms stills only.
 */

import type { Env } from "../../env";
import { mirrorImage, publicUrl } from "../../lib/images";
import type { Attachment, Status } from "./mastodon";

const WIDTHS = [640, 1600] as const;
/** New attachments copied per run; each costs one fetch per width. */
export const MAX_NEW = 6;
const ID_RE = /^\w+$/;

export interface Rendition {
  url: string;
  /** The width it was stored at: the requested one, or the original's
   *  when that is narrower (scale-down never enlarges). */
  width: number;
}

interface Planned extends Rendition {
  key: string;
  /** The width asked of the transform, which the key names. */
  target: number;
}

/** The copies an attachment is stored as, narrowest first, one per
 *  distinct output width. */
export function plan(env: Env, attachment: Attachment): Planned[] {
  if (attachment.type !== "image" || !ID_RE.test(attachment.id)) return [];
  const planned: Planned[] = [];
  for (const target of WIDTHS) {
    const width = attachment.width ? Math.min(target, attachment.width) : target;
    if (planned.some((copy) => copy.width === width)) continue;
    const key = `memos/media/${attachment.id}-${target}.webp`;
    planned.push({ key, target, width, url: publicUrl(env, key) as string });
  }
  return planned;
}

/**
 * The stored copies of every photo in `statuses`, by attachment id.
 * `previous` is the body last stored, whose URLs stand for copies that
 * already exist. An attachment missing from the map has no copies yet.
 */
export async function mirrorMedia(
  env: Env,
  statuses: Status[],
  previous: string | null
): Promise<Map<string, Rendition[]>> {
  const mirrored = new Map<string, Rendition[]>();
  let budget = MAX_NEW;
  for (const attachment of statuses.flatMap((status) => status.media)) {
    const copies = plan(env, attachment);
    if (copies.length === 0) continue;
    const renditions = copies.map(({ url, width }) => ({ url, width }));
    // A URL is unique to its attachment and width, and the previous body
    // only names copies that were stored.
    if (previous && copies.every(({ url }) => previous.includes(url))) {
      mirrored.set(attachment.id, renditions);
      continue;
    }
    if (budget === 0) continue;
    budget -= 1;
    const results = await Promise.all(
      copies.map(({ key, target }) =>
        mirrorImage(env, key, attachment.url, { width: target, fit: "scale-down" })
      )
    );
    if (results.every((result) => result !== "failed")) mirrored.set(attachment.id, renditions);
  }
  return mirrored;
}

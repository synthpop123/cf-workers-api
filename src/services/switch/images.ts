/**
 * Mirrors Nintendo's artwork into R2 at sync time so the public payload
 * never points at their CDN.
 *
 * Covers are content-addressed upstream (`…/i/c/<hash>_<size>`), so the
 * hash is the key and a cover is copied once. Matching keys already stored
 * in D1 skip the R2 existence check as well.
 *
 * Nothing here is allowed to fail a sync: a mirror that doesn't happen leaves
 * the row's key NULL and the payload simply omits the image.
 */

import type { Env } from "../../env";
import { mirrorImage } from "../../lib/images";
import type { ImageUri } from "./moon/types";

const PREFIX = "switch";
/** Covers are served at ~2× a 64px chip; the 1024 variant buys nothing. */
const COVER_SIZE = "medium";

/** `https://…/i/c/<hash>_256` → `<hash>_256`, or null for anything else. */
function coverName(url: string): string | null {
  const match = /\/i\/c\/([0-9a-f]{32})_(\d+)$/.exec(url);
  return match ? `${match[1]}_${match[2]}` : null;
}

/**
 * Copy a game cover, returning its R2 key. Existing objects are not refetched
 * — the upstream hash changing means a new key, not new bytes at the old one.
 */
export async function mirrorCover(
  env: Env,
  imageUrl: string | null,
  knownKey?: string | null
): Promise<{ key: string | null; copied: boolean }> {
  if (!imageUrl) return { key: null, copied: false };
  const name = coverName(imageUrl);
  if (!name) return { key: null, copied: false };

  const key = `${PREFIX}/games/${name}.jpg`;
  if (knownKey === key) return { key, copied: false };
  const result = await mirrorImage(env, key, imageUrl, "image/jpeg");
  return result === "failed" ? { key: null, copied: false } : { key, copied: result === "copied" };
}

/** Pick the cover size the mirror stores, falling back through the bag. */
export function coverSource(uri: ImageUri | undefined | null): string | null {
  if (!uri) return null;
  return (
    uri[COVER_SIZE] ?? uri.small ?? uri.large ?? uri.extraLarge ?? uri.extraSmall ?? null
  );
}

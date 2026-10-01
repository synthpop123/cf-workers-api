/**
 * Posters are mirrored into R2 (`movies/posters/…`) so the wall loads from
 * img.lkwplus.com like every other piece of artwork on the site, instead
 * of hotlinking Letterboxd's CDN.
 *
 * Letterboxd serves any poster at a set of fixed crops named in the URL
 * (`…-0-600-0-900-crop.jpg?v=<hash>`); the mirror fetches the 460×690
 * crop and stores it at 320×480 WebP (lib/images.ts), enough for a card
 * drawn ~156px wide at 2× or ~110px wide at 3×. Both kinds of poster take the
 * same crops: a film's own (`/resized/film-poster/1/2/…/<id>-<slug>-…`) and
 * one a member picked for their diary (`/resized/sm/upload/…/<hash>-…`).
 *
 * The key is the file's last path segment plus its `v` hash, which changes
 * when the artwork does, plus the stored width — so a poster is copied
 * once, and a replaced one (or a new size) lands under a new key. A key
 * the previous body already links is taken as stored without asking R2.
 */

import { mirrorImage, publicUrl, type Size } from "../../lib/images";

const CROP = "-0-460-0-690-crop";
const SIZE: Size = { width: 320, height: 480 };
const POSTER_RE =
  /^https:\/\/a\.ltrbxd\.com\/resized\/(?:[\w-]+\/)+([\w-]+?)-0-\d+-0-\d+-crop\.jpg(?:\?v=([0-9a-f]+))?$/;

/** The crop to copy and the key to store it under, or null for a URL
 *  that isn't a Letterboxd film poster. */
export function posterSource(url: string): { source: string; key: string } | null {
  const match = POSTER_RE.exec(url);
  if (!match) return null;
  const [, slug, version] = match;
  return {
    source: url.replace(/-0-\d+-0-\d+-crop/, CROP),
    key: `movies/posters/${slug}${version ? `-${version}` : ""}-${SIZE.width}.webp`,
  };
}

/** Mirror one poster, returning its public URL or null. */
export async function mirrorPoster(
  env: Env,
  url: string | null,
  known?: ReadonlySet<string>
): Promise<string | null> {
  const poster = url ? posterSource(url) : null;
  if (!poster) return null;
  const result = await mirrorImage(env, poster.key, poster.source, SIZE, known);
  return result === "failed" ? null : publicUrl(env, poster.key);
}

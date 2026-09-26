/**
 * Posters are mirrored into R2 (`movies/posters/…`) so the wall loads from
 * img.lkwplus.com like every other piece of artwork on the site, instead
 * of hotlinking Letterboxd's CDN.
 *
 * Letterboxd serves any poster at a set of fixed crops named in the URL
 * (`…-0-600-0-900-crop.jpg?v=<hash>`); the mirror stores the 460×690 crop,
 * twice the ~230px a card is ever drawn at. The key is the poster's slug
 * plus its `v` hash, which changes when the artwork does — so a poster is
 * copied once, and a replaced one lands under a new key.
 */

import type { Env } from "../../env";
import { mirrorImage, publicUrl } from "../../lib/images";

const CROP = "-0-460-0-690-crop";
const POSTER_RE =
  /^https:\/\/a\.ltrbxd\.com\/resized\/film-poster\/(?:\d+\/)+([a-z0-9-]+?)-0-\d+-0-\d+-crop\.jpg(?:\?v=([0-9a-f]+))?$/;

/** The crop to copy and the key to store it under, or null for a URL
 *  that isn't a Letterboxd film poster. */
export function posterSource(url: string): { source: string; key: string } | null {
  const match = POSTER_RE.exec(url);
  if (!match) return null;
  const [, slug, version] = match;
  return {
    source: url.replace(/-0-\d+-0-\d+-crop/, CROP),
    key: `movies/posters/${slug}${version ? `-${version}` : ""}.jpg`,
  };
}

/** Mirror one poster, returning its public URL or null. */
export async function mirrorPoster(env: Env, url: string | null): Promise<string | null> {
  const poster = url ? posterSource(url) : null;
  if (!poster) return null;
  const result = await mirrorImage(env, poster.key, poster.source, "image/jpeg");
  return result === "failed" ? null : publicUrl(env, poster.key);
}

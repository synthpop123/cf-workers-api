/**
 * The image mirror: third-party artwork is copied into the shared R2
 * bucket (`IMAGES`, served publicly at `IMAGE_BASE_URL`) when a service
 * composes, so no payload hotlinks anyone's CDN. Each service writes under
 * its own prefix (`switch/`, `movies/`).
 *
 * Keys are content-addressed by the caller — derived from an upstream URL
 * that changes when the bytes do — so an object is copied once and never
 * rewritten, which is what makes the `immutable` cache header true.
 *
 * Every copy is shrunk on the way in: the Images binding
 * (`IMAGE_TRANSFORM`) crops it to the size the page draws at, times the
 * densest screen that matters (or, for a photo, scales it down to a width
 * with its ratio kept), and re-encodes it as WebP. Upstream art is
 * sized for someone else's layout (Nintendo's 256px covers are drawn at
 * 44px here), and a copy made once is served for good, so this is the one
 * place the bytes can be made to fit. The key names the output — callers
 * give it a `.webp` extension and the size — so a change of size is a new
 * key, never new bytes under an old one.
 *
 * A copy is made once, so most compositions only need to know it is
 * there. Each caller knows that without asking R2 — the switch catalog
 * keeps its keys in D1, and the other views' last stored bodies link
 * every copy they made (`linkedKeys`) — and passes the keys it knows as
 * `known`; only a key outside them costs an R2 lookup.
 *
 * Nothing here may fail a composition: a copy that doesn't happen reports
 * `failed` and the payload simply omits that image. Nothing partial is
 * stored either, so the next composition tries again.
 */

import { fetchUpstream } from "./http";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const FORMAT = "image/webp";
const QUALITY = 80;

export type Mirrored = "copied" | "present" | "failed";

/**
 * What the copy is shrunk to, in pixels: a box it is cropped to fill
 * (artwork drawn at a fixed shape), or with `fit: "scale-down"` a width
 * it is scaled down to keep, ratio intact and never enlarged (photos).
 */
export type Size =
  | { width: number; height: number; fit?: "cover" }
  | { width: number; fit: "scale-down" };

/** Ensure `key` holds the image at `source`, shrunk to `size` as WebP.
 *  A key in `known` is taken as stored without asking R2. */
export async function mirrorImage(
  env: Env,
  key: string,
  source: string,
  size: Size,
  known?: ReadonlySet<string>
): Promise<Mirrored> {
  if (known?.has(key)) return "present";
  try {
    if (await env.IMAGES.head(key)) return "present";
    const response = await fetchUpstream(source);
    if (!response.ok || !response.body) return "failed";
    const result = await env.IMAGE_TRANSFORM.input(response.body)
      .transform({ fit: "cover", ...size })
      .output({ format: FORMAT, quality: QUALITY });
    await env.IMAGES.put(key, await result.response().arrayBuffer(), {
      httpMetadata: { contentType: result.contentType(), cacheControl: CACHE_CONTROL },
    });
    return "copied";
  } catch (error) {
    console.error("Image mirror failed", source, error);
    return "failed";
  }
}

/** Where the bucket is served, with one trailing slash. */
const baseUrl = (env: Env) => `${env.IMAGE_BASE_URL.replace(/\/$/, "")}/`;

/** The characters a key is made of; it ends where a URL in JSON does. */
const KEY_RE = /[\w./-]+/y;

/** Every mirrored key a stored body links to. A body only links copies
 *  that were stored, so these exist. */
export function linkedKeys(env: Env, text: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!text) return keys;
  const base = baseUrl(env);
  for (let at = text.indexOf(base); at !== -1; at = text.indexOf(base, at)) {
    KEY_RE.lastIndex = at += base.length;
    const key = KEY_RE.exec(text)?.[0];
    if (key) keys.add(key);
  }
  return keys;
}

/** Public URL for a mirrored object, or null when nothing was mirrored. */
export function publicUrl(env: Env, key: string | null): string | null {
  return key ? `${baseUrl(env)}${key}` : null;
}

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
 * Nothing here may fail a composition: a copy that doesn't happen reports
 * `failed` and the payload simply omits that image.
 */

import type { Env } from "../env";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const TIMEOUT_MS = 10_000;

export type Mirrored = "copied" | "present" | "failed";

/** Ensure `key` holds the bytes at `source`. */
export async function mirrorImage(
  env: Env,
  key: string,
  source: string,
  contentType: string
): Promise<Mirrored> {
  try {
    if (await env.IMAGES.head(key)) return "present";
    const response = await fetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return "failed";
    await env.IMAGES.put(key, await response.arrayBuffer(), {
      httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
    });
    return "copied";
  } catch (error) {
    console.error("Image mirror failed", source, error);
    return "failed";
  }
}

/** Public URL for a mirrored object, or null when nothing was mirrored. */
export function publicUrl(env: Env, key: string | null): string | null {
  return key ? `${env.IMAGE_BASE_URL.replace(/\/$/, "")}/${key}` : null;
}

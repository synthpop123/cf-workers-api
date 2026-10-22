/**
 * Company logos, mirrored into R2 (`stocks/logos/…`) from logo.dev's
 * ticker lookup, so the holdings table loads them from img.lkwplus.com
 * and no visitor's browser ever asks logo.dev (or carries its key).
 *
 * The page draws a logo at 28px; 96×96 WebP covers that at 3×. A ticker's
 * logo almost never changes, so the key is the ticker and the size alone:
 * it is copied once, and a key the previous body already links is taken
 * as stored without asking R2. To pick up a new logo, delete the object.
 *
 * `fallback=404` makes an unknown ticker a miss rather than logo.dev's
 * lettered placeholder, so the page draws its own monogram instead.
 */

import { mirrorImage, publicUrl, type Size } from "../../lib/images";

const SIZE: Size = { width: 96, height: 96 };
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;

/** The object key for a ticker, or null for one that isn't a plain
 *  exchange ticker (a fund ISIN, a crypto id). */
export function logoKey(symbol: string): string | null {
  return TICKER_RE.test(symbol) ? `stocks/logos/${symbol}-${SIZE.width}.webp` : null;
}

export function logoSource(symbol: string, token: string): string {
  const url = new URL(`https://img.logo.dev/ticker/${encodeURIComponent(symbol)}`);
  url.searchParams.set("token", token);
  url.searchParams.set("size", "128");
  url.searchParams.set("format", "png");
  url.searchParams.set("fallback", "404");
  return url.href;
}

/** Mirror each ticker's logo, returning its public URL, or null. */
export async function mirrorLogos(
  env: Env,
  symbols: string[],
  known: ReadonlySet<string>
): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      const key = logoKey(symbol);
      if (!key) return [symbol, null] as const;
      const result = await mirrorImage(
        env,
        key,
        logoSource(symbol, env.LOGO_DEV_TOKEN),
        SIZE,
        known
      );
      return [symbol, result === "failed" ? null : publicUrl(env, key)] as const;
    })
  );
  return new Map(entries);
}

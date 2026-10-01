/**
 * What the eShop knows about a title that znma does not: its price, and one
 * consistent name for it.
 *
 * The Parental Controls API knows nothing about money, and the name it
 * reports is whatever the console calls a game — which is per title, not per
 * language, so one library comes back part English, part Chinese and no
 * request header changes that. Both answers live on the storefront instead:
 * `ec.nintendo.com/apps/<applicationId>/<region>` redirects to the product
 * page, whose schema.org node carries a `name` and an `Offer`. Those are
 * pages rather than an API, so only the JSON-LD block is parsed — streamed
 * out with HTMLRewriter, since the pages run to a quarter of a megabyte.
 *
 * Two regions, because they answer different questions. The price should be
 * the one this library was actually bought at, so it comes from **HK** — the
 * console's own region, and the only nearby storefront that answers without
 * a queue page — which makes it HKD. The name should be the same language
 * for every row, so it comes from **US**.
 *
 * A title is looked up once and kept: a lookup only happens for a game still
 * missing a price or a name. `store_checked_at` records the attempt, so a
 * title neither storefront carries costs one request a month rather than one
 * a day. CNY is a conversion, not a second price — one ECB reference rate
 * per sync, applied to the whole library at compose time.
 *
 * Nothing here may fail a sync: an unresolved field is simply absent, and
 * the payload reports how many titles it could price.
 */

import { fetchUpstream } from "../../lib/http";

const PRICE_REGION = "HK";
const SOURCE_CURRENCY = "HKD";
const TITLE_REGION = "US";
export const RATE_PAIR = "HKD/CNY";
const RATE_URL = "https://api.frankfurter.dev/v1/latest?base=HKD&symbols=CNY";

const RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Cap per sync: a first run on a large catalog shouldn't stall the batch. */
const MAX_LOOKUPS = 12;
// Two regions per title; two titles leave room for the rate request.
const LOOKUP_CONCURRENCY = 2;

interface Offer {
  price?: string | number;
  priceCurrency?: string;
}

interface LinkedProduct {
  name?: string;
  offers?: Offer | Offer[];
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Every product node in a JSON-LD document, `@graph` or bare. */
function products(data: unknown): LinkedProduct[] {
  if (typeof data !== "object" || data === null) return [];
  const graph = ((data as { "@graph"?: unknown })["@graph"] ?? data) as
    | LinkedProduct
    | LinkedProduct[];
  return asArray(graph).filter(
    (node): node is LinkedProduct => typeof node === "object" && node !== null
  );
}

/** The first listed offer, in whole cents of the storefront's currency. */
function offerCents(data: unknown): number | null {
  for (const node of products(data)) {
    for (const offer of asArray(node.offers)) {
      if (offer.priceCurrency !== SOURCE_CURRENCY) continue;
      const price = Number(offer.price);
      if (Number.isFinite(price) && price > 0) return Math.round(price * 100);
    }
  }
  return null;
}

/** The product's own name. */
function productName(data: unknown): string | null {
  for (const node of products(data)) {
    if (typeof node.name === "string" && node.name.trim() !== "") {
      return node.name.trim();
    }
  }
  return null;
}

/** Collect each `application/ld+json` block without buffering the page. */
async function linkedData(response: Response): Promise<string[]> {
  const blocks: string[] = [];
  await new HTMLRewriter()
    .on('script[type="application/ld+json"]', {
      element() {
        blocks.push("");
      },
      text(chunk) {
        blocks[blocks.length - 1] += chunk.text;
      },
    })
    .transform(response)
    .arrayBuffer();
  return blocks;
}

/** Read one storefront's product page, or null when it has none. */
async function readPage<T>(
  applicationId: string,
  region: string,
  extract: (data: unknown) => T | null
): Promise<T | null> {
  const url = `https://ec.nintendo.com/apps/${applicationId.toLowerCase()}/${region}`;
  try {
    const response = await fetchUpstream(url, { headers: { Accept: "text/html" } });
    if (!response.ok) return null;
    for (const block of await linkedData(response)) {
      try {
        const value = extract(JSON.parse(block));
        if (value !== null) return value;
      } catch {
        // A block that isn't valid JSON is not the one carrying the answer.
      }
    }
    return null;
  } catch (error) {
    console.error("Store lookup failed", applicationId, region, error);
    return null;
  }
}

export interface StoreFacts {
  priceCents: number | null;
  title: string | null;
}

/** Both storefronts, in parallel — one round of lookups per title, ever. */
export function fetchStoreFacts(applicationId: string): Promise<StoreFacts> {
  return Promise.all([
    readPage(applicationId, PRICE_REGION, offerCents),
    readPage(applicationId, TITLE_REGION, productName),
  ]).then(([priceCents, title]) => ({ priceCents, title }));
}

/** Refresh the HKD→CNY reference rate. Returns it, or null if unavailable. */
export async function refreshExchangeRate(env: Env, now: number): Promise<number | null> {
  try {
    const response = await fetchUpstream(RATE_URL);
    if (!response.ok) return null;
    const body = (await response.json()) as { rates?: { CNY?: number } };
    const rate = body.rates?.CNY;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    await env.SWITCH_DB.prepare(
      `INSERT INTO exchange_rates (pair, rate, captured_at) VALUES (?, ?, ?)
       ON CONFLICT (pair) DO UPDATE SET
         rate = excluded.rate, captured_at = excluded.captured_at`
    )
      .bind(RATE_PAIR, rate, now)
      .run();
    return rate;
  } catch (error) {
    console.error("Exchange rate refresh failed", error);
    return null;
  }
}

/**
 * Look up the titles still missing a price or a name, most-played first.
 * Returns how many this run actually priced.
 */
export async function resolveStoreFacts(env: Env, now: number): Promise<number> {
  const { results } = await env.SWITCH_DB.prepare(
    `SELECT application_id FROM games
     WHERE (price_hkd_cents IS NULL OR store_title IS NULL)
       AND total_playing_time > 0
       AND (store_checked_at IS NULL OR store_checked_at < ?)
     ORDER BY total_playing_time DESC
     LIMIT ?`
  )
    .bind(now - RETRY_AFTER_MS, MAX_LOOKUPS)
    .all<{ application_id: string }>();

  if (results.length === 0) return 0;

  const statements: D1PreparedStatement[] = [];
  let priced = 0;
  for (let start = 0; start < results.length; start += LOOKUP_CONCURRENCY) {
    const batch = results.slice(start, start + LOOKUP_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async ({ application_id }) => ({
        application_id,
        facts: await fetchStoreFacts(application_id),
      }))
    );
    for (const { application_id, facts } of resolved) {
      if (facts.priceCents !== null) priced += 1;
      statements.push(
        env.SWITCH_DB.prepare(
          // COALESCE so a storefront that went quiet cannot erase an answer an
          // earlier run already got.
          `UPDATE games SET
             price_hkd_cents = COALESCE(?, price_hkd_cents),
             store_title = COALESCE(?, store_title),
             store_checked_at = ?
           WHERE application_id = ?`
        ).bind(facts.priceCents, facts.title, now, application_id)
      );
    }
  }

  await env.SWITCH_DB.batch(statements);
  return priced;
}

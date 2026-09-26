/**
 * GET /switch/site — versioned read payload for lkwplus.com/misc.
 *
 * Composed from D1 and served as a KV snapshot (lib/snapshot.ts), rewritten
 * by every sync. Bump SITE_VERSION together with the homepage's
 * SITE_SCHEMA_VERSION.
 *
 * The payload is deliberately narrower than the database: serial numbers,
 * player ids, NSA ids, avatars and the parental-control documents stay in D1.
 * What ships is play time and artwork.
 */

import type { Env } from "../../env";
import { isoToday } from "../../lib/http";
import { refresh, type Snapshot } from "../../lib/snapshot";
import { publicUrl } from "../../lib/images";
import {
  buildLibrary,
  computeStats,
  denseActivity,
  shiftDays,
  type SiteActivity,
  type SiteGame,
  type SiteStats,
} from "./stats";
import { RATE_PAIR } from "./store";

export const SITE_VERSION = 4;
const HEATMAP_DAYS = 365;
/** The window `recentMinutes` covers, today inclusive. */
export const RECENT_DAYS = 14;

export interface Site {
  schemaVersion: number;
  today: string;
  /** Nintendo's own recalculation clock — the age of the data, not the cache. */
  observedAt: string | null;
  recentDays: number;
  stats: SiteStats;
  activity: SiteActivity[];
  games: SiteGame[];
}

interface CatalogRow {
  application_id: string;
  title: string;
  image_key: string | null;
  shop_url: string | null;
  total_playing_time: number;
  last_played_date: string | null;
  price_hkd_cents: number | null;
}

export async function composeSiteBody(env: Env, today = isoToday()): Promise<Site> {
  const recentFloor = shiftDays(today, -(RECENT_DAYS - 1));

  const [activityResult, catalogResult, recentResult, observedResult, rateResult] =
    await env.SWITCH_DB.batch([
      env.SWITCH_DB.prepare(
        // Time in games, not console time: `daily_summaries.playing_time`
        // also counts the HOME menu, the eShop and settings, so a total
        // drawn from it would not add up to the list of games beside it.
        `SELECT date, SUM(playing_time) AS playing_time
         FROM daily_games
         WHERE date <= ?
         GROUP BY date
         ORDER BY date`
      ).bind(today),
      env.SWITCH_DB.prepare(
        // The storefront's name wins over the console's: znma names a game
        // whatever that console calls it, which is one language per title.
        `SELECT application_id, image_key, shop_url,
                COALESCE(store_title, title) AS title,
                total_playing_time, last_played_date, price_hkd_cents
         FROM games
         ORDER BY total_playing_time DESC, application_id`
      ),
      env.SWITCH_DB.prepare(
        `SELECT application_id, SUM(playing_time) AS playing_time
         FROM daily_games
         WHERE date >= ? AND date <= ?
         GROUP BY application_id`
      ).bind(recentFloor, today),
      env.SWITCH_DB.prepare(`SELECT MAX(observed_at) AS observed_at FROM daily_summaries`),
      env.SWITCH_DB.prepare(`SELECT rate FROM exchange_rates WHERE pair = ?`).bind(RATE_PAIR),
    ]);

  const activity = denseActivity(
    activityResult.results as { date: string; playing_time: number }[],
    today,
    HEATMAP_DAYS
  );

  const recent = new Map(
    (recentResult.results as { application_id: string; playing_time: number }[]).map((row) => [
      row.application_id,
      row.playing_time,
    ])
  );

  const library = buildLibrary(
    (catalogResult.results as CatalogRow[]).map((row) => ({
      ...row,
      // The mirrored copy is the only URL that ships; a cover that failed to
      // mirror renders as the empty tile rather than a hotlink to Nintendo.
      image_url: publicUrl(env, row.image_key),
    })),
    recent,
    (rateResult.results[0] as { rate: number } | undefined)?.rate ?? null
  );

  const observedAt =
    (observedResult.results[0] as { observed_at: number | null } | undefined)?.observed_at ?? null;

  return {
    schemaVersion: SITE_VERSION,
    today,
    observedAt: observedAt ? new Date(observedAt).toISOString() : null,
    recentDays: RECENT_DAYS,
    stats: computeStats(activity, library),
    activity,
    games: library.games,
  };
}

/** The Switch view, served at `GET /switch/site`. */
export const switchSite: Snapshot = {
  key: "switch:site",
  version: SITE_VERSION,
  compose: async (env, today) => JSON.stringify(await composeSiteBody(env, today)),
};

/** Recompose and store — the last step of every sync. */
export async function refreshSiteCache(env: Env): Promise<void> {
  await refresh(env, switchSite);
}

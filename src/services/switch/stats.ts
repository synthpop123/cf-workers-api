/**
 * Pure shaping for the `/switch/site` payload. No bindings, no clock — every
 * function takes `today` so the same inputs always produce the same output.
 *
 * All minutes are the znma v2 unit and are never rescaled.
 */

import { shiftDays } from "../../lib/http";

export interface SiteActivity {
  date: string;
  minutes: number;
}

export interface SiteStats {
  totalMinutes: number;
  gameCount: number;
  daysActive: number;
  daysTracked: number;
  avgDailyMinutes: number;
  longestStreak: number;
  currentStreak: number;
  firstDate: string | null;
  lastPlayedDate: string | null;
  /** List price of the played catalog in CNY, or null while nothing is priced. */
  libraryValueCny: number | null;
  /** How many titles carry a price — the value above is a floor, not a total. */
  pricedGameCount: number;
}

export interface SiteGame {
  applicationId: string;
  title: string;
  imageUrl: string | null;
  shopUrl: string | null;
  totalMinutes: number;
  recentMinutes: number;
  lastPlayedDate: string | null;
}

/**
 * A contiguous day-by-day series ending on `today`, zero-filled, from the
 * first played day — within the last `maxDays` when given (the heatmap's
 * window), else over the whole history (the stats, which the page calls
 * all-time and which must add up to the ranked list's lifetime minutes).
 *
 * Nintendo reports only days it has data for, and the heatmap renderer needs
 * a dense series — a sparse one draws a handful of cells floating in an empty
 * grid instead of a year of gray with a few green ones.
 */
export function denseActivity(
  rows: { date: string; playing_time: number }[],
  today: string,
  maxDays?: number
): SiteActivity[] {
  const floor = maxDays === undefined ? "" : shiftDays(today, -(maxDays - 1));
  const played = new Map<string, number>();
  for (const row of rows) {
    if (row.date >= floor && row.date <= today) played.set(row.date, row.playing_time);
  }
  if (played.size === 0) return [];

  const first = [...played.keys()].sort()[0];
  const series: SiteActivity[] = [];
  for (let date = first; date <= today; date = shiftDays(date, 1)) {
    series.push({ date, minutes: played.get(date) ?? 0 });
  }
  return series;
}

/** Longest run of consecutive active days in a dense, chronological series. */
function longestRun(activity: SiteActivity[]): number {
  let best = 0;
  let run = 0;
  for (const day of activity) {
    run = day.minutes > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Days played up to now. Today counts when it has minutes and is skipped when
 * it doesn't — a streak shouldn't break at midnight just because the console
 * hasn't been switched on yet.
 */
function currentRun(activity: SiteActivity[]): number {
  let index = activity.length - 1;
  if (index >= 0 && activity[index].minutes === 0) index -= 1;
  let run = 0;
  for (; index >= 0 && activity[index].minutes > 0; index -= 1) run += 1;
  return run;
}

/** All-time stats: `activity` is the whole dense history, never the heatmap's window. */
export function computeStats(activity: SiteActivity[], library: Library): SiteStats {
  const active = activity.filter((day) => day.minutes > 0);
  const totalMinutes = active.reduce((sum, day) => sum + day.minutes, 0);

  return {
    totalMinutes,
    gameCount: library.games.length,
    daysActive: active.length,
    daysTracked: activity.length,
    avgDailyMinutes: active.length > 0 ? Math.round(totalMinutes / active.length) : 0,
    longestStreak: longestRun(activity),
    currentStreak: currentRun(activity),
    firstDate: activity[0]?.date ?? null,
    lastPlayedDate: active[active.length - 1]?.date ?? null,
    libraryValueCny: library.valueCny,
    pricedGameCount: library.pricedCount,
  };
}

export interface GameRow {
  application_id: string;
  title: string;
  image_url: string | null;
  shop_url: string | null;
  total_playing_time: number;
  last_played_date: string | null;
  price_hkd_cents: number | null;
}

export interface Library {
  games: SiteGame[];
  valueCny: number | null;
  pricedCount: number;
}

/**
 * The catalog, ranked by lifetime minutes, each row carrying its own recent
 * window — plus what the same set is worth, converted at one rate for the
 * whole library. Games with no recorded minutes (owned but never played on a
 * synced day) are dropped, from the ranking and from the value alike: a zero
 * row answers nothing. Without a rate there is no value, only a count: a
 * total in the wrong currency would be worse than none.
 */
export function buildLibrary(
  rows: GameRow[],
  recent: Map<string, number>,
  rateToCny: number | null
): Library {
  const played = rows.filter((row) => row.total_playing_time > 0);
  const priced = played.filter((row) => row.price_hkd_cents !== null);
  const cents = priced.reduce((sum, row) => sum + (row.price_hkd_cents ?? 0), 0);

  return {
    games: played
      .map((row) => ({
        applicationId: row.application_id,
        title: row.title,
        imageUrl: row.image_url,
        shopUrl: row.shop_url,
        totalMinutes: row.total_playing_time,
        recentMinutes: recent.get(row.application_id) ?? 0,
        lastPlayedDate: row.last_played_date,
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes || a.title.localeCompare(b.title)),
    valueCny:
      priced.length > 0 && rateToCny !== null ? Math.round((cents / 100) * rateToCny) : null,
    pricedCount: priced.length,
  };
}

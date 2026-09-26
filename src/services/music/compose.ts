/**
 * The pure layer: Koito's narrowed bodies in, the public /music/site body
 * out. No bindings, no clock — `today` is passed in.
 *
 * Three upstream calls become one document, so the page makes one request
 * to this Worker instead of three to the instance. The heatmap series is
 * made dense here (`ACTIVITY_DAYS` ending today, zero-filled), because the
 * page's heatmap takes a dense, chronological series as its contract.
 * Cover art stays on the instance — it is self-hosted, so linking to it is
 * not hotlinking anyone — but every URL ships absolute.
 */

import type { KoitoData } from "./koito";

export const SITE_VERSION = 1;
/** The heatmap's window: its 52-week maximum (homepage HEAT_MAX_WEEKS). */
export const ACTIVITY_DAYS = 52 * 7;
/** What /misc shows: the lead listen plus two columns of five. */
export const LISTENS = 11;

export interface SiteStats {
  plays: number;
  tracks: number;
  albums: number;
  artists: number;
  minutes: number;
  daysActive: number;
  avgDailyPlays: number;
  longestStreak: number;
}

export interface SiteListen {
  /** ISO instant the listen was scrobbled. */
  at: string;
  title: string;
  artists: string[];
  url: string;
  /** ~128px and ~300px renditions; the lead row takes the larger. */
  cover: { small: string | null; medium: string | null };
}

export interface Site {
  schemaVersion: number;
  today: string;
  stats: SiteStats;
  activity: { date: string; plays: number }[];
  listens: SiteListen[];
}

/** `days` calendar days ending `today`, oldest first. */
export function dayRange(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)
  );
}

export function composeSite(data: KoitoData, instance: string, today: string): Site {
  const base = instance.replace(/\/$/, "");
  const absolute = (path: string | undefined) => (path ? `${base}${path}` : null);

  // `start_time` is midnight in the zone the series was asked for, so its
  // date part is the calendar day.
  const plays = new Map(data.activity.map((day) => [day.start_time.slice(0, 10), day.listens]));

  return {
    schemaVersion: SITE_VERSION,
    today,
    stats: {
      plays: data.stats.listen_count,
      tracks: data.stats.track_count,
      albums: data.stats.album_count,
      artists: data.stats.artist_count,
      minutes: data.stats.minutes_listened,
      daysActive: data.stats.days_active,
      avgDailyPlays: Math.round(data.stats.avg_daily_plays * 10) / 10,
      longestStreak: data.stats.longest_streak,
    },
    activity: dayRange(today, ACTIVITY_DAYS).map((date) => ({
      date,
      plays: plays.get(date) ?? 0,
    })),
    listens: data.listens.slice(0, LISTENS).map(({ time, track }) => ({
      at: new Date(time).toISOString(),
      title: track.title,
      artists: track.artists.map((artist) => artist.name).filter(Boolean),
      url: `${base}/track/${track.id}`,
      cover: {
        small: absolute(track.image?.small),
        medium: absolute(track.image?.medium ?? track.image?.small),
      },
    })),
  };
}

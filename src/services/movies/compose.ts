/**
 * The pure layer: diary entries in, the public /movies/site body out.
 *
 * The page is a poster wall of the latest viewings, so the payload is the
 * newest `FILMS` diary entries by watched date (the feed is ordered by
 * when an entry was *logged*, which is not the same thing) and no more.
 * Posters arrive already resolved to mirrored URLs — see posters.ts.
 */

import type { DiaryEntry } from "./letterboxd";

export const SITE_VERSION = 1;
/** Two rows of the four-across wall on /misc. */
export const FILMS = 8;

export interface SiteFilm {
  title: string;
  year: number | null;
  url: string;
  watched: string;
  rating: number | null;
  rewatch: boolean;
  poster: string | null;
}

export interface Site {
  schemaVersion: number;
  profileUrl: string;
  films: SiteFilm[];
}

/** Newest viewing first; the feed's own order breaks ties (a later log of
 *  the same day sits higher in it). */
export function latest(entries: DiaryEntry[], count = FILMS): DiaryEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.watched.localeCompare(a.entry.watched) || a.index - b.index)
    .slice(0, count)
    .map(({ entry }) => entry);
}

export function composeSite(user: string, films: DiaryEntry[]): Site {
  return {
    schemaVersion: SITE_VERSION,
    profileUrl: `https://letterboxd.com/${encodeURIComponent(user)}/`,
    films: films.map(({ title, year, url, watched, rating, rewatch, poster }) => ({
      title,
      year,
      url,
      watched,
      rating,
      rewatch,
      poster,
    })),
  };
}

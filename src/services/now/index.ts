/**
 * now — the Now section on the lkwplus.com home page: the latest listen,
 * the latest film, token usage today and over the last two weeks, and the
 * portfolio's last three months, in one small body instead of four feeds.
 *
 * All four are already composed elsewhere, so this service fetches
 * nothing: it reads the stored music, movies, tokens and portfolio
 * snapshots and keeps the part of each the home page shows. A source with
 * nothing stored is `null`, which blanks only that tile.
 *
 * Refreshed by the heartbeat right after music (schedule.ts), so a new
 * listen reaches both views in the same run. A body that did not move
 * writes nothing, and the fields are few on purpose: it moves when a
 * track changes, a film is logged, a device reports tokens or the
 * portfolio's hourly composition moves, never because some other part of
 * those payloads did.
 */

import { shiftDays } from "../../lib/http";
import type { Service } from "../../lib/service";
import { read, type Snapshot } from "../../lib/snapshot";
import type { Site as MoviesSite, SiteFilm } from "../movies/compose";
import { moviesSite } from "../movies";
import type { Site as MusicSite, SiteListen } from "../music/compose";
import { musicSite } from "../music";
import type { Site as PortfolioSite } from "../portfolio/compose";
import { portfolioSite } from "../portfolio";
import { tokensSite } from "../tokens/site";

export const SITE_VERSION = 3;

/** Days of token totals the tile's bars draw, today last. */
export const TOKENS_DAYS = 14;

/** Calendar months the portfolio tile covers: /misc's 3M range. */
export const PORTFOLIO_MONTHS = 3;

export interface TokensToday {
  tokens: number;
  cost: number;
  messages: number;
  /** Token totals of the last TOKENS_DAYS days, oldest first, the last
   *  one today's (`tokens`); a day with nothing reported is 0. */
  recent: number[];
}

/** The whole portfolio over its last PORTFOLIO_MONTHS: a window of the
 *  portfolio view's own series, from the session the range is measured
 *  from to the latest, so the return is the last value over the first. */
export interface Portfolio {
  /** Market sessions, oldest first. */
  days: string[];
  /** The growth index on `days`. */
  index: number[];
  /** The benchmark's closes on `days`. */
  benchmark: number[];
}

export interface Site {
  schemaVersion: number;
  today: string;
  listen: SiteListen | null;
  film: SiteFilm | null;
  tokens: TokensToday | null;
  portfolio: Portfolio | null;
}

interface TokensSite {
  daily: { date: string; tokens: number; cost: number; messages: number }[];
}

/** What is stored, of any day: composing a source from here would put
 *  its upstream on this service's clock. */
async function stored<T>(env: Env, snapshot: Snapshot): Promise<T | null> {
  const entry = await read(env, snapshot);
  return entry ? (JSON.parse(entry.text) as T) : null;
}

/** Each entry rebuilt field by field, so nothing else in the source
 *  payload rides along into this one. */
export function pickListen(site: MusicSite | null): SiteListen | null {
  const listen = site?.listens[0];
  if (!listen) return null;
  const { at, title, artists, url, cover } = listen;
  return { at, title, artists, url, cover: { small: cover.small, medium: cover.medium } };
}

export function pickFilm(site: MoviesSite | null): SiteFilm | null {
  const film = site?.films[0];
  if (!film) return null;
  const { title, year, url, watched, rating, rewatch, poster } = film;
  return { title, year, url, watched, rating, rewatch, poster };
}

/** A day with no entry is a real zero, not a missing tile: the tokens
 *  view is stored on every submission, so a copy from an earlier day
 *  means nothing was reported since midnight. */
export function pickTokens(site: TokensSite | null, today: string): TokensToday | null {
  if (!site) return null;
  const byDate = new Map(site.daily.map((day) => [day.date, day]));
  const recent = Array.from(
    { length: TOKENS_DAYS },
    (_, i) => byDate.get(shiftDays(today, i + 1 - TOKENS_DAYS))?.tokens ?? 0
  );
  const day = byDate.get(today);
  return day
    ? { tokens: day.tokens, cost: day.cost, messages: day.messages, recent }
    : { tokens: 0, cost: 0, messages: 0, recent };
}

/** The same day `months` calendar months away, clamped to that month's
 *  last day (a month before Mar 31 is Feb 28) — the page's rule for its
 *  month ranges. */
export function shiftMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

const isNumber = (value: number | null): value is number => value !== null;

/**
 * The whole portfolio's last PORTFOLIO_MONTHS, measured as /misc measures
 * its 3M range: from the last session on or before the same day three
 * months back (or from the first day both series have a value, when that
 * is later) to the latest session.
 */
export function pickPortfolio(site: PortfolioSite | null): Portfolio | null {
  const all = site?.accounts[0];
  if (!site || !all) return null;
  const { days } = site;
  const closes = site.benchmark.closes;
  const cutoff = shiftMonths(days[days.length - 1] ?? "", -PORTFOLIO_MONTHS);
  let start = 0;
  for (let i = 0; i < days.length && days[i] <= cutoff; i++) start = i;
  start = Math.max(start, all.index.findIndex(isNumber), closes.findIndex(isNumber));
  const index = all.index.slice(start);
  const benchmark = closes.slice(start);
  if (index.length < 2 || !index.every(isNumber) || !benchmark.every(isNumber)) return null;
  return { days: days.slice(start), index, benchmark };
}

export const nowSite: Snapshot = {
  key: "now:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    const [music, movies, tokens, portfolio] = await Promise.all([
      stored<MusicSite>(env, musicSite),
      stored<MoviesSite>(env, moviesSite),
      stored<TokensSite>(env, tokensSite),
      stored<PortfolioSite>(env, portfolioSite),
    ]);
    const site: Site = {
      schemaVersion: SITE_VERSION,
      today,
      listen: pickListen(music),
      film: pickFilm(movies),
      tokens: pickTokens(tokens, today),
      portfolio: pickPortfolio(portfolio),
    };
    return JSON.stringify(site);
  },
};

export default { name: "now", site: nowSite } satisfies Service;

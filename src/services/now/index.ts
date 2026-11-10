/**
 * now — the Now section on the lkwplus.com home page: the latest listen,
 * the latest film, token usage today and over the last two weeks with the
 * week's busiest model, and the portfolio's last three months, in one small body instead of four feeds.
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
import { read, type Snapshot, type Stored } from "../../lib/snapshot";
import type { Site as MoviesSite, SiteFilm } from "../movies/compose";
import { moviesSite } from "../movies";
import type { Site as MusicSite, SiteListen } from "../music/compose";
import { musicSite } from "../music";
import type { Site as PortfolioSite } from "../portfolio/compose";
import { portfolioSite } from "../portfolio";
import { tokensSite } from "../tokens/site";

export const SITE_VERSION = 6;

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
  /** Tokens and cost over the seven days ending today: the tile's
   *  figure, which a quiet morning does not empty. */
  week: { tokens: number; cost: number };
  /** The model with the most tokens over the seven days ending today
   *  and its share of them, in (0, 1]; null when the week has none. The
   *  page names the id. */
  top: { model: string; share: number } | null;
}

/** The whole portfolio over its last PORTFOLIO_MONTHS: a window of the
 *  portfolio view's own series, from the session the range is measured
 *  from to the latest, so the page measures it as /misc measures 3M. */
export interface Portfolio {
  /** Market sessions, oldest first. */
  days: string[];
  /** Value and money put in on `days`, the portfolio view's ratios. */
  value: number[];
  invested: number[];
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

export interface TokensSite {
  daily: {
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    clients?: Record<string, { models?: Record<string, { tokens: number }> }>;
  }[];
}

/** Ids the tokens view uses for usage it could not attribute; never the
 *  answer to "which model". */
const PLACEHOLDER_MODELS = new Set(["unknown", "<synthetic>"]);

/** Days in the week the busiest model is measured over, today last. */
const WEEK_DAYS = 7;

/**
 * The busiest model of the seven days ending `today` — this service's
 * today, not the tokens view's: that view is stored as of the day it was
 * last composed, and when the collectors have gone quiet its own week can
 * be days behind the bars beside it. So the week is summed afresh from
 * the daily series' model cells (canonical ids, the same as the view's
 * `byModel`), over all of the week's tokens, placeholders included.
 *
 * The share is not rounded: the busiest model's tokens are positive, and
 * a share rounded to zero (one token against a million unattributed) is
 * a value the page's decoder rightly refuses.
 */
export function topModel(site: TokensSite, today: string): TokensToday["top"] {
  const from = shiftDays(today, 1 - WEEK_DAYS);
  const byModel = new Map<string, number>();
  let total = 0;
  for (const day of site.daily) {
    if (day.date < from || day.date > today) continue;
    total += day.tokens;
    for (const client of Object.values(day.clients ?? {})) {
      for (const [model, cell] of Object.entries(client.models ?? {})) {
        byModel.set(model, (byModel.get(model) ?? 0) + cell.tokens);
      }
    }
  }
  let best: { model: string; tokens: number } | null = null;
  for (const [model, tokens] of byModel) {
    if (PLACEHOLDER_MODELS.has(model) || tokens <= 0) continue;
    if (!best || tokens > best.tokens) best = { model, tokens };
  }
  return best && total > 0 ? { model: best.model, share: Math.min(1, best.tokens / total) } : null;
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
  const week = { tokens: 0, cost: 0 };
  for (let i = 0; i < WEEK_DAYS; i++) {
    const entry = byDate.get(shiftDays(today, -i));
    week.tokens += entry?.tokens ?? 0;
    week.cost += entry?.cost ?? 0;
  }
  const day = byDate.get(today);
  const top = topModel(site, today);
  return day
    ? { tokens: day.tokens, cost: day.cost, messages: day.messages, recent, week, top }
    : { tokens: 0, cost: 0, messages: 0, recent, week, top };
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
  start = Math.max(start, all.value.findIndex(isNumber), closes.findIndex(isNumber));
  const value = all.value.slice(start);
  const invested = all.invested.slice(start);
  const benchmark = closes.slice(start);
  if (
    value.length < 2 ||
    !value.every(isNumber) ||
    !invested.every(isNumber) ||
    !benchmark.every(isNumber)
  ) {
    return null;
  }
  return { days: days.slice(start), value, invested, benchmark };
}

/** The last body composed in this isolate and what it was composed
 *  from: the day and the sources' ETags. */
let composed: { from: string; text: string } | null = null;

const parsed = <T>(entry: Stored | null): T | null =>
  entry ? (JSON.parse(entry.text) as T) : null;

export const nowSite: Snapshot = {
  key: "now:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    // What is stored, of any day: composing a source from here would put
    // its upstream on this service's clock.
    const sources = await Promise.all(
      [musicSite, moviesSite, tokensSite, portfolioSite].map((source) => read(env, source))
    );
    // The heartbeat runs this every five minutes and the sources mostly
    // have not moved: the same day over the same ETags is the same body,
    // without parsing four payloads to find that out.
    const from = [today, ...sources.map((entry) => entry?.meta.etag ?? "-")].join("|");
    if (composed?.from === from) return composed.text;
    const [music, movies, tokens, portfolio] = sources;
    const site: Site = {
      schemaVersion: SITE_VERSION,
      today,
      listen: pickListen(parsed<MusicSite>(music)),
      film: pickFilm(parsed<MoviesSite>(movies)),
      tokens: pickTokens(parsed<TokensSite>(tokens), today),
      portfolio: pickPortfolio(parsed<PortfolioSite>(portfolio)),
    };
    composed = { from, text: JSON.stringify(site) };
    return composed.text;
  },
};

export default { name: "now", site: nowSite } satisfies Service;

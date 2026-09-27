/**
 * now — the Now section on the lkwplus.com home page: the latest listen,
 * the latest film, today's token usage and the newest memo, in one small
 * body instead of four feeds.
 *
 * Three of the four are already composed elsewhere, so this service
 * fetches nothing from them: it reads the stored music, movies and tokens
 * snapshots and keeps the one entry of each the home page shows. Only the
 * memo comes from outside (mastodon.ts). A source with nothing stored is
 * `null`, which blanks only that tile.
 *
 * Refreshed by the heartbeat right after music (schedule.ts), so a new
 * listen reaches both views in the same run. A body that did not move
 * writes nothing, and the fields are few on purpose: it moves when a
 * track changes, a film is logged, a device reports tokens or a memo is
 * posted, never because some other part of those payloads did.
 */

import type { Env } from "../../env";
import type { Service } from "../../lib/service";
import { read, type Snapshot } from "../../lib/snapshot";
import type { Site as MoviesSite, SiteFilm } from "../movies/compose";
import { moviesSite } from "../movies";
import type { Site as MusicSite, SiteListen } from "../music/compose";
import { musicSite } from "../music";
import { tokensSite } from "../tokens/site";
import { fetchLatestMemo, type Memo } from "./mastodon";

export const SITE_VERSION = 1;

export interface TokensToday {
  tokens: number;
  cost: number;
  messages: number;
}

export interface Site {
  schemaVersion: number;
  today: string;
  listen: SiteListen | null;
  film: SiteFilm | null;
  tokens: TokensToday | null;
  memo: Memo | null;
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
  const day = site.daily.find(({ date }) => date === today);
  return day
    ? { tokens: day.tokens, cost: day.cost, messages: day.messages }
    : { tokens: 0, cost: 0, messages: 0 };
}

/** The newest memo; when the instance is down, the one last stored. */
async function latestMemo(env: Env): Promise<Memo | null> {
  try {
    return await fetchLatestMemo(env.MASTODON_URL, env.MASTODON_ACCOUNT);
  } catch (error) {
    console.error("Mastodon read failed", error);
    const previous = await read(env, nowSite);
    return previous ? (JSON.parse(previous.text) as Site).memo : null;
  }
}

export const nowSite: Snapshot = {
  key: "now:site",
  version: SITE_VERSION,
  compose: async (env, today) => {
    const [music, movies, tokens, memo] = await Promise.all([
      stored<MusicSite>(env, musicSite),
      stored<MoviesSite>(env, moviesSite),
      stored<TokensSite>(env, tokensSite),
      latestMemo(env),
    ]);
    const site: Site = {
      schemaVersion: SITE_VERSION,
      today,
      listen: pickListen(music),
      film: pickFilm(movies),
      tokens: pickTokens(tokens, today),
      memo,
    };
    return JSON.stringify(site);
  },
};

export default { name: "now", site: nowSite } satisfies Service;

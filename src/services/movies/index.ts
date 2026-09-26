/**
 * movies — the latest films from the member's Letterboxd diary
 * (`LETTERBOXD_USER`), read from their public RSS feed and served as the
 * poster wall on lkwplus.com/misc. Refreshed by the heartbeat (index.ts).
 */

import type { Service } from "../../lib/service";
import type { Snapshot } from "../../lib/snapshot";
import { composeSite, latest, SITE_VERSION } from "./compose";
import { fetchDiary } from "./letterboxd";
import { mirrorPoster } from "./posters";

export const moviesSite: Snapshot = {
  key: "movies:site",
  version: SITE_VERSION,
  compose: async (env) => {
    const films = latest(await fetchDiary(env.LETTERBOXD_USER));
    // A rewatch shares its poster; copy each one once.
    const sources = [...new Set(films.flatMap((film) => (film.poster ? [film.poster] : [])))];
    const mirrored = new Map(
      await Promise.all(sources.map(async (url) => [url, await mirrorPoster(env, url)] as const))
    );
    return JSON.stringify(
      composeSite(
        env.LETTERBOXD_USER,
        films.map((film) => ({
          ...film,
          poster: film.poster && (mirrored.get(film.poster) ?? null),
        }))
      )
    );
  },
};

export default { name: "movies", site: moviesSite } satisfies Service;

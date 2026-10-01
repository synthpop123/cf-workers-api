/**
 * music — listening history from the self-hosted Koito instance
 * (`KOITO_URL`), served as the view behind the Music section on
 * lkwplus.com/misc: all-time stats, a year of daily plays and the last
 * listens, composed from three Koito calls into one snapshot.
 *
 * Refreshed by the five-minute heartbeat (schedule.ts), the tightest cadence
 * here, because the page marks a listen under ten minutes old as playing.
 */

import type { Service } from "../../lib/service";
import type { Snapshot } from "../../lib/snapshot";
import { ACTIVITY_DAYS, composeSite, LISTENS, SITE_VERSION } from "./compose";
import { fetchKoito } from "./koito";

export const musicSite: Snapshot = {
  key: "music:site",
  version: SITE_VERSION,
  compose: async (env, today) =>
    JSON.stringify(
      composeSite(await fetchKoito(env, ACTIVITY_DAYS, LISTENS), env.KOITO_URL, today)
    ),
};

export default { name: "music", site: musicSite } satisfies Service;

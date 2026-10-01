/**
 * memos — the member's public Mastodon statuses, served as the thread on
 * lkwplus.com/memos. Refreshed by the heartbeat every five minutes
 * (schedule.ts); a run where nothing was posted or edited writes nothing.
 */

import type { Service } from "../../lib/service";
import { linkedKeys } from "../../lib/images";
import { read, type Snapshot } from "../../lib/snapshot";
import { composeSite, MEMOS, SITE_VERSION } from "./compose";
import { fetchStatuses } from "./mastodon";
import { mirrorMedia } from "./media";

export const memosSite: Snapshot = {
  key: "memos:site",
  version: SITE_VERSION,
  compose: async (env) => {
    const statuses = await fetchStatuses(env.MASTODON_URL, env.MASTODON_ACCOUNT, MEMOS);
    const previous = await read(env, memosSite);
    const mirrored = await mirrorMedia(env, statuses, linkedKeys(env, previous?.text));
    const profile = new URL(`/@${env.MASTODON_USER}`, env.MASTODON_URL).href;
    return JSON.stringify(composeSite(profile, statuses, mirrored));
  },
};

export default { name: "memos", site: memosSite } satisfies Service;

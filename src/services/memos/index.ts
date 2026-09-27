/**
 * memos — the member's public Mastodon statuses, served as the thread on
 * lkwplus.com/memos and as the newest memo on the home page (the now
 * service reads it from here). Refreshed by the heartbeat every five
 * minutes, alongside music (schedule.ts); a run where nothing was posted
 * or edited writes nothing.
 */

import type { Service } from "../../lib/service";
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
    const mirrored = await mirrorMedia(env, statuses, previous?.text ?? null);
    const profile = new URL(`/@${env.MASTODON_USER}`, env.MASTODON_URL).href;
    return JSON.stringify(composeSite(profile, statuses, mirrored));
  },
};

export default { name: "memos", site: memosSite } satisfies Service;

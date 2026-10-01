/**
 * flights — the flights logged in the self-hosted AirTrail instance
 * (`AIRTRAIL_URL`, read with the `AIRTRAIL_API_KEY` secret, which never
 * reaches the browser), served as the versioned, redacted view behind the
 * globe on lkwplus.com/misc.
 *
 * The scheduler recomposes it from AirTrail (schedule.ts), so a page load
 * never waits on the instance and an AirTrail outage keeps serving the
 * last good copy. `upcoming` flips at midnight Asia/Shanghai, which the
 * snapshot's day guard covers.
 */

import type { Service } from "../../lib/service";
import type { Snapshot } from "../../lib/snapshot";
import { fetchFlights } from "./airtrail";
import { composeSite, SITE_VERSION } from "./compose";

export const flightsSite: Snapshot = {
  key: "flights:site",
  version: SITE_VERSION,
  compose: async (env, today) => JSON.stringify(composeSite(await fetchFlights(env), today)),
};

export default { name: "flights", site: flightsSite } satisfies Service;

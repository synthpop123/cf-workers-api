/**
 * homelab — the two self-hosted hosts as the Beszel hub sees them: each
 * host's status, CPU / memory / disk / load and hardware, and every
 * running container with its Docker health. Three Beszel calls (sign-in,
 * systems, containers) per composition.
 *
 * Polled by the five-minute heartbeat, but not stored every time: the
 * metrics move on every run, and an unconditional store would spend a
 * KV write per run (288 a day, of 1,000 shared by the account). So
 * `refreshHomelab` stores when what a reader acts on changed — a host's
 * status, a container's health, a container come or gone — or when the
 * stored metrics are `METRICS_EVERY_MS` old, or the day turned. Health
 * shows within five minutes; the numbers are at most half an hour old,
 * and `seenAt` says how old.
 */

import { isoToday } from "../../lib/http";
import type { Service } from "../../lib/service";
import { read, type Snapshot, type Stored, store } from "../../lib/snapshot";
import { fetchBeszel } from "./beszel";
import { composeSite, SITE_VERSION, type Site, stateOf } from "./compose";

/** How old the stored metrics may grow while nothing else changes. */
export const METRICS_EVERY_MS = 30 * 60_000;

export const homelabSite: Snapshot = {
  key: "homelab:site",
  version: SITE_VERSION,
  compose: async (env, today) => JSON.stringify(composeSite(await fetchBeszel(env), today)),
};

/** The heartbeat's job: compose, and store only what is worth a write. */
export async function refreshHomelab(env: Env, today = isoToday()): Promise<Stored> {
  const previous = await read(env, homelabSite);
  const text = await homelabSite.compose(env, today);
  if (
    previous &&
    previous.meta.day === today &&
    Date.now() - previous.meta.changedAt < METRICS_EVERY_MS &&
    stateOf(JSON.parse(previous.text) as Site) === stateOf(JSON.parse(text) as Site)
  ) {
    return previous;
  }
  return store(env, homelabSite, text, today, previous);
}

export default { name: "homelab", site: homelabSite } satisfies Service;

/**
 * What the scheduler runs.
 *
 * Cron triggers are a scarce, account-wide resource (five on the Workers
 * free plan), so this Worker uses two, and each job says how often it
 * wants to run within the trigger that fires it:
 *
 *   `*\/5 * * * *`  the heartbeat, for the snapshots that poll an upstream
 *                   music     every 5 min — the page marks a listen under
 *                             ten minutes old as playing — and then
 *                   now       from what music just stored, plus the
 *                             newest memo, so the home page's listen
 *                             is never a run behind /misc
 *                   movies    every 3 hours — each run is one RSS fetch,
 *                             kept rare so Letterboxd has no reason to
 *                             rate-limit it
 *                   flights   daily at 00:00 — the map changes when a
 *                             flight is logged, and `upcoming` flips at
 *                             midnight
 *   `0 1 * * *`     the Switch sync (09:00 Asia/Shanghai, after Nintendo's
 *                   overnight recalculation) — on a trigger of its own
 *                   because each trigger is its own invocation, with its
 *                   own CPU and subrequest budget, and the sync is the one
 *                   heavy job
 *
 * A composition whose bytes did not move writes nothing (lib/snapshot.ts),
 * so a job costs upstream reads, not KV writes. The tokens view needs no
 * job: submissions and quota reports are its write events.
 *
 * The trigger keys must be exactly `triggers.crons` in wrangler.jsonc, and
 * every cadence must land on a tick of its trigger (test/schedule.spec.ts
 * checks both).
 */

import type { Env } from "./env";
import { TIME_ZONE } from "./lib/http";
import { refresh, type Snapshot } from "./lib/snapshot";
import { flights, movies, music, now } from "./services";
import { runSync } from "./services/switch";

/** Minutes between runs, counted from midnight; or a daily `HH:MM`. Both
 *  in TIME_ZONE. Absent: every time the trigger fires. */
export type Cadence = { every: number } | { at: `${number}:${number}` };

export interface Job {
  name: string;
  cadence?: Cadence;
  run(env: Env): Promise<unknown>;
}

const refreshing = (snapshot: Snapshot, cadence: Cadence): Job => ({
  name: `refresh ${snapshot.key}`,
  cadence,
  run: (env) => refresh(env, snapshot),
});

export const TRIGGERS = new Map<string, Job[]>([
  [
    "*/5 * * * *",
    [
      {
        name: `refresh ${music.site.key}, then ${now.site.key}`,
        cadence: { every: 5 },
        // now reads the music snapshot, so it waits for it; a failed music
        // run still refreshes now, whose tokens and memo tiles move alone.
        run: async (env) => {
          try {
            await refresh(env, music.site);
          } catch (error) {
            console.error(`refresh ${music.site.key} failed`, error);
          }
          return refresh(env, now.site);
        },
      },
      refreshing(movies.site, { every: 180 }),
      refreshing(flights.site, { at: "00:00" }),
    ],
  ],
  ["0 1 * * *", [{ name: "switch sync", run: runSync }]],
]);

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes since midnight in TIME_ZONE. */
export function minuteOfDay(at: Date): number {
  const [hours, minutes] = clock.format(at).split(":").map(Number);
  return hours * 60 + minutes;
}

export function isDue(cadence: Cadence | undefined, at: Date): boolean {
  if (!cadence) return true;
  const minute = minuteOfDay(at);
  if ("every" in cadence) return minute % cadence.every === 0;
  const [hours, minutes] = cadence.at.split(":").map(Number);
  return minute === hours * 60 + minutes;
}

/** Run the jobs of one trigger that are due at `at`. A failing job is
 *  logged and never takes the others down with it. */
export async function runScheduled(cron: string, at: Date, env: Env): Promise<void> {
  const jobs = TRIGGERS.get(cron);
  if (!jobs) {
    console.error("No jobs for cron", cron);
    return;
  }
  const due = jobs.filter((job) => isDue(job.cadence, at));
  const results = await Promise.allSettled(due.map((job) => job.run(env)));
  results.forEach((result, i) => {
    if (result.status === "rejected") console.error(`${due[i].name} failed`, result.reason);
  });
}

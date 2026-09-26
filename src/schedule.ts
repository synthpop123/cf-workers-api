/**
 * What the scheduler runs, keyed by the cron expression that fires it.
 * The keys must be exactly `triggers.crons` in wrangler.jsonc (the test
 * suite checks); each expression is its own invocation, so its jobs get
 * their own CPU and subrequest budget.
 *
 *   every 5 min   recompose the snapshots that poll an upstream — AirTrail,
 *                 Koito, Letterboxd. A composition whose bytes didn't move
 *                 writes nothing (lib/snapshot.ts), so this costs upstream
 *                 reads, not KV writes.
 *   01:00 UTC     the Switch sync (09:00 Asia/Shanghai, after Nintendo's
 *                 overnight recalculation), which rewrites its own snapshot.
 *
 * The tokens view needs no job: submissions and quota reports are its
 * write events.
 */

import type { Env } from "./env";
import { refresh } from "./lib/snapshot";
import { flightsSite } from "./services/flights";
import { moviesSite } from "./services/movies";
import { musicSite } from "./services/music";
import { runSync } from "./services/switch";

export interface Job {
  name: string;
  run(env: Env): Promise<unknown>;
}

export const SCHEDULE = new Map<string, Job[]>([
  [
    "*/5 * * * *",
    [flightsSite, moviesSite, musicSite].map((snapshot) => ({
      name: `refresh ${snapshot.key}`,
      run: (env: Env) => refresh(env, snapshot),
    })),
  ],
  ["0 1 * * *", [{ name: "switch sync", run: runSync }]],
]);

/** Run every job of one trigger; a failing job is logged and never takes
 *  the others down with it. */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const jobs = SCHEDULE.get(cron);
  if (!jobs) {
    console.error("No jobs for cron", cron);
    return;
  }
  const results = await Promise.allSettled(jobs.map((job) => job.run(env)));
  results.forEach((result, i) => {
    if (result.status === "rejected") console.error(`${jobs[i].name} failed`, result.reason);
  });
}

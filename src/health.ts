/**
 * GET /health — liveness, and whether every view is as fresh as its
 * schedule promises.
 *
 * A job that fails only logs, and a read keeps answering with the last
 * good copy, so nothing public showed that a view had stopped moving (an
 * expired Nintendo session fails the Switch sync every morning, quietly).
 * Every snapshot is rewritten at least once a day, since the day it is
 * composed as of is part of it; so a view whose stored day is not today
 * once its first run of the day is past is overdue, and the answer is a
 * 503 an uptime monitor can alarm on. The tokens view is written by
 * submissions, which no schedule promises: it is reported, never overdue.
 *
 * One KV list carries every entry's metadata, so this reads no bodies.
 */

import { isoToday, json } from "./lib/http";
import type { SnapshotMeta } from "./lib/snapshot";
import { minuteOfDay } from "./schedule";
import { SERVICES } from "./services";

/** Minutes past midnight (TIME_ZONE) by which each scheduled view has
 *  been recomposed for the day, with slack for a slow run: the heartbeat
 *  jobs all run at 00:00 or 00:05, the Switch sync at 09:00. */
export const DUE_BY: Readonly<Record<string, number>> = {
  switch: 9 * 60 + 30,
  flights: 30,
  music: 30,
  movies: 30,
  memos: 30,
  portfolio: 30,
  now: 30,
};

interface ViewHealth {
  day: string | null;
  changedAt: string | null;
  overdue: boolean;
}

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const now = new Date();
  const today = isoToday(now);
  const minute = minuteOfDay(now);
  const { keys } = await env.CACHE.list<SnapshotMeta>();
  const stored = new Map(keys.map((key) => [key.name, key.metadata]));
  const views: Record<string, ViewHealth> = {};
  for (const { name, site } of SERVICES) {
    const meta = stored.get(site.key);
    const dueBy = DUE_BY[name];
    views[name] = {
      day: meta?.day ?? null,
      changedAt: meta ? new Date(meta.changedAt).toISOString() : null,
      overdue: dueBy !== undefined && minute >= dueBy && meta?.day !== today,
    };
  }
  const ok = Object.values(views).every((view) => !view.overdue);
  return json({ ok, services: SERVICES.map(({ name }) => name), views }, ok ? 200 : 503);
}

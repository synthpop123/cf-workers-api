/**
 * Snapshots — how every public view is served.
 *
 * Each service's `/site` payload is a precomposed JSON document stored in
 * KV (`CACHE`) under the service's own key, with everything the read path
 * needs to judge it riding in the entry's metadata: the schema version,
 * the calendar day it was composed as of, its ETag and when its bytes
 * last changed. A read is one KV lookup and no parse.
 *
 * Freshness is decided by events, never by a TTL:
 *   - a service that owns its writes (tokens submissions and quota
 *     reports, the Switch sync) stores a new snapshot as part of the write;
 *   - a service that polls an upstream (AirTrail, Koito, Letterboxd,
 *     Mastodon) is refreshed by the scheduled heartbeat (schedule.ts);
 *   - a read recomposes inline only when there is no usable copy — none
 *     stored, or one of another schema version (a deploy changed the
 *     shape; the page would reject it);
 *   - a read that finds a copy composed as of another day (every window
 *     the pages draw ends today, so midnight is an event too) serves it
 *     and recomposes behind the response, at most once a minute per
 *     isolate — yesterday's view now beats today's after a wait on an
 *     upstream that may be down.
 * Only a service with nothing stored at all, and nothing composable,
 * answers 503.
 *
 * Writes are skipped when neither the bytes nor the day moved: KV writes
 * are the scarce resource on the free plan, and a heartbeat that rewrote
 * identical payloads would spend them for nothing. That also makes
 * `Last-Modified` honest — it is when the content last changed, not when
 * somebody last looked.
 *
 * Browsers get `Cache-Control: no-cache` + the strong ETag: they keep a
 * copy but ask every load, and an unchanged payload costs a ~0-byte 304.
 * There is deliberately no `caches.default` tier in front — it is the one
 * layer no event can invalidate.
 */

import { etagMatches, etagOf, isoToday, json } from "./http";
import type { Handler } from "./router";

export interface Snapshot {
  /** KV key, namespaced by service: `flights:site`. */
  readonly key: string;
  /** Also stamped into the body as `schemaVersion`; bump in lockstep
   *  with the homepage's decoder for that payload. */
  readonly version: number;
  /** The full JSON body as of `today`. Rejects when the upstream does. */
  compose(env: Env, today: string): Promise<string>;
  /**
   * For a service that owns its writes: a counter every write bumps
   * (tokens' `tokens_state`). With it, `refresh` fences its publish — see
   * there. Without it, the last put wins, which is right for a poller
   * whose only writer is the scheduler.
   */
  generation?(env: Env): Promise<number>;
}

export interface SnapshotMeta {
  version: number;
  /** Calendar day (TIME_ZONE) the body was composed as of. */
  day: string;
  etag: string;
  /** Epoch ms the bytes last changed. */
  changedAt: number;
}

export interface Stored {
  text: string;
  meta: SnapshotMeta;
}

/** How long a PoP may serve its local copy of a KV entry before
 *  re-checking central storage (30 s is the API minimum). */
const KV_CACHE_TTL = 30;

export async function read(env: Env, snapshot: Snapshot): Promise<Stored | null> {
  const { value, metadata } = await env.CACHE.getWithMetadata<SnapshotMeta>(snapshot.key, {
    type: "text",
    cacheTtl: KV_CACHE_TTL,
  });
  // A copy of another shape is never served: the page would reject it.
  return value !== null && metadata?.version === snapshot.version
    ? { text: value, meta: metadata }
    : null;
}

/**
 * Store an already composed body. `previous` (when the caller has read
 * it) lets an unchanged body on an unchanged day skip the write.
 */
export async function store(
  env: Env,
  snapshot: Snapshot,
  text: string,
  today = isoToday(),
  previous?: Stored | null
): Promise<Stored> {
  const etag = await etagOf(text);
  if (previous && previous.meta.etag === etag && previous.meta.day === today) {
    return previous;
  }
  const meta: SnapshotMeta = {
    version: snapshot.version,
    day: today,
    etag,
    changedAt: previous?.meta.etag === etag ? previous.meta.changedAt : Date.now(),
  };
  await env.CACHE.put(snapshot.key, text, { metadata: meta });
  return { text, meta };
}

/** Compositions a fenced refresh tries before giving up. */
const FENCE_ATTEMPTS = 4;

/**
 * Compose and store. Rejects when composition does.
 *
 * KV has no transactions, so with nothing else two refreshes publish in
 * whatever order their puts land: one that read the data before a write
 * (a wipe, say) and puts after the write's own refresh republishes what
 * the write replaced — deleted data included. A snapshot with a
 * `generation` is fenced against that: a body composed while the counter
 * moved is not put, and when it moves between a put and the check after
 * it, the put may have landed over the newer body, so the view is
 * composed and put again (unconditionally) from the data as it now is.
 * Whichever refresh puts last has therefore checked, after its put, that
 * no write landed since it read.
 */
export async function refresh(
  env: Env,
  snapshot: Snapshot,
  today = isoToday(),
  previous?: Stored | null
): Promise<Stored> {
  let prior = previous === undefined ? await read(env, snapshot) : previous;
  const generation = snapshot.generation?.bind(snapshot);
  if (!generation) return store(env, snapshot, await snapshot.compose(env, today), today, prior);

  for (let attempt = 0; attempt < FENCE_ATTEMPTS; attempt++) {
    const fence = await generation(env);
    const text = await snapshot.compose(env, today);
    if ((await generation(env)) !== fence) continue;
    const stored = await store(env, snapshot, text, today, prior);
    if ((await generation(env)) === fence) return stored;
    prior = null;
  }
  throw new Error(`${snapshot.key}: writes kept landing while it was composed`);
}

/** How long a background recompose that was just tried is left alone. */
const RETRY_AFTER_MS = 60_000;

/** When each key's background recompose was last started, per isolate:
 *  enough to keep a burst of reads, or an upstream that is down, from
 *  starting one composition per request. */
const attempted = new Map<string, number>();

/**
 * The copy a read should serve. Today's stored one when there is one.
 * With a copy of an earlier day, a caller that can `defer` work (a
 * request's `ctx.waitUntil`) is answered with that copy at once and the
 * recompose runs behind the response — an upstream that is down then
 * costs the reader nothing, and the page judges "today" by its own
 * calendar anyway. Without `defer`, or with nothing stored, the recompose
 * is inline, and an earlier day's copy still answers if it fails. Null
 * only when nothing exists and nothing can be composed.
 */
export async function load(
  env: Env,
  snapshot: Snapshot,
  defer?: (work: Promise<unknown>) => void
): Promise<Stored | null> {
  const today = isoToday();
  const stored = await read(env, snapshot);
  if (stored?.meta.day === today) return stored;
  const recompose = () =>
    refresh(env, snapshot, today, stored).catch((error) => {
      console.error(`Composing ${snapshot.key} failed`, error);
      return stored;
    });
  if (!stored || !defer) return recompose();
  const now = Date.now();
  if (now - (attempted.get(snapshot.key) ?? Number.NEGATIVE_INFINITY) >= RETRY_AFTER_MS) {
    attempted.set(snapshot.key, now);
    defer(recompose());
  }
  return stored;
}

/** 200 with the JSON body, or 304 when the client already holds it. The
 *  header set is identical across both. */
export function serve(
  request: Request,
  {
    text,
    meta: { etag, changedAt },
  }: { text: string; meta: Pick<SnapshotMeta, "etag" | "changedAt"> }
): Response {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": new Date(changedAt).toUTCString(),
  };
  if (etagMatches(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers });
}

/** `GET /<service>/site`. */
export function siteHandler(snapshot: Snapshot): Handler {
  return async (request, env, ctx) => {
    const stored = await load(env, snapshot, (work) => ctx.waitUntil(work));
    return stored ? serve(request, stored) : json({ error: "Service unavailable" }, 503);
  };
}

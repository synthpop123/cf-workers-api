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
 *     stored, one of another schema version (a deploy changed the shape;
 *     the page would reject it), or one composed as of another day (every
 *     window the pages draw ends today, so midnight is an event too).
 * If that inline recompose fails, a same-version copy from an earlier day
 * still answers — yesterday's view beats an error — and only a service
 * with nothing stored at all answers 503.
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

/** Compose and store. Rejects when composition does. */
export async function refresh(
  env: Env,
  snapshot: Snapshot,
  today = isoToday(),
  previous?: Stored | null
): Promise<Stored> {
  const prior = previous === undefined ? await read(env, snapshot) : previous;
  return store(env, snapshot, await snapshot.compose(env, today), today, prior);
}

/**
 * The copy a read should serve: today's stored one, else a fresh
 * composition, else an earlier day's copy. Null only when nothing exists
 * and nothing can be composed.
 */
export async function load(env: Env, snapshot: Snapshot): Promise<Stored | null> {
  const today = isoToday();
  const stored = await read(env, snapshot);
  if (stored?.meta.day === today) return stored;
  try {
    return await refresh(env, snapshot, today, stored);
  } catch (error) {
    console.error(`Composing ${snapshot.key} failed`, error);
    return stored;
  }
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
  return async (request, env) => {
    const stored = await load(env, snapshot);
    return stored ? serve(request, stored) : json({ error: "Service unavailable" }, 503);
  };
}

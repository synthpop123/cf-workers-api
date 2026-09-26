/**
 * The slice of Koito's public web API this service reads
 * (`/apis/web/v1`, no key — the instance's read API is open), and the
 * calls that fetch it. Every body is narrowed by hand: these are a
 * third-party app's shapes, and a field rename upstream must become a
 * failed composition (the last good snapshot keeps serving), never a
 * silent change to a payload this Worker owns.
 */

import type { Env } from "../../env";
import { TIME_ZONE } from "../../lib/http";

export interface KoitoStats {
  listen_count: number;
  track_count: number;
  album_count: number;
  artist_count: number;
  minutes_listened: number;
  days_active: number;
  avg_daily_plays: number;
  longest_streak: number;
}

export interface KoitoDay {
  /** `2026-09-20T00:00:00+08:00` — midnight in the requested zone. */
  start_time: string;
  listens: number;
}

export interface KoitoListen {
  time: string;
  track: {
    id: number;
    title: string;
    artists: { name: string }[];
    image: { small?: string; medium?: string } | null;
  };
}

export interface KoitoData {
  stats: KoitoStats;
  activity: KoitoDay[];
  listens: KoitoListen[];
}

const TIMEOUT_MS = 10_000;
const STAT_KEYS = [
  "listen_count",
  "track_count",
  "album_count",
  "artist_count",
  "minutes_listened",
  "days_active",
  "avg_daily_plays",
  "longest_streak",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

async function get(env: Env, path: string): Promise<unknown> {
  const response = await fetch(new URL(`/apis/web/v1/${path}`, env.KOITO_URL), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Koito answered ${response.status} for ${path}`);
  return response.json();
}

export function narrowStats(body: unknown): KoitoStats {
  if (!isRecord(body)) throw new Error("Koito stats is not an object");
  const stats = {} as KoitoStats;
  for (const key of STAT_KEYS) {
    const value = body[key];
    if (!isNumber(value)) throw new Error(`Koito stats lacks ${key}`);
    stats[key] = value;
  }
  return stats;
}

export function narrowActivity(body: unknown): KoitoDay[] {
  if (!isRecord(body) || !Array.isArray(body.activity)) {
    throw new Error("Koito activity has no series");
  }
  return body.activity.flatMap((day): KoitoDay[] =>
    isRecord(day) && typeof day.start_time === "string" && isNumber(day.listens)
      ? [{ start_time: day.start_time, listens: day.listens }]
      : []
  );
}

export function narrowListens(body: unknown): KoitoListen[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Koito listens has no items");
  }
  return body.items.flatMap((item): KoitoListen[] => {
    if (!isRecord(item) || typeof item.time !== "string" || !isRecord(item.track)) return [];
    const { id, title, artists, image } = item.track;
    if (!isNumber(id) || typeof title !== "string" || title === "") return [];
    return [
      {
        time: item.time,
        track: {
          id,
          title,
          artists: (Array.isArray(artists) ? artists : []).flatMap((artist) =>
            isRecord(artist) && typeof artist.name === "string" ? [{ name: artist.name }] : []
          ),
          image: isRecord(image)
            ? {
                small: typeof image.small === "string" ? image.small : undefined,
                medium: typeof image.medium === "string" ? image.medium : undefined,
              }
            : null,
        },
      },
    ];
  });
}

export async function fetchKoito(env: Env, days: number, listens: number): Promise<KoitoData> {
  const [stats, activity, recent] = await Promise.all([
    get(env, "stats?period=all_time"),
    get(env, `listen-activity?step=day&range=${days}&tz=${encodeURIComponent(TIME_ZONE)}`),
    get(env, `listens?period=all_time&limit=${listens}`),
  ]);
  return {
    stats: narrowStats(stats),
    activity: narrowActivity(activity),
    listens: narrowListens(recent),
  };
}

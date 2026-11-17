/**
 * The slice of the self-hosted Beszel hub (`BESZEL_URL`, a PocketBase
 * app) this service reads, and the calls that fetch it: a password
 * sign-in as a read-only user (`BESZEL_EMAIL` / `BESZEL_PASSWORD`), then
 * two reads in parallel — the systems (host metrics, with each host's
 * hardware expanded in) and every container record (name and Docker
 * health). Every body is narrowed by hand: a renamed field must become a
 * failed composition, never a silent change to the payload.
 */

import { fetchOk } from "../../lib/http";
import { isNumber, isRecord, textOrNull } from "../../lib/narrow";

export const HOST_STATUSES = ["up", "down", "paused", "pending"] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

/** Beszel's `DockerHealth`, by its stored number. */
export const HEALTH = ["none", "starting", "healthy", "unhealthy"] as const;
export type Health = (typeof HEALTH)[number];

export interface BeszelSystem {
  id: string;
  name: string;
  status: HostStatus;
  /** Epoch ms the hub last wrote the record (the agent reports each minute). */
  updated: number;
  cpu: number;
  memoryPct: number;
  diskPct: number;
  load: [number, number, number] | null;
  /** Seconds. */
  uptime: number;
  details: { cores: number; memory: number; arch: string; os: string } | null;
}

export interface BeszelContainer {
  system: string;
  name: string;
  health: Health;
  /** Epoch ms. The hub keeps a record ten minutes past its last report. */
  updated: number;
}

export interface BeszelData {
  systems: BeszelSystem[];
  containers: BeszelContainer[];
}

/** PocketBase's page cap; one page holds every container (≈ 130 now). */
const PER_PAGE = 1000;

/** PocketBase datetimes: `2026-11-17 11:18:42.824Z`. */
const parseTime = (value: unknown): number => {
  const ms = typeof value === "string" ? Date.parse(value.replace(" ", "T")) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`Beszel time is not one: ${String(value)}`);
  return ms;
};

function narrowDetails(value: unknown): BeszelSystem["details"] {
  const detail = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(detail)) return null;
  const { cores, memory, arch, os_name } = detail;
  if (!isNumber(cores) || !isNumber(memory)) return null;
  return { cores, memory, arch: textOrNull(arch) ?? "", os: textOrNull(os_name) ?? "" };
}

export function narrowSystems(body: unknown): BeszelSystem[] {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error("Beszel systems has no items");
  return body.items.map((item): BeszelSystem => {
    if (!isRecord(item) || !isRecord(item.info)) throw new Error("Beszel system has no info");
    const { id, name, status, info } = item;
    const sid = textOrNull(id);
    const label = textOrNull(name);
    if (!sid || !label) throw new Error("Beszel system has no id or name");
    if (!HOST_STATUSES.includes(status as HostStatus)) {
      throw new Error(`Beszel system ${label} has status ${String(status)}`);
    }
    const { cpu, mp, dp, la, u } = info;
    if (!isNumber(cpu) || !isNumber(mp) || !isNumber(dp) || !isNumber(u)) {
      throw new Error(`Beszel system ${label} lacks cpu, mp, dp or u`);
    }
    const load =
      Array.isArray(la) && la.length === 3 && la.every(isNumber)
        ? (la as [number, number, number])
        : null;
    return {
      id: sid,
      name: label,
      status: status as HostStatus,
      updated: parseTime(item.updated),
      cpu,
      memoryPct: mp,
      diskPct: dp,
      load,
      uptime: u,
      details: narrowDetails(isRecord(item.expand) ? item.expand.system_details_via_system : null),
    };
  });
}

export function narrowContainers(body: unknown): BeszelContainer[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Beszel containers has no items");
  }
  if (body.items.length >= PER_PAGE) throw new Error("Beszel containers fill a whole page");
  return body.items.map((item): BeszelContainer => {
    if (!isRecord(item)) throw new Error("Beszel container is not an object");
    const system = textOrNull(item.system);
    const name = textOrNull(item.name);
    const { health, updated } = item;
    if (!system || !name || !isNumber(updated)) {
      throw new Error("Beszel container lacks system, name or updated");
    }
    if (!isNumber(health) || !Number.isInteger(health) || !HEALTH[health]) {
      throw new Error(`Beszel container ${name} has health ${String(health)}`);
    }
    return { system, name, health: HEALTH[health], updated };
  });
}

export async function fetchBeszel(env: Env): Promise<BeszelData> {
  const base = env.BESZEL_URL;
  const auth = await fetchOk(
    "Beszel auth",
    new URL("/api/collections/users/auth-with-password", base),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identity: env.BESZEL_EMAIL, password: env.BESZEL_PASSWORD }),
    }
  );
  const authBody: unknown = await auth.json();
  const token = isRecord(authBody) ? textOrNull(authBody.token) : null;
  if (!token) throw new Error("Beszel auth returned no token");

  const list = async (collection: string, query: Record<string, string>) => {
    const url = new URL(`/api/collections/${collection}/records`, base);
    url.searchParams.set("perPage", String(PER_PAGE));
    url.searchParams.set("skipTotal", "1");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchOk(`Beszel ${collection}`, url, {
      headers: { Accept: "application/json", Authorization: token },
    });
    return (await response.json()) as unknown;
  };

  const [systems, containers] = await Promise.all([
    list("systems", {
      expand: "system_details_via_system",
      fields: "id,name,status,updated,info,expand.system_details_via_system",
    }),
    list("containers", { fields: "system,name,health,updated" }),
  ]);
  return { systems: narrowSystems(systems), containers: narrowContainers(containers) };
}

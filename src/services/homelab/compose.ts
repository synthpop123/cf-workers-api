/**
 * The pure layer: Beszel's narrowed records in, the public /homelab/site
 * body out. No bindings, no clock — `today` is passed in.
 *
 * The hub keeps a container's record for ten minutes after its last
 * report, so a container that was just recreated shows twice (old id, new
 * id) and one that was removed lingers. Each host's list is therefore cut
 * to the records reported with its latest round (`ROUND_MS` of the newest
 * one), one per name. A host that is not up reports no containers and no
 * metrics: what Beszel still holds for it is from before it went quiet.
 */

import type { BeszelData, Health, HostStatus } from "./beszel";

export const SITE_VERSION = 1;
/** How far behind a host's newest container record one may be and still
 *  belong to the same report (the agent reports once a minute). */
export const ROUND_MS = 150_000;

export interface SiteContainer {
  name: string;
  health: Health;
}

export interface SiteHost {
  name: string;
  status: HostStatus;
  /** ISO instant the hub last heard from the host's agent. */
  seenAt: string;
  /** Percent, whole numbers; null unless the host is up. */
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  /** 1, 5 and 15-minute load averages, two decimals. */
  load: [number, number, number] | null;
  /** ISO minute the host booted. */
  bootedAt: string | null;
  cores: number | null;
  memoryBytes: number | null;
  arch: string | null;
  os: string | null;
  /** Containers by health, then the containers themselves by name. */
  health: Record<Health, number>;
  containers: SiteContainer[];
}

export interface Site {
  schemaVersion: number;
  today: string;
  hosts: SiteHost[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function composeSite(data: BeszelData, today: string): Site {
  const hosts = data.systems
    .map((system): SiteHost => {
      const up = system.status === "up";
      const own = up ? data.containers.filter((c) => c.system === system.id) : [];
      const newest = Math.max(...own.map((c) => c.updated));
      const latest = new Map<string, (typeof own)[number]>();
      for (const record of own) {
        if (record.updated < newest - ROUND_MS) continue;
        const seen = latest.get(record.name);
        if (!seen || record.updated > seen.updated) latest.set(record.name, record);
      }
      const containers = [...latest.values()]
        .map(({ name, health }) => ({ name, health }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const health: Record<Health, number> = { healthy: 0, starting: 0, unhealthy: 0, none: 0 };
      for (const container of containers) health[container.health]++;
      const booted = Math.round((system.updated - system.uptime * 1000) / 60_000) * 60_000;
      return {
        name: system.name,
        status: system.status,
        seenAt: new Date(system.updated).toISOString(),
        cpu: up ? Math.round(system.cpu) : null,
        memory: up ? Math.round(system.memoryPct) : null,
        disk: up ? Math.round(system.diskPct) : null,
        load: up && system.load ? (system.load.map(round2) as [number, number, number]) : null,
        bootedAt: up ? new Date(booted).toISOString() : null,
        cores: system.details?.cores ?? null,
        memoryBytes: system.details?.memory ?? null,
        arch: system.details?.arch || null,
        os: system.details?.os || null,
        health,
        containers,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { schemaVersion: SITE_VERSION, today, hosts };
}

/** What a reader acts on — each host's status and its containers' health —
 *  without the metrics that move every minute. */
export function stateOf(site: Pick<Site, "hosts">): string {
  return JSON.stringify(
    site.hosts.map(({ name, status, containers }) => [name, status, containers])
  );
}

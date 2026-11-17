# homelab

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

- **Beszel is read as a read-only user** (`BESZEL_EMAIL` / `BESZEL_PASSWORD`, secrets; a
  Beszel user with role `readonly` that can see both systems). PocketBase has no API keys
  for ordinary users, so every composition signs in first: three calls — sign-in, then
  `systems` (hardware expanded through `system_details_via_system`) and `containers` in
  parallel. Do not fold the two reads into one `containers?expand=system`: a host that is down
  has no fresh container records, so it would drop out of the view instead of showing *down*.
- **The write policy is the point of `refreshHomelab`.** Host metrics move every minute, so the
  plain `refresh` would put a new body on every heartbeat (288 KV writes a day of the
  account's 1,000). It stores only when `stateOf` changed — a host's status, a container's
  health, a container come or gone — or the stored copy is `METRICS_EVERY_MS` old, or the day
  turned. Keep metrics out of `stateOf`, and round what ships (whole percents, two-decimal
  load, `bootedAt` to the minute) so a stored body says no more than a reader can use.
- **Container records outlive containers.** The hub deletes a record ten minutes after its last
  report, so a recreated container shows twice for a while and a removed one lingers.
  `composeSite` keeps, per host, only the records within `ROUND_MS` of that host's newest one,
  one per name. A host that is not up reports no containers and no metrics.
- The narrowed slice drops hostnames, kernel, images, ports and container status text
  (`Up 3 minutes` would also defeat the write policy). Beszel's health numbers are its
  `DockerHealth` enum: 0 none, 1 starting, 2 healthy, 3 unhealthy; anything else fails the
  composition.
- The containers' healthchecks come from the homelab-infra repo (`docs/conventions.md` →
  Healthchecks): every probe there runs once a minute, which is also the agent's cadence.

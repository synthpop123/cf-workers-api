# Security

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/synthpop123/cf-workers-api/security/advisories/new)
rather than a public issue. You should hear back within a few days.

What counts: anything that lets an unauthenticated request write, delete
or read something a public view does not already show — for example a way
around the bearer checks, or a private upstream field (device ids, account
identity, PNRs, serial numbers) reaching a public body.

The deployment's secrets live as Worker secrets and are never in this
repository; the ids in `wrangler.jsonc` name resources but grant no access.

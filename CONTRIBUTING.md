# Contributing

Thanks for taking a look. This is a personal API, but issues and pull
requests are welcome — especially bug fixes and anything that makes a
service easier to reuse.

## Workflow

```sh
npm install
cp .dev.vars.example .dev.vars
npm run check      # wrangler types, Biome format check, tsc, vitest
```

`npm run check` is exactly what CI and the deploy build run; a pull request
should pass it. Run `npm run format` to fix formatting.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): summary`, where the scope is usually a service (`tokens`,
`switch`, `flights`, `music`, `movies`) or a shared part (`router`,
`snapshot`, `schedule`). Common types: `feat`, `fix`, `refactor`, `perf`,
`test`, `docs`, `build`, `ci`, `chore`, `style`. Explain *why* in the body.
A change to a view's shape is a breaking change for its consumers: bump its
`SITE_VERSION` and say so.

## Conventions

- **A service owns its prefix.** Routes and KV keys live under
  `/<name>/…` and `<name>:…`; `test/services.spec.ts` enforces it.
- **Views are snapshots.** Serve through `lib/snapshot.ts`; don't hand-roll
  KV caching or ETags in a service.
- **Narrow every upstream by hand.** A public body is built field by field
  from a typed slice of the upstream, so a rename fails loudly and private
  fields cannot leak. Add a test that the private fields stay out.
- **Never key a plain object by request input** — use a `Map` (see
  AGENTS.md for the two bugs that rule came from).
- **Migrations are append-only**; D1 tracks them by filename.
- **Tests run in `workerd`** against real D1/KV/R2 bindings and mock every
  upstream `fetch`.

AGENTS.md holds the longer list of project rules and the reasons behind
them.

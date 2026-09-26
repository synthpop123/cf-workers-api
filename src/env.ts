/**
 * Bindings, vars and secrets all come from wrangler.jsonc through
 * `wrangler types` (Cloudflare.Env in the generated
 * worker-configuration.d.ts) — secrets via `secrets.required` — so the
 * binding list has exactly one source of truth. Don't hand-maintain one.
 */
export type Env = Cloudflare.Env;

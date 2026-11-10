# flights · music · movies

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

- **The payload is the map, not the log.** `composeSite` in
  `services/flights/compose.ts` ships airports, routes (airport pairs, either direction
  merged), airline/aircraft tallies and totals — no single flight, never
  a flight number or a time of day. The map shows where, not when, and the
  payload claims no more than the pages show. Redaction is
  structural: `services/flights/airtrail.ts` types only the upstream fields composition
  reads (PNRs in `note`, seats, gates, registrations and passenger ids are
  never typed), and the payload is built field by field from that slice.
  `test/flights/compose.spec.ts` pins it with a flight carrying every secret.
- AirTrail is read with `AIRTRAIL_API_KEY` (sent as `Authorization:
  Bearer`); it is the one secret of the three pollers. Koito's web API and
  Letterboxd's RSS are public.
- music ships Koito's cover art as absolute URLs on the instance (it is
  self-hosted, so linking it is not hotlinking); movies mirrors posters,
  because Letterboxd's CDN is someone else's. The poster key carries
  Letterboxd's `v` hash, so a replaced poster lands under a new key.
- movies keeps diary entries only (items with `letterboxd:watchedDate`;
  the same feed carries lists) and orders them by watched date — the feed
  is ordered by when an entry was logged.
- music's `LISTENS` and movies' `FILMS` are exactly what /misc shows. If
  the page wants more rows, change the constant here (a payload change:
  bump `SITE_VERSION`).

# now

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

- The home page's Now tiles. It **reads the other services' stored
  snapshots** (`read`, any day), music, movies, tokens and portfolio, and
  never composes them or asks an upstream: composing a source from here
  would put that upstream on this service's clock. Tokens adds the last
  `TOKENS_DAYS` (14) daily totals for the tile's bars, `week` (tokens and
  cost over the seven days ending today, the tile's figure) and `top`, the week
  range's busiest model (placeholder ids skipped) with its share; portfolio is the
  whole portfolio's index and the benchmark cut to /misc's 3M range
  (`pickPortfolio`, `shiftMonths` mirroring the page's `rangeCutoff`), so
  the tile's return is the last value over the first.
- The heartbeat refreshes it right after music, in one job, so the home
  page is never a run behind it. Tokens, films and the portfolio (hourly,
  at :05) reach it within five minutes of their own writes.
- Keep the body small and only what the tiles show. It is a KV write
  whenever any field moves, so a field that changes on every tokens
  submission or every listen costs a write each time.
- A composition over the same day and the same source ETags returns the
  last body from the isolate's memory, without parsing the sources.

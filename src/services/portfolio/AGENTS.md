# portfolio

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

- The owner records the portfolio in **both** Wealthfolio and Ghostfolio
  (self-hosted on the arm host; composes in homelab-infra
  `stacks/wealthfolio`, with `WF_MCP_ENABLED`, and `stacks/ghostfolio`),
  and each answers what it is good at: **the money from Wealthfolio**
  (`WEALTHFOLIO_URL`), **the securities from Ghostfolio**
  (`GHOSTFOLIO_URL`). This Worker stores nothing but the snapshot.
- Wealthfolio is read through its MCP endpoint (`/mcp`, Streamable HTTP,
  one session per composition, closed after) with a personal access
  token minted in Settings → AI agent access with **read scopes only**
  (`WEALTHFOLIO_TOKEN`). The tools it calls: `get_accounts`,
  `get_cash_balances`, `get_valuation_history` and `get_holdings` (whole
  portfolio and each account). `get_valuation_history` answers only a
  range's earliest 400 points (`MAX_VALUATIONS_POINTS`, flagged
  `truncated`), so `readHistory` pages it from the day after the last
  one read and fails on a gap or overlap rather than ship a line that
  stops at day 400.
- Ghostfolio is read by a bot user (`GHOSTFOLIO_TOKEN` → `POST
  /api/v1/auth/anonymous` → JWT) through a PRIVATE read-only access the
  owner granted it (`Impersonation-Id: GHOSTFOLIO_ACCESS_ID`; it expires,
  `Access.expiresAt`, currently 2027-10): one `/api/v1/portfolio/holdings`
  for every held symbol's asset profile (name, kind, a stock's sector, its
  dominant country, its site — the public asset endpoint hides those from
  a non-admin) and `/api/v1/symbol/<source>/<symbol>` for closes and VOO.
  Ghostfolio keeps history only for symbols it gathers, so a symbol
  missing from its ledger ships with no line and nothing said of it;
  returns never depend on it.
- **The payload is returns, never amounts.** `wealthfolio.ts` types only
  what composition reads. Per account `compose.ts` ships two series on the
  axis, its value (holdings and cash) and the money put in to date, both
  divided by the most ever put in (`capital`), so they are ratios and no
  amount survives. A range's return is one over the other: its gain over
  the value it started from plus the money put in since (a deposit never
  reads as a gain). Over one session that is the day's time-weighted
  return (`dayReturn`), which this Worker chains (`growthIndex`) and ships
  on the axis as `growth`: the page's last session, strip and drawdown
  read it, never re-derive it from the ratios — those cannot carry the
  `MIN_CAPITAL` rule without the amount it is measured in, and must not.
  The weekly part of the axis also hides a week's peak and trough, so
  each axis day before the daily window ships its deepest fall to date at
  daily resolution (`falls`). Wealthfolio's own TWR/IRR are not read. The
  tests pin that no amount reaches the body.
- Per position it also ships the **average price paid per share**
  (`cost`: cost basis over quantity, divided in `wealthfolio.ts`), the
  position's own return (Wealthfolio's `totalReturnPct`: gain, realised,
  unrealised and income, over what went into it) and the first buy's day
  (`since`). A per-share price without a share count is not a
  sum — keep it that way: never ship the quantity or a trade.
  `get_holdings` lists a page of positions and leaves the smallest out;
  weights still divide by the account's full total.
- Accounts show under the short name and broker logo `BROKERS` gives by
  their Wealthfolio name (`Interactive Brokers` → `IBKR`,
  interactivebrokers.com); an account not there keeps its own name and no
  logo.
- Cash ships only in US dollars (`CASH_CURRENCY`): what else a broker
  leaves (IBKR's CNH interest, an HKD conversion's change) is dust, kept
  out of the cash rows and out of the weights' total. The value series
  still include it, as Wealthfolio values it.
- Days on less than `MIN_CAPITAL` (100, base currency) earn no return, so
  an account that held only dust starts the day real money went in.
- The ledger is entered in **split-adjusted** terms: Yahoo rewrites price
  history after a split and the ledger keeps what was entered, so a trade
  from before a split is entered at its post-split quantity and price
  (MVIS's 1:15 of 2026-08-01, in Schwab, with the original in the
  comment). A position valued far from what was paid on its first day is
  the symptom.
- Days are **US market sessions**, not Shanghai days. Wealthfolio dates
  its valuations by its server zone (Asia/Shanghai) and values the last
  day at the latest quote, so from Shanghai midnight until the next New
  York open that day is the previous session again. `toSessions` folds
  every day from `marketSession(now)` on into that session; holiday
  calendars are not modelled. Weekends drop off the axis; days older than
  `DAILY_DAYS` thin to one a week, except that every day money moved in
  any account stays, with the axis day before it. The page reads deposits
  and withdrawals off adjacent axis days, so a week's money out and back
  in folded into one step would net out and read as gain or loss; kept
  apart, every return the page measures there is the daily one.
- Each account also ships its **best days** (`best`, `bestDays`): newest
  first, every session whose return beat all the ones after it, read off
  the daily returns before the axis thins them. The page's Best day for a
  range is the earliest entry dated after the range's start.
- A composition is about two dozen requests (a Wealthfolio session: the
  accounts, cash, a history and holdings for the portfolio and each
  account; a Ghostfolio sign-in, the holdings' profiles and one price
  history per holding plus VOO), hence its own `offset: 5` minute
  in the hourly slot. A holding whose history fails ships without a line;
  anything else fails the composition.
- Logos come from logo.dev's ticker lookup (`LOGO_DEV_TOKEN`, a
  publishable key that still never reaches a browser), mirrored once per
  ticker as `portfolio/logos/<TICKER>-96.webp`, brokers by domain as
  `portfolio/brokers/<domain>-96.webp`. Delete the object to pick up a new
  logo. `lib/images.ts` logs a failed mirror by key, not source URL,
  because this source carries the key.

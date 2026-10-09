# Running tokens reporters

Every machine whose AI-agent usage should count runs the
[`tokens`](https://github.com/missuo/tokens) CLI as a long-lived `tokens serve`,
which rescans the local session logs and submits them every
`TOKENS_SUBMIT_INTERVAL` minutes. One machine may additionally run the two
quota collectors. This is how to set either up, and the operational traps
that have actually bitten.

## Point the CLI here

```sh
tokens login --token "$TOKENS_API_TOKEN"     # stored in ~/.config/tokens/credentials.json
export TOKENS_API_URL=https://api.lkwplus.com/tokens
```

The CLI joins `TOKENS_API_URL` with `/api/submit`, so the base URL includes
the `/tokens` service prefix. The bearer token lives in the CLI's own
credentials file — never in a unit file or plist — so there is one thing to
rotate per machine. A device's display name comes from `TOKENS_DEVICE_NAME`
if set, else `~/.config/tokens/device.json`; that name is the only identity
the public view carries.

Check what the fleet is running:

```sh
curl -s https://api.lkwplus.com/tokens/site \
  | jq -r '.devices[] | "\(.name)\t\(.cliVersion)\t\(.lastSeen/1000 | strflocaltime("%F %R"))"'
```

## macOS — LaunchAgent

Use a hand-written LaunchAgent ([`scripts/tokens/tokens-serve.plist`](../scripts/tokens/tokens-serve.plist)):

```sh
cp scripts/tokens/tokens-serve.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tokens-serve.plist
launchctl print gui/$(id -u)/tokens-serve       # state = running
```

- Point it at Homebrew's version-independent symlink
  (`/opt/homebrew/opt/tokens/bin/tokens`) so an upgrade needs no plist edit.
- **Don't also start `brew services`.** The formula ships a service block, so
  `brew services list` reports `tokens none` while the LaunchAgent runs
  perfectly well — "fixing" that gives the machine two reporters.
- A Homebrew tap can lag upstream releases. Wait for it rather than dropping
  a binary into the Cellar by hand, which the next `brew upgrade` reverts.

## Linux — systemd user unit

Use [`scripts/tokens/tokens-serve.service`](../scripts/tokens/tokens-serve.service):

```sh
install -Dm644 scripts/tokens/tokens-serve.service -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokens-serve.service
loginctl enable-linger "$USER"                  # keep running with nobody logged in
```

- **Linger is load-bearing** on a server nobody logs into: without it the
  user units stop when the last session ends.
- Driving another user's units from root (`su - user -c 'systemctl --user …'`)
  needs `XDG_RUNTIME_DIR=/run/user/<uid>` set by hand; without it every
  command fails with a bus error that looks like the units are gone.

## After upgrading the CLI, restart `serve`

Replacing the binary leaves the running `serve` process on the old inode. On
Linux it spawns each submission through `/proc/self/exe`, so after an
install over the binary every submit fails with
`No such file or directory (os error 2)` while the process itself stays
`active (running)`. On the dashboard the symptom is a device whose
`cliVersion` never moves, because the old process reports its own version.

```sh
launchctl bootout gui/$(id -u)/tokens-serve         # macOS: reload, not
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tokens-serve.plist
systemctl --user restart tokens-serve.service       # Linux
```

On macOS `kickstart -k` is not enough: the binary is ad-hoc signed and
launchd keeps the old one's launch constraint, so the restart dies with
`last exit reason = OS_REASON_CODESIGNING` until the agent is reloaded.

The quota timers re-exec the binary on every run and pick a new version up
on their own. `systemctl --user list-timers` does not list services, so use
`systemctl --user list-units --all "*token*"` before concluding nothing
needs a restart.

## Cursor: report from one machine only

Cursor has no local session log: each submit refreshes the whole account's
usage into `<config>/cursor-cache/usage.json`, and the scanner reads that
file. Two logged-in machines therefore report the same rows under two device
ids and the dashboard adds them — and `cursor logout` does not stop it (the
stale file replays every interval). Deleting `<config>/cursor-cache/` does.
The duplicate is invisible on the dashboard; check D1:

```sh
npx wrangler d1 execute tokens-usage --remote --command \
  "SELECT date, COUNT(DISTINCT device_id) AS devices FROM daily_usage
   WHERE client = 'cursor' GROUP BY date HAVING devices > 1"
```

It must return nothing.

## Cursor: sync on a timer, not from `serve`

Every submit first refreshes the Cursor cache by refetching the account's
**whole** usage history from `cursor.com/api/dashboard/get-filtered-usage-events`,
500 events a page, and the implicit sync inside `submit`/`serve` gets one
hard-coded 15-second budget (`CURSOR_HTTP_TIMEOUT` in the CLI's `cursor.rs`,
no env override) for all the pages together. The history only grows: at
~6,000 events (October 2026) a fetch takes 15–21 s from OracleARM, so nearly
every implicit sync died at exactly 15.0 s and the submit silently fell back
to the stale `usage.json`. Cursor then showed nothing for a whole day while
`serve` stayed green. The log names it, under three different messages
depending on where the deadline hit:

```
Cursor sync failed; using cached data: …: error sending request for url (…)
Cursor sync failed; using cached data: …: Failed to read the Cursor usage events JSON response
Cursor sync failed; using cached data: …: Cursor usage events fetch exceeded its overall time budget …
```

The explicit `tokens cursor sync` gets 120 s. So on the machine that reports
Cursor, `serve` never syncs and a timer does:

- `serve` syncs only when it finds `cursor-credentials.json` in its config
  dir, while the scanner reads `cursor-cache/` regardless. It therefore runs
  with `TOKENS_CONFIG_DIR=~/.config/tokens-serve`, a sibling dir whose entries
  are symlinks back to `~/.config/tokens` — everything except
  `cursor-credentials.json`. Same device id, same cache, no Cursor login, no
  requests to cursor.com.
- `tokens-cursor-sync.timer` runs `tokens cursor sync` (default config dir,
  where the login lives) every 3 hours. Dashboard Cursor numbers lag by at
  most that; cursor.com sees ~8 full fetches a day instead of ~48 that mostly
  failed half-way.

```sh
A=~/.config/tokens S=~/.config/tokens-serve
install -d -m700 "$S"
for f in credentials.json device.json settings.json cursor-cache cache; do ln -sfn "$A/$f" "$S/$f"; done
TOKENS_CONFIG_DIR="$S" tokens status          # same device id as without it
TOKENS_CONFIG_DIR="$S" tokens cursor status   # "No saved Cursor accounts."

install -Dm644 scripts/tokens/tokens-serve-no-cursor-sync.conf \
  ~/.config/systemd/user/tokens-serve.service.d/no-cursor-sync.conf
install -Dm644 scripts/tokens/tokens-cursor-sync.{service,timer} -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokens-cursor-sync.timer
systemctl --user restart tokens-serve.service
```

The units assume `~/.local/bin/tokens`; OracleARM's binary is
`/usr/local/bin/tokens`, so its installed `tokens-cursor-sync.service` names
that instead. Its serve unit's `[Service]` is otherwise as in
`tokens-serve.service` plus `TOKENS_DEVICE_NAME` and `TZ`.

To check it works: the serve log must no longer print `Syncing Cursor usage
data...`, `journalctl --user -u tokens-cursor-sync` shows `Synced N Cursor
usage event(s).` every 3 h, and `cursor-cache/usage.json`'s mtime moves with
it. A new file under `~/.config/tokens` (a future CLI version may add one)
needs its symlink too; `tokens status` under the override shows which paths
it resolves. `tokens cursor login` must be run **without** the override, or
`serve` would pick the login up and start syncing again.

## Quota collectors

Subscription quota is account-wide, so exactly **one** machine reports it —
a second adds a race and no information. On that machine, as the user that
holds the Codex and Claude credentials:

```sh
install -Dm755 scripts/tokens/report-codex-quota.sh ~/.local/bin/report-codex-quota.sh
install -Dm755 scripts/tokens/report-claude-quota.py ~/.local/bin/report-claude-quota.py
install -Dm644 scripts/tokens/tokens-quota-*.{service,timer} -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokens-quota-codex.timer tokens-quota-claude.timer
```

Both read the bearer token from the CLI's credentials file and report every
30 minutes to `POST /tokens/quota/{codex,claude}`, each to its own route and
its own stored plan, so an expired credential on one leg leaves the other's
card current. The Worker only ever sees percentages and timestamps.

| Plan | Collector | Reaches the vendor via |
|---|---|---|
| Codex | `report-codex-quota.sh` | `tokens codex status --json`, which reads and refreshes `~/.codex/auth.json` |
| Claude | `report-claude-quota.py` | `api.anthropic.com/api/oauth/usage` with `~/.claude/.credentials.json` |

**The Claude credential can be destroyed by a careless refresh.** Anthropic
rotates the refresh token on every exchange — the old one dies the moment a
new one is issued — so the collector refreshes only within ten minutes of
expiry, writes the new pair back atomically *before* using it (temp file in
the same directory → `fsync` → `os.replace`, mode 0600), and preserves every
other field in the file, which belongs to Claude Code. The access token
lasts about twelve hours and the refresh token about 30 days from each use,
so the timer keeps itself alive; if it stops for longer than that, log in
to Claude Code on that machine again.

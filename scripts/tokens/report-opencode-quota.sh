#!/usr/bin/env bash
#
# Report the OpenCode Go subscription's rate-limit snapshot to
# POST /tokens/quota/opencode.
#
# opencode.ai/zen/go/v1/usage answers with the plan's three windows
# (five-hour, weekly, monthly) for an OpenCode API key. That key is an
# inference key — it can spend the plan, not just read it — so it stays
# in a 0600 file on this machine and never reaches the Worker, which
# only ever sees percentages and timestamps (see
# src/services/tokens/quota-registry.ts for what it keeps).
#
# Runs on the same host and the same way as the Codex leg: one systemd
# user timer, its own route, its own stored plan, so a revoked key here
# leaves the other cards current. Silent on success; any failure exits
# non-zero with a reason for `systemctl --user status`.

set -euo pipefail

API_URL="${TOKENS_API_URL:-https://api.lkwplus.com/tokens}"
CREDENTIALS="${TOKENS_CREDENTIALS:-$HOME/.config/tokens/credentials.json}"
OPENCODE_KEY_FILE="${OPENCODE_API_KEY_FILE:-$HOME/.config/tokens/opencode-api-key}"
USAGE_URL="https://opencode.ai/zen/go/v1/usage"

die() {
  echo "report-opencode-quota: $1" >&2
  exit 1
}

[[ -r $CREDENTIALS ]] || die "no readable credentials at $CREDENTIALS"
token="$(jq -re '.token' "$CREDENTIALS")" || die "no .token in $CREDENTIALS"

[[ -r $OPENCODE_KEY_FILE ]] || die "no readable OpenCode API key at $OPENCODE_KEY_FILE"
key="$(tr -d '[:space:]' <"$OPENCODE_KEY_FILE")"
[[ -n $key ]] || die "$OPENCODE_KEY_FILE is empty"

# The key goes in through a header file rather than argv, where any user
# on the box could read it from `ps`. A 403 here is OpenCode's
# EntitlementError: the key's workspace has no Go subscription.
snapshot="$(
  curl --fail-with-body --silent --show-error \
    --retry 2 --retry-delay 5 --max-time 30 \
    --header @<(printf 'Authorization: Bearer %s\n' "$key") \
    --header 'Accept: application/json' \
    "$USAGE_URL"
)" || die "OpenCode usage request failed"
[[ -n $snapshot ]] || die "OpenCode usage request returned nothing"

curl --fail-with-body --silent --show-error \
  --retry 2 --retry-delay 5 --max-time 30 \
  --request POST "$API_URL/quota/opencode" \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data-binary "$snapshot" \
  --output /dev/null

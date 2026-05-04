#!/usr/bin/env bash
# Reads the Claude Code OAuth access token from the macOS Keychain and exports
# it as CLAUDE_CODE_OAUTH_TOKEN for headless tooling (Sandcastle, CI, etc).
#
# Usage: source scripts/claude-oauth-env.sh
#
# This script never prints, logs, or otherwise exposes the token. It only
# emits a confirmation that includes the token length, not its content.
#
# Pre-req: run `claude setup-token` once to populate the Keychain entry.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "ERROR: script must be sourced, not executed." >&2
  echo "Run: source ${BASH_SOURCE[0]}" >&2
  exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: this script reads macOS Keychain. On Linux/server, paste the" >&2
  echo "token directly into .sandcastle/.env or wire up your own secret store." >&2
  return 1
fi

__cc_raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [[ -z "$__cc_raw" ]]; then
  echo "ERROR: no Keychain entry 'Claude Code-credentials'." >&2
  echo "Run: claude setup-token" >&2
  unset __cc_raw
  return 1
fi

__cc_token=$(printf '%s' "$__cc_raw" | python3 -c "
import sys, json
try:
    j = json.loads(sys.stdin.read().strip())
    print(j['claudeAiOauth']['accessToken'])
except Exception:
    sys.exit(1)
" 2>/dev/null)

if [[ -z "$__cc_token" ]]; then
  echo "ERROR: could not parse accessToken from Keychain payload." >&2
  unset __cc_raw __cc_token
  return 1
fi

export CLAUDE_CODE_OAUTH_TOKEN="$__cc_token"
__cc_len=${#CLAUDE_CODE_OAUTH_TOKEN}
unset __cc_raw __cc_token
echo "CLAUDE_CODE_OAUTH_TOKEN exported (length=${__cc_len})"
unset __cc_len

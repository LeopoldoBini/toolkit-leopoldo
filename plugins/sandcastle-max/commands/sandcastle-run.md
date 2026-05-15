---
name: sandcastle-run
description: Run the Sandcastle smoke prompt (.sandcastle/prompt.md) in the per-project Docker image. Extracts secrets (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN) from the host (Keychain on macOS, gh auth token) with .sandcastle/.env as fallback. Triggers when the user says "sandcastle run", "run smoke test", "test sandcastle setup".
---

# /sandcastle-run

Execute the Sandcastle smoke prompt inside the per-project container, authenticated with the user's Claude Max OAuth token. Use this to verify the auth + Docker pipeline before launching real AFK waves.

## Steps

### 1. Pre-checks (run in parallel)

- `git rev-parse --show-toplevel` → store as `REPO`. Error if not a git repo.
- `docker info --format '{{.ServerVersion}}'` — confirm Docker daemon.
- Verify `$REPO/.sandcastle/config.json` exists. Else tell the user to run `/sandcastle-init`.
- Read `IMAGE_NAME=$(jq -r '.imageName' "$REPO/.sandcastle/config.json")`.
- Verify the image exists: `docker image inspect "$IMAGE_NAME" >/dev/null 2>&1`. If not, tell the user to run `/sandcastle-build` first.

### 2. Bootstrap plugin runtime (one-time per machine)

If `${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/` is missing:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/runtime" && (bun install || npm install)
```

### 3. Extract secrets

**CLAUDE_CODE_OAUTH_TOKEN** — try in order, first match wins:

```bash
# (a) macOS Keychain
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)

# (b) .sandcastle/.env fallback
if [[ -z "$TOKEN" && -f "$REPO/.sandcastle/.env" ]]; then
  TOKEN=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$REPO/.sandcastle/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN not found."
  echo "  macOS: run 'claude setup-token' (saves to Keychain), then re-run."
  echo "  Linux/override: paste into $REPO/.sandcastle/.env"
  exit 1
fi

export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"
```

**GH_TOKEN** — optional, only needed for AFK dispatch (smoke test does not require it). Try in order:

```bash
# (a) gh CLI
GH=$(gh auth token 2>/dev/null || true)

# (b) .sandcastle/.env fallback
if [[ -z "$GH" && -f "$REPO/.sandcastle/.env" ]]; then
  GH=$(grep -E '^GH_TOKEN=' "$REPO/.sandcastle/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

[[ -n "$GH" ]] && export GH_TOKEN="$GH"
```

**Do NOT echo or log the actual token values.** Print only "OAuth token: present from Keychain" / "from .env" — never the value.

### 4. Run the orchestrator

```bash
cd "$REPO" && \
  "${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/.bin/tsx" \
  "${CLAUDE_PLUGIN_ROOT}/runtime/main.mts"
```

`main.mts` reads `$REPO/.sandcastle/config.json` (since cwd is `$REPO`), picks up the `CLAUDE_CODE_OAUTH_TOKEN` from env, and launches Sandcastle with the per-project image. The smoke prompt is `.sandcastle/prompt.md`. Expected output ends with `<promise>COMPLETE</promise>`.

### 5. Report

If exit code is 0 and the log contains `<promise>COMPLETE</promise>`, print:

```
✓ Smoke passed.
Ready for AFK dispatch:
  /sandcastle-dispatch-wave   ← if you have issues labeled ready-for-agent
  /sandcastle-pipeline        ← full loop: dispatch → validate → merge
```

If exit code is non-zero, print the last 30 lines of output and link to skill `sandcastle-afk` for troubleshooting. Common failures:

- `claude --print` hangs → re-check the agent.dockerfile UID surgery (host UID vs container UID mismatch). See sandcastle-afk skill.
- `CLAUDE_CODE_OAUTH_TOKEN` invalid → token expired; re-run `claude setup-token`.
- Docker container exits immediately → check `.sandcastle/Dockerfile` ENTRYPOINT is `sleep infinity`.

## Arguments

- `--prompt <path>` — override the smoke prompt file (relative to repo root). Passed via `SANDCASTLE_PROMPT_FILE` env.
- `--model <id>` — override the model. Passed via `SANDCASTLE_MODEL` env (e.g. `claude-sonnet-4-6`).

## Notes

- This command is for **smoke testing only**. Real AFK execution goes via `/sandcastle-dispatch-wave`.
- The container runs read-only against the host repo (`branchStrategy: head`) — no commits, no PRs.
- If the prompt edits files, those edits do NOT persist back to the host (Sandcastle worktree isolation).

---
name: sandcastle-init
description: Scaffold .sandcastle/ in the current repo so AFK Claude Code agents can run in Docker using the user's Claude Max subscription (CLAUDE_CODE_OAUTH_TOKEN) instead of paying for ANTHROPIC_API_KEY tokens. Idempotent — refuses to overwrite existing files unless --force is given. Triggers when the user says "init sandcastle", "set up sandcastle in this repo", "armar sandcastle local", "configurar AFK runner".
---

# /sandcastle-init

You are scaffolding a Sandcastle setup in the current repository so the user can run AFK Claude Code agents (issues, briefs, etc.) inside Docker containers, authenticated with their Claude Max subscription via `CLAUDE_CODE_OAUTH_TOKEN` instead of pay-per-token `ANTHROPIC_API_KEY`.

The user's `${CLAUDE_PLUGIN_ROOT}/templates/` directory contains the working configuration. Your job is to copy them into the user's repo, add wiring to `package.json` and `.gitignore`, and print a checklist for next steps.

## Steps to execute

### 1. Verify pre-conditions

Run these in parallel via Bash and report what is missing:

- `git rev-parse --show-toplevel` — find repo root. If not a git repo, warn and ask the user to confirm before proceeding.
- `docker --version` and `docker info | grep "Server Version"` — confirm Docker is installed and the daemon is running.
- `which claude && claude --version` — confirm Claude Code CLI is installed locally.
- `command -v bun || command -v npm` — confirm a JS runtime is available.
- Check if `~/.local/share/claude` or the macOS Keychain entry `Claude Code-credentials` exists (security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | head -c 0; check exit) — warn if `claude setup-token` has not been run yet.

If any pre-condition fails, **stop** and tell the user what to fix before proceeding.

### 2. Detect collisions

Check whether any of these targets already exist in the repo:

- `.sandcastle/` directory
- `scripts/claude-oauth-env.sh`
- `package.json` already has `sandcastle:build` or `sandcastle:smoke` script

If any collision is detected and the user did not pass `--force` in their command, **stop** and ask: "Found existing X — overwrite with --force or keep current?"

### 3. Copy files from plugin templates

From `${CLAUDE_PLUGIN_ROOT}/templates/` into the repo root, copy:

- `Dockerfile` → `<repo>/.sandcastle/Dockerfile`
- `main.mts` → `<repo>/.sandcastle/main.mts`
- `prompt.md` → `<repo>/.sandcastle/prompt.md`
- `env.example` → `<repo>/.sandcastle/.env.example`

Plus from `${CLAUDE_PLUGIN_ROOT}/scripts/`:

- `claude-oauth-env.sh` → `<repo>/scripts/claude-oauth-env.sh` (mkdir -p `scripts/` if needed; chmod +x after copy)

Also create `<repo>/.sandcastle/.gitignore` with the literal content:

```
.env
logs/
worktrees/
```

### 4. Update package.json

If `package.json` exists and is parseable JSON, add these scripts (do not overwrite existing scripts with the same key — error if the user did not pass `--force`):

```json
{
  "scripts": {
    "sandcastle:build": "bunx @ai-hero/sandcastle docker build-image --image-name sandcastle-max --dockerfile .sandcastle/Dockerfile",
    "sandcastle:run": "bunx tsx .sandcastle/main.mts"
  }
}
```

Notes:
- If the project uses `npm` instead of `bun`, swap `bunx` → `npx`.
- The image name `sandcastle-max` matches the `imageName` in the templated `main.mts`. If the user has a naming convention, ask before changing.

If `package.json` does not exist, **skip** this step and tell the user they will need to invoke Sandcastle directly: `bunx tsx .sandcastle/main.mts`.

### 5. Install Sandcastle as a dev dependency

Run (with the project's package manager — detect from lockfile):

- bun: `bun add -d @ai-hero/sandcastle tsx`
- npm: `npm install --save-dev @ai-hero/sandcastle tsx`
- pnpm: `pnpm add -D @ai-hero/sandcastle tsx`
- yarn: `yarn add -D @ai-hero/sandcastle tsx`

If `bun` is detected and reports a blocked postinstall (`@parcel/watcher`), tell the user to run `bun pm trust @parcel/watcher` only if they need filesystem-watch features (Sandcastle works without it for one-shot runs).

### 6. Update root .gitignore

Add (append, do not duplicate) these lines to `<repo>/.gitignore`:

```
.sandcastle/.env
.sandcastle/logs/
.sandcastle/worktrees/
```

If `.gitignore` does not exist, create it with these lines.

### 7. Print final checklist

Output a short, actionable checklist to the user:

```
Sandcastle scaffolded.

Next steps:
1. (one-time) claude setup-token   ← skip if Keychain entry already exists
2. source scripts/claude-oauth-env.sh
3. bun run sandcastle:build         ← takes 1-3 min first time (downloads node:22 + Bun + gh CLI + Claude Code)
4. bun run sandcastle:run           ← runs the smoke prompt in .sandcastle/prompt.md

To use it for real AFK execution:
- Edit .sandcastle/prompt.md with the agent brief.
- In .sandcastle/main.mts, change branchStrategy to { type: 'branch', branch: 'agent/issue-N' } so Sandcastle creates a dedicated branch for the agent's commits.
- Pass GH_TOKEN (e.g. via .sandcastle/.env) so the agent can `gh issue comment` and `gh pr create`.

Skill /sandcastle-afk has the full troubleshooting guide if anything hangs.
```

## Important notes

- **Never print or log the OAuth token.** The `claude-oauth-env.sh` script handles secrets — do not echo, cat, or otherwise display its output beyond what the script itself emits.
- **Do not commit `.sandcastle/.env`.** That file is for the OAuth token and GH PAT — both secrets. The `.gitignore` updates handle this; verify after running.
- **macOS-only Keychain helper.** On Linux/server, the user must paste the OAuth token directly into `.sandcastle/.env`. The script errors out cleanly on non-Darwin.
- **Image name `sandcastle-max`** matches the plugin's namespace — single image can be reused across repos that adopt this plugin. If the user wants per-repo images, change both the package.json script and the `imageName` in main.mts.

## Arguments

The user may pass these in their command:

- `--force` — overwrite existing `.sandcastle/`, scripts, or package.json entries. Default: error on collision.
- `--no-install` — skip step 5 (don't run package manager). Useful in dry-run scenarios.

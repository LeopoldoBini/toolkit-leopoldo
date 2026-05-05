---
name: sandcastle-afk
description: Reference for setting up @ai-hero/sandcastle to run AFK Claude Code agents in Docker using a Claude Max subscription via CLAUDE_CODE_OAUTH_TOKEN (instead of pay-per-token ANTHROPIC_API_KEY). Documents the three non-obvious gotchas that break the setup silently — interactive init wizard with no CLI override, UID mismatch between install user (agent UID 1000) and runtime user (host UID 501 on macOS), and Claude Code installer state files (.claude.json with mode 600) that hang `claude --print` silently. Use when the user asks "why does sandcastle hang", "claude --print doesn't return", "AgentIdleTimeoutError in sandcastle", "how do I use my Claude Max with sandcastle", or when troubleshooting any AFK execution that times out without output.
---

# Sandcastle AFK with Claude Max — setup and troubleshooting

This skill documents how to run @ai-hero/sandcastle with Claude Code authenticated via the user's Claude Max subscription (`CLAUDE_CODE_OAUTH_TOKEN`) instead of pay-per-token API access (`ANTHROPIC_API_KEY`). The default Sandcastle path requires API key — issue [#191](https://github.com/mattpocock/sandcastle/issues/191) requests subscription support and is marked **wontfix**. The workaround is real and documented here.

## Why this exists

If you have a Claude Max subscription (any tier — 5x, 20x, etc.) and want to run AFK agents (long-running issue execution, brief dispatch, parallel orchestration), Sandcastle's default config sends every agent invocation through pay-per-token API. For a single AFK brief that runs 30-60 minutes, that can cost $5-50. With this setup, the AFK agents consume from your subscription's 5h-window quota — same pool as your interactive Claude Code sessions, no additional billing.

The workaround relies on:

1. The `claudeCode()` provider in Sandcastle does **not** validate `ANTHROPIC_API_KEY` presence. It just builds the `claude --print` command and inherits whichever auth env exists at runtime.
2. Claude Code respects `CLAUDE_CODE_OAUTH_TOKEN` natively — it's a documented Anthropic env var, not a Sandcastle-specific thing.
3. Sandcastle propagates env vars from `.sandcastle/.env` (or from `claudeCode(model, { env: {...} })` in `main.mts`) into the container.

So we wire `CLAUDE_CODE_OAUTH_TOKEN` from the host (read from macOS Keychain) into the agent's env, and Claude Code inside the container authenticates with it. No fork of Sandcastle needed.

## Quick start

```bash
# In any repo:
/sandcastle-init                # generates .sandcastle/ + scripts + package.json wiring

# Then once:
claude setup-token              # populates macOS Keychain (skip if already done)

# Per session:
source scripts/claude-oauth-env.sh
bun run sandcastle:build        # 1-3 min first time
bun run sandcastle:run          # runs the smoke prompt
```

If the smoke run completes with `<promise>COMPLETE</promise>` in the output, the setup works. If it hangs with `Agent idle for N minutes` and times out at 600s, see Troubleshooting.

## The three gotchas

These are the non-obvious failure modes. Knowing them up front saves hours of debugging.

### Gotcha 1 — Sandcastle CLI init is interactive with no override

Running `npx @ai-hero/sandcastle init --template blank --agent claude-code` looks fully-flagged but still pops an interactive UI (Ink-based) asking to pick a sandbox provider (Docker/Podman). There is no `--sandbox docker` flag. From a non-TTY script, the process hangs forever waiting for input.

**Fix:** the `/sandcastle-init` slash command (this plugin) bypasses the CLI and writes the files directly from templates. The templates were extracted from `node_modules/@ai-hero/sandcastle/dist/templates/blank/` and `dist/InitService.js`.

**Where to grep if it changes:** `dist/InitService.js` — search for `TEMPLATES`, `AGENT_REGISTRY`, `CLAUDE_CODE_DOCKERFILE`, and `GITIGNORE` constants. The `.env.example` content per agent lives next to `AGENT_REGISTRY` entries. The interactive prompt for sandbox provider is wired in `dist/cli.js`.

### Gotcha 2 — UID mismatch between Dockerfile install and Sandcastle runtime

The Sandcastle docker provider starts the container with `--user $HOST_UID:$HOST_GID` (501:20 on macOS, 1000:1000 on most Linux) so that bind-mounted host files keep correct ownership. **But** the Dockerfile's `RUN curl … claude/install.sh | bash` runs as `USER agent` (UID 1000), so installer-created files in `/home/agent/` are owned by agent, not by the host UID.

When the container starts as UID 501 (macOS) and tools try to write `/home/agent/.gitconfig`, `~/.claude/...`, etc., they get **Permission denied**. Most failures cascade silently — `claude --print` exits with code 0 producing no output.

**Fix in the Dockerfile** (this plugin's template already does it):

```dockerfile
USER root
RUN chmod 1777 /home/agent \
  && find /home/agent -mindepth 1 -maxdepth 2 -type d -exec chmod 1777 {} +
USER agent
```

Sticky bit world-writable on `/home/agent` and direct subdirs. The host UID can now write what it needs at runtime. The `claude` binary symlink in `~/.local/bin` keeps working because it points to `~/.local/share/claude/versions/<v>` which is mode 755 from the installer.

**Where to grep if it changes:** `dist/sandboxes/docker.js` — look for `process.getuid` (the line that builds `--user $hostUid:$hostGid`) and `HOME: "/home/agent"` (hardcoded env override). If a future Sandcastle release lets you customize either, this gotcha may go away. The git command that fails first is in `dist/SandboxLifecycle.js` — search for `git config --global --add safe.directory`.

### Gotcha 3 — `~/.claude.json` from the installer hangs `claude --print` silently

Even after the chmod fix, the installer leaves a `/home/agent/.claude.json` config file with mode `-rw-------` (600, owner-only). When the container starts as UID 501, that file is unreadable. Claude Code reads it on startup, gets EACCES, and **hangs forever** in `--print` mode without surfacing an error. `--output-format stream-json` exits cleanly with no output (worse — looks like a successful empty run); `--output-format json` and plain text mode time out.

**Fix in the Dockerfile** (this plugin's template already does it):

```dockerfile
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && rm -rf /home/agent/.claude /home/agent/.claude.json /home/agent/.cache/claude
```

Wipe the installer's owner-only state files. Claude Code will recreate them at runtime as the host UID, with usable perms.

**Where to grep if it changes:** the install script lives at `https://claude.ai/install.sh` — fetch it (`curl -fsSL https://claude.ai/install.sh | less`) and search for any chmod/chown that creates `~/.claude` or `~/.claude.json`. If Anthropic later writes those files with mode 644 or 666, the wipe stops being necessary. The provider that runs `claude --print` (and silently inherits whatever it can or can't read from `$HOME`) is `dist/AgentProvider.js` — look for the `claudeCode(model, options)` factory and its `buildPrintCommand` method.

## Troubleshooting

### `AgentIdleTimeoutError: Agent idle for 600 seconds`

Sandcastle saw the container start, sent the prompt to `claude --print`, and got nothing back for 10 minutes. Almost always one of the three gotchas above (typically gotcha 3). To diagnose:

```bash
# Manual repro — run claude --print inside the container with the same env:
source scripts/claude-oauth-env.sh
docker run --rm --user 501:20 \
  -e HOME=/home/agent \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  --entrypoint bash sandcastle-max:latest \
  -c 'echo "say only: pong" | timeout 30 claude --print --dangerously-skip-permissions --output-format json -p - 2>&1; echo "EXIT=$?"'
```

- If you get a JSON response with `"result":"pong"` → `claude` works in the container; the issue is Sandcastle wiring (check `main.mts` env propagation).
- If you get exit 124 (timeout) → claude is hanging on something. Check `.claude.json` perms inside the image: `docker run --rm --user 501:20 --entrypoint bash sandcastle-max:latest -c 'cat /home/agent/.claude.json'`. If "Permission denied" → gotcha 3, rebuild image.
- If you get exit 0 with no output → same as above, gotcha 3.

### Token leaked accidentally during debug

The `claude-oauth-env.sh` script never prints the token, but ad-hoc `env | grep CLAUDE` or similar can. **If a token is exposed in logs/conversation:** `claude setup-token` again — it overwrites the Keychain entry. The old access token remains technically valid until its `expiresAt`, so refresh sooner rather than later.

When debugging in shell, never inspect env vars containing tokens — use existence checks only:
```bash
[[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]] && echo "PRESENTE" || echo "AUSENTE"
```

### `claude doctor` times out

Same root cause as gotcha 3 — Claude Code can't read its config and hangs. Fix the Dockerfile and rebuild.

### Container starts as wrong user

Sandcastle hardcodes `--user $HOST_UID:$HOST_GID`. On macOS your UID is typically 501, GID 20 (staff). Inside the container that becomes UID 501 with no matching `/etc/passwd` entry, so `whoami` fails and `id` shows just the numeric UID. That's expected and harmless — the chmod 1777 setup makes it work without needing to register the UID in the image.

## OAuth vs API key — when to use which

| Path | When | Cost model | Setup |
|------|------|-----------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` (this plugin) | Personal projects, learning, AFK runs you can pace within Max 5h windows | Subscription quota — no per-token billing | `claude setup-token` once + this plugin |
| `ANTHROPIC_API_KEY` (Sandcastle default) | Production CI/CD, parallel runs that exceed Max windows, cost-tracked workloads | Pay per token (Sonnet 4.6 ~$3/MTok input, $15/MTok output) | Get key from console.anthropic.com, paste in `.sandcastle/.env` |

You can mix: keep this plugin for local dev/personal AFK, swap to API key on the server for the heavier runs.

## Sandcastle internals — where to grep when it breaks

This plugin was built by reading `@ai-hero/sandcastle@0.5.7` source. If a later release changes behavior, the symbols below are the stable anchors to grep for. All paths are inside `node_modules/@ai-hero/sandcastle/dist/` after `bun add -d @ai-hero/sandcastle`.

| File | Grep for | Why |
|------|----------|-----|
| `AgentProvider.js` | `claudeCode = (model, options)` | Provider factory. Confirms it does **not** validate `ANTHROPIC_API_KEY`. Its `buildPrintCommand` builds the `claude --print --verbose --output-format stream-json` invocation. |
| `AgentProvider.js` | `AGENT_REGISTRY` | List of supported agents (claude-code, pi, codex, opencode) and their `envExample` strings. The Claude Code entry's `envExample` is what links to issue #191 — confirms maintainer's stance. |
| `sandboxes/docker.js` | `process.getuid` | The hardcoded `--user $hostUid:$hostGid` flag — root cause of gotcha 2. |
| `sandboxes/docker.js` | `HOME: "/home/agent"` | Hardcoded HOME env override in `startContainer` call — you can't change HOME from `main.mts`. |
| `sandboxes/docker.js` | `worktreePath` | How bind-mounts are resolved — anchor for debugging if mount paths shift. |
| `SandboxLifecycle.js` | `git config --global --add safe.directory` | First command that runs after container start. If gotcha 2 isn't fixed, this is the line that fails with "could not lock config file". |
| `SandboxLifecycle.js` | `GIT_SETUP_TIMEOUT_MS` | Default 10s — explains why the manual repro times out at 30s but Sandcastle errors faster than the agent idle timeout. |
| `Orchestrator.js` | `dangerouslySkipPermissions: true` | Hardcoded — every print run skips permission prompts. If this flips to false, `claude --print` will hang waiting for permission grants that no TTY can provide. |
| `Orchestrator.js` | `idleTimeout` / `AgentIdleTimeoutError` | The 600s default. Adjustable via run options. The error message you see when gotcha 3 strikes. |
| `InitService.js` | `CLAUDE_CODE_DOCKERFILE` | Reference Dockerfile string — diff against the plugin's template to see what we added (chmod + cleanup). |
| `InitService.js` | `GITHUB_CLI_TOOLS`, `BEADS_TOOLS` | `{{BACKLOG_MANAGER_TOOLS}}` substitutions — useful if you want to integrate Beads instead of GitHub for the backlog. |
| `InitService.js` | `GITIGNORE`, `envExampleParts` | Reference content for the files `npx sandcastle init` would generate, in case you want to add support for a new template. |
| `templates/blank/main.mts` | (whole file) | Origin of our `main.mts` — diff to see the OAuth env wiring we added. |
| `run.js` / `index.d.ts` | `RunOptions`, `BranchStrategy` | Public API surface. `branchStrategy` accepts `{ type: 'head' | 'merge-to-head' | 'branch', branch?: string }`. |

**One-shot to find any of these in your installed version:**

```bash
find node_modules/@ai-hero/sandcastle/dist -name '*.js' \
  -exec grep -l "<symbol-from-table>" {} +
```

**Version drift check** before debugging anything else:

```bash
cat node_modules/@ai-hero/sandcastle/package.json | grep version
```

If it's no longer 0.5.x, expect some of the above to have moved. The symbols are stable enough to grep across minor versions.

## Architecture summary

```
┌─────────────── Host (macOS or Linux) ───────────────┐
│                                                     │
│  Keychain ── claude-oauth-env.sh ──► env CLAUDE_CODE_OAUTH_TOKEN
│                                          │          │
│                              source'd in shell      │
│                                          │          │
│  bun run sandcastle:run                  ▼          │
│       │                                             │
│       └─► npx tsx .sandcastle/main.mts              │
│                  │                                  │
│                  ▼                                  │
│             sandcastle.run({                        │
│               agent: claudeCode(model, {            │
│                 env: { CLAUDE_CODE_OAUTH_TOKEN }    │
│               }),                                   │
│               sandbox: docker(),                    │
│               promptFile: ".sandcastle/prompt.md",  │
│             })                                      │
│                  │                                  │
│                  ▼                                  │
│         spawn Docker container                      │
│         --user 501:20                               │
│         -e HOME=/home/agent                         │
│         -e CLAUDE_CODE_OAUTH_TOKEN=...              │
│         -v <repo>:/home/agent/workspace             │
│                  │                                  │
└──────────────────┼──────────────────────────────────┘
                   ▼
        ┌─── Container ─────────┐
        │  /home/agent (1777)   │
        │  /home/agent/.local/  │
        │    bin/claude → ...   │
        │                       │
        │  claude --print -p -  │
        │    │  (auth via OAuth)│
        │    ▼                  │
        │  Anthropic API        │
        │    │                  │
        │    ▼                  │
        │  stream-json output   │
        │    │                  │
        └────┼──────────────────┘
             ▼
     Sandcastle parses lines,
     emits to .sandcastle/logs/main.log,
     captures session, collects commits,
     opens PR (if branchStrategy = 'branch')
```

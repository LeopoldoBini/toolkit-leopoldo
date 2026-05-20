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

## Quick start (v2 — stack-aware scaffold)

```bash
# In any repo (detects stack automatically, composes per-project Dockerfile):
/sandcastle-init                # writes .sandcastle/ (Dockerfile, config.json, prompt.md, .env.example)

# Then once per machine:
claude setup-token              # populates macOS Keychain (skip if already done)

# Per repo:
/sandcastle-build               # build the per-project image (2-5 min first time)
/sandcastle-run                 # run the smoke prompt
```

If the smoke run completes with `<promise>COMPLETE</promise>`, the setup works. If it hangs with `Agent idle for N minutes` and times out at 600s, see Troubleshooting.

**v2 vs v1 differences (hard cutoff, no migration):**

- Orchestrator (`main.mts` + `@ai-hero/sandcastle` + `tsx`) lives in the plugin (`${CLAUDE_PLUGIN_ROOT}/runtime/`), not in your repo. No `package.json` contamination — pure .NET / Python / Go repos work natively.
- Dockerfile is **composed from snippets** in `${CLAUDE_PLUGIN_ROOT}/templates/snippets/` based on runtime detection (`.csproj`, `package.json`, `pyproject.toml`, `bun.lockb`, `go.mod`, etc.) — fat polyglot image when needed.
- Per-project image name: `sandcastle-<repo-basename>`. Each repo has its own.
- Secrets extracted on-demand by `/sandcastle-build` / `/sandcastle-run` (Keychain on macOS, `gh auth token`) with `.sandcastle/.env` as Linux/override fallback. No `scripts/claude-oauth-env.sh` in the repo.
- v1 repos must be migrated manually: remove `.sandcastle/main.mts`, `scripts/claude-oauth-env.sh`, `sandcastle:build`/`sandcastle:run` from `package.json`, and `@ai-hero/sandcastle` + `tsx` from devDeps. Then re-run `/sandcastle-init --force`.

## Two operating modes

`main.mts` (this plugin's template) reads env vars to decide between two modes:

### Mode 1: smoke / dev (no env overrides)

```bash
/sandcastle-run
```

- `branchStrategy: { type: 'head' }` — read-only run, no commits.
- `promptFile: .sandcastle/prompt.md` — the smoke template.
- The slash command extracts `CLAUDE_CODE_OAUTH_TOKEN` from the Keychain (macOS) or `.sandcastle/.env` (Linux/override) before invoking the orchestrator.
- Use this to validate auth + Docker pipeline. **Always run smoke after `/sandcastle-build` to catch broken state early.**

### Mode 2: AFK dispatch (driven by `/sandcastle-dispatch-wave`)

```
/sandcastle-dispatch-wave
```

The dispatcher sets these env vars per launch:

```
SANDCASTLE_ISSUE_NUMBER=2
SANDCASTLE_BRANCH=agent/issue-2
SANDCASTLE_PROMPT_FILE=./.sandcastle/prompts/issue-2.md
```

`main.mts` detects them and switches to:
- `branchStrategy: { type: 'branch', branch: 'agent/issue-N' }` — Sandcastle creates a dedicated branch from `main`, the agent commits to it, `gh pr create` opens a PR against `main`.
- `promptFile` = the per-issue prompt with the brief inlined.

**Why env vars and not file-rewrite:** the dispatcher running multiple containers in parallel can't safely mutate a shared `main.mts` per launch. Env vars per subshell isolate the dispatch parameters cleanly. See the `/sandcastle-dispatch-wave` command for the full env-var schema.

## Docker capabilities (Netbird, NET_ADMIN, post-create hook)

By default, Sandcastle containers run with the standard Docker capability set — no `NET_ADMIN`, no `/dev/net/tun`, no post-create hook. For most projects that's fine. But some setups need more:

- **VPN-only resources.** The AFK agent needs to reach a database, queue, or API that's only routable from inside a private network (e.g. a stand-by SQL Server on a Netbird/Tailscale/WireGuard mesh). Without VPN access, queries are written blind against an imagined schema and the agent commits broken code.
- **Linux capabilities** beyond defaults (rare but real — e.g. `SYS_PTRACE` for in-container debugging tools).
- **Init scripts** that need to run as root before the agent starts (typical: bring up a VPN peer, mount a private CA, register with a service mesh).

The plugin ships with a bundled patch to `@ai-hero/sandcastle@0.5.10` (lives in `${CLAUDE_PLUGIN_ROOT}/runtime/patches/`, applied via `bun.patchedDependencies` on first install). The patch exposes three declarative knobs in `.sandcastle/config.json`:

```json
{
  "imageName": "sandcastle-<repo>",
  "runtimes": ["dotnet"],
  "promptFile": ".sandcastle/prompt.md",
  "dockerfile": ".sandcastle/Dockerfile",
  "model": "claude-opus-4-7",
  "docker": {
    "capAdd": ["NET_ADMIN"],
    "devices": ["/dev/net/tun"],
    "postCreateHook": "/usr/local/bin/netbird-up.sh"
  }
}
```

Mapping:

| `config.docker` field | Becomes `docker run` flag | Plugin env var (internal) |
|------------------------|---------------------------|---------------------------|
| `capAdd: ["NET_ADMIN", …]` | `--cap-add NET_ADMIN …` | `SANDCASTLE_EXTRA_CAPS=NET_ADMIN,…` |
| `devices: ["/dev/net/tun", …]` | `--device /dev/net/tun …` | `SANDCASTLE_EXTRA_DEVICES=/dev/net/tun,…` |
| `postCreateHook: "/path"` | `docker exec --user root … sh -c "$path"` after create | `SANDCASTLE_POST_CREATE_HOOK=/path` |

The plugin's `main.mts` translates the `docker` block to the `SANDCASTLE_*` env vars before calling `sandcastle.run(...)`. You don't need to set these env vars manually — the config block is the API.

### Putting it together: Netbird-in-container

If your AFK agents need to reach a VPN-only resource:

1. **Install Netbird in your image.** Drop a snippet at `.sandcastle/snippets/extras.dockerfile`:
   ```dockerfile
   # extras.dockerfile — auto-included by /sandcastle-init
   USER root
   RUN curl -fsSL https://pkgs.netbird.io/install.sh | sh
   COPY netbird-up.sh /usr/local/bin/netbird-up.sh
   RUN chmod +x /usr/local/bin/netbird-up.sh
   ```
   The `netbird-up.sh` script lives in `.sandcastle/netbird-up.sh` next to the Dockerfile and gets `COPY`-ed in. Its job: read `$NB_SETUP_KEY` from env, run `netbird up`, wait for `Management: Connected`.
2. **Declare the setup key as a resource env.** In `.sandcastle/resources.json`:
   ```json
   {
     "resources": [
       {
         "name": "netbird-peer",
         "type": "vpn",
         "env_required": ["NB_SETUP_KEY"],
         "connectivity_probe": "netbird status 2>/dev/null | grep -q 'Management: Connected'",
         "policy": "mandatory"
       }
     ]
   }
   ```
   `main.mts` propagates `NB_SETUP_KEY` from host env to the container's `agentEnv`.
3. **Wire the capabilities** in `.sandcastle/config.json`:
   ```json
   {
     "docker": {
       "capAdd": ["NET_ADMIN"],
       "devices": ["/dev/net/tun"],
       "postCreateHook": "/usr/local/bin/netbird-up.sh"
     }
   }
   ```
4. **Build + run.** `/sandcastle-build` bakes Netbird into the image; `/sandcastle-run` launches the container with the right `--cap-add` / `--device` flags, executes `netbird-up.sh` as root post-create, then hands off to the agent. The agent's `claude --print` loop now has VPN routes loaded — Dapper queries against the stand-by DB resolve to real columns.

### When NOT to use this

- **Pure local CRUD / no private resources.** Standard container is fine. Don't add `NET_ADMIN` for fun — it widens the kernel surface the agent can interact with.
- **Resources that have a public ingress.** If your DB has a tunneled public endpoint with auth, prefer that to a VPN peer per container — simpler, no kernel caps needed.
- **CI/CD runners that already have VPN at the host level.** Use `--network host` (custom Dockerfile) or route from the host instead of enrolling each container as its own peer.

### Where to grep if the patch breaks

The patch lives at `${CLAUDE_PLUGIN_ROOT}/runtime/patches/@ai-hero%2Fsandcastle@0.5.10.patch`. It modifies two files in `node_modules/@ai-hero/sandcastle/dist/`:

- `DockerLifecycle.js` — adds `SANDCASTLE_EXTRA_CAPS` and `SANDCASTLE_EXTRA_DEVICES` parsing in `startContainer`.
- `sandboxes/docker.js` — adds the `SANDCASTLE_POST_CREATE_HOOK` block right after container create.

Verify the patch applied:
```bash
grep -c "SANDCASTLE_EXTRA_CAPS" \
  ${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/@ai-hero/sandcastle/dist/DockerLifecycle.js
# expect: >= 1
```

If upstream `@ai-hero/sandcastle` ships native support for `cap_add`/`devices`/post-create hooks in a future release, drop the patch and migrate to the upstream API — the plugin will follow.

## How this plugin chains with engineering-workflow

This plugin is the **execution layer**. The **brief authoring layer** is the `engineering-workflow` plugin (>=2.1.0), which lives in the same `toolkit-leopoldo` marketplace. The chain:

```
PRD               → /to-prd       (engineering-workflow)
Issues            → /to-issues    (engineering-workflow)
Briefs            → /triage + /agent-brief
                    Single-brief invariant: edit, don't duplicate.
                    Last `## Agent Brief` comment is the contract.
                    (engineering-workflow >=2.1.0)
AFK execution     → /sandcastle-dispatch-wave
                    Reads the latest brief comment per issue,
                    inlines into per-issue prompt.md,
                    launches one Docker container per eligible issue.
                    (this plugin)
PR review         → CI workflows (.github/workflows/afk-automerge.yml)
                    Auto-merge VS* on green, hold F* for human review.
                    (project-local — not a plugin)
```

The dispatcher **depends on the single-brief invariant**. If the project uses an older `engineering-workflow` (<2.1.0), `/triage` may have created multiple `## Agent Brief` comments per issue, and the dispatcher's "last wins" rule can be inconsistent.

**Verification:** the dispatcher's pre-flight prints a warning if it finds >1 brief on any issue in the launch set, and refuses to launch unless `--force` is passed. The remediation is to consolidate manually (delete older comments) and the dispatcher will work correctly on the next invocation.

## The three gotchas

These are the non-obvious failure modes. Knowing them up front saves hours of debugging.

### Gotcha 1 — Sandcastle CLI init is interactive with no override

Running `npx @ai-hero/sandcastle init --template blank --agent claude-code` looks fully-flagged but still pops an interactive UI (Ink-based) asking to pick a sandbox provider (Docker/Podman). There is no `--sandbox docker` flag. From a non-TTY script, the process hangs forever waiting for input.

**Fix:** the `/sandcastle-init` slash command (this plugin) bypasses the CLI and writes the files directly from snippets. In v2 the snippets live in `${CLAUDE_PLUGIN_ROOT}/templates/snippets/` and are composed per-project by the detector; the base + agent snippets were derived from `node_modules/@ai-hero/sandcastle/dist/templates/blank/` and `dist/InitService.js`.

**Where to grep if it changes:** `dist/InitService.js` — search for `TEMPLATES`, `AGENT_REGISTRY`, `CLAUDE_CODE_DOCKERFILE`, and `GITIGNORE` constants. The `.env.example` content per agent lives next to `AGENT_REGISTRY` entries. The interactive prompt for sandbox provider is wired in `dist/cli.js`.

### Gotcha 2 — UID mismatch between Dockerfile install and Sandcastle runtime

The Sandcastle docker provider starts the container with `--user $HOST_UID:$HOST_GID` (501:20 on macOS, 1000:1000 on most Linux) so that bind-mounted host files keep correct ownership. **But** the Dockerfile's `RUN curl … claude/install.sh | bash` runs as `USER agent` (UID 1000), so installer-created files in `/home/agent/` are owned by agent, not by the host UID.

When the container starts as UID 501 (macOS) and tools try to write `/home/agent/.gitconfig`, `~/.claude/...`, etc., they get **Permission denied**. Most failures cascade silently — `claude --print` exits with code 0 producing no output.

**Fix in the snippet** (the plugin's `templates/snippets/agent.dockerfile` already does it — this is the LAST snippet in every composed Dockerfile, regardless of which runtimes were detected):

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

**Fix in the snippet** (the plugin's `templates/snippets/agent.dockerfile` already does it):

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
# Manual repro — run claude --print inside the container with the same env.
# v2: image name is per-project; read from .sandcastle/config.json.
# Keychain stores Claude Code creds as JSON {"claudeAiOauth":{"accessToken":...}};
# extract the raw access token with jq (the container expects the raw value).
IMG=$(jq -r '.imageName' .sandcastle/config.json)
RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [[ "${RAW:0:1}" == "{" ]]; then
  TOKEN=$(printf '%s' "$RAW" | jq -r '.claudeAiOauth.accessToken')
else
  TOKEN="$RAW"
fi
docker run --rm --user 501:20 \
  -e HOME=/home/agent \
  -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
  --entrypoint bash "$IMG" \
  -c 'echo "say only: pong" | timeout 30 claude --print --dangerously-skip-permissions --output-format json -p - 2>&1; echo "EXIT=$?"'
```

- If you get a JSON response with `"result":"pong"` → `claude` works in the container; the issue is Sandcastle wiring (check the plugin runtime's `main.mts` env propagation).
- If you get exit 124 (timeout) → claude is hanging on something. Check `.claude.json` perms inside the image: `docker run --rm --user 501:20 --entrypoint bash "$IMG" -c 'cat /home/agent/.claude.json'`. If "Permission denied" → gotcha 3, rebuild image with `/sandcastle-build --no-cache`.
- If you get exit 0 with no output → same as above, gotcha 3.

### Token leaked accidentally during debug

The v2 slash commands never print the token, but ad-hoc `env | grep CLAUDE` or similar can. **If a token is exposed in logs/conversation:** `claude setup-token` again — it overwrites the Keychain entry. The old access token remains technically valid until its `expiresAt`, so refresh sooner rather than later.

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
┌─────────────── Host (macOS or Linux) ─────────────────────────────┐
│                                                                   │
│  Keychain  ─── /sandcastle-run extracts on-demand ────┐           │
│                                                       ▼           │
│                                              CLAUDE_CODE_OAUTH_TOKEN
│                                                       │           │
│  /sandcastle-run                                      ▼           │
│       │                                                           │
│       └─► node ${CLAUDE_PLUGIN_ROOT}/runtime/main.mts             │
│                  │   (cwd = user's repo;                          │
│                  │    reads .sandcastle/config.json)              │
│                  ▼                                                │
│             sandcastle.run({                                      │
│               agent: claudeCode(model, {                          │
│                 env: { CLAUDE_CODE_OAUTH_TOKEN }                  │
│               }),                                                 │
│               sandbox: docker({                                   │
│                 imageName: config.imageName  ← per-project        │
│               }),                                                 │
│               promptFile: config.promptFile,                      │
│             })                                                    │
│                  │                                                │
│                  ▼                                                │
│         spawn Docker container                                    │
│         --user 501:20                                             │
│         -e HOME=/home/agent                                       │
│         -e CLAUDE_CODE_OAUTH_TOKEN=...                            │
│         -v <repo>:/home/agent/workspace                           │
│                  │                                                │
└──────────────────┼────────────────────────────────────────────────┘
                   ▼
        ┌─── Container (sandcastle-<repo>) ────────────┐
        │  /home/agent (1777)                          │
        │  /home/agent/.local/bin/claude → installer   │
        │                                              │
        │  + runtimes detected per project:            │
        │    .NET SDK, Node, Bun, Python, Go, ...      │
        │                                              │
        │  claude --print -p -                         │
        │    │  (auth via OAuth)                       │
        │    ▼                                         │
        │  Anthropic API                               │
        │    │                                         │
        │    ▼                                         │
        │  stream-json output                          │
        └──────────────────────────────────────────────┘
             │
             ▼
     Sandcastle parses lines,
     emits to .sandcastle/logs/main.log,
     captures session, collects commits,
     opens PR (if branchStrategy = 'branch')
```

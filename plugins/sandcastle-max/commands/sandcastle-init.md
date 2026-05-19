---
name: sandcastle-init
description: Scaffold .sandcastle/ in the current repo so AFK Claude Code agents can run in Docker using the user's Claude Max subscription (CLAUDE_CODE_OAUTH_TOKEN). Detects the project's stack(s) from manifests/lockfiles and composes a Dockerfile from the plugin's snippet registry (Node, Bun, Python, .NET, Go, Ruby, Rust, etc.). Per-project image, no package.json contamination, no scripts/ in the repo. Idempotent — refuses to overwrite existing files unless --force is given. Triggers when the user says "init sandcastle", "set up sandcastle in this repo", "armar sandcastle local", "configurar AFK runner".
---

# /sandcastle-init

You are scaffolding a stack-aware Sandcastle setup in the current repository. The user wants an AFK Claude Code agent runner whose Docker image matches the project's actual runtimes (.NET / Node / Bun / Python / Go / Ruby / Rust / etc.), authenticated with their Claude Max subscription via `CLAUDE_CODE_OAUTH_TOKEN`.

**Architecture (read this first):**

- The orchestrator (`@ai-hero/sandcastle` + `tsx` + `main.mts`) lives in the plugin at `${CLAUDE_PLUGIN_ROOT}/runtime/`. **You will NOT add any JS dependency to the user's `package.json`.** Repos that are pure .NET / Python / Go must work without a `package.json`.
- The user's repo gets a `.sandcastle/` directory only. No `scripts/` directory. No edits to `package.json`.
- The Dockerfile is **generated** by concatenating snippets from `${CLAUDE_PLUGIN_ROOT}/templates/snippets/` based on which runtimes were detected. The user can override per-project by dropping snippets into `<repo>/.sandcastle/snippets/`.
- The image name is per-project: `sandcastle-<basename-of-repo>`. No sharing across repos.
- Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`) are extracted from the host at invocation time by the slash commands (Keychain on macOS, `gh auth token`), with `.sandcastle/.env` as a fallback for Linux/override use.

## Steps to execute

### 1. Pre-conditions (run in parallel)

- `git rev-parse --show-toplevel` — find repo root. If not a git repo, warn and ask the user to confirm before proceeding.
- `docker --version` and `docker info --format '{{.ServerVersion}}'` — confirm Docker daemon is running.
- `which claude && claude --version` — confirm Claude Code CLI is installed locally.
- `command -v bun || command -v node` — confirm a JS runtime exists on the host (needed only because the orchestrator runs as `node ${CLAUDE_PLUGIN_ROOT}/runtime/main.mts`; the user's repo does NOT need one).
- `security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | head -c 0; echo "keychain_present=$?"` — note whether `claude setup-token` has been run (informational; not fatal — Linux users will use `.sandcastle/.env`).

If any hard pre-condition fails (no git, no docker daemon, no claude CLI, no JS runtime on host), **stop** and tell the user what to fix.

### 2. Detect collisions

Check whether any of these already exist in the repo:

- `.sandcastle/` directory (any contents)
- `.sandcastle/config.json`
- `.sandcastle/Dockerfile`

If a collision is detected and the user did not pass `--force`, **stop** and ask the user whether to overwrite or keep current.

Also detect an **old scaffold** (signal: presence of `.sandcastle/main.mts` OR `scripts/claude-oauth-env.sh` OR a `sandcastle:build` / `sandcastle:run` script in `package.json`). If present, tell the user this repo is on the v1 scaffold and the v2 redesign requires a hard cutoff — they must manually remove the old files (`.sandcastle/main.mts`, `scripts/claude-oauth-env.sh`, `sandcastle:*` scripts and devDeps `@ai-hero/sandcastle` + `tsx` from `package.json`) before re-running with `--force`. List the exact files to remove. Do not auto-migrate.

### 3. Bootstrap plugin runtime (one-time per machine)

Check whether `${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/` exists.

If not, run:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/runtime" && (bun install || npm install)
```

This installs `@ai-hero/sandcastle` + `tsx` inside the plugin (95MB, one-time). The user's repo never sees these deps.

### 4. Detect runtimes (root + 1 level)

For each snippet in `${CLAUDE_PLUGIN_ROOT}/templates/snippets/*.dockerfile`:

- Parse the header comment block for `# name:`, `# role:`, `# default-version:`, `# detect:` (comma-separated glob patterns).
- Skip snippets with `role: base` or `role: agent` (those are always included regardless of detection).
- For each `detect:` pattern, run:
  ```bash
  find . -maxdepth 2 \( -path ./node_modules -o -path ./.git -o -path ./bin -o -path ./obj \) -prune -o -name "<pattern>" -print | head -1
  ```
- If any pattern matches, mark the runtime as detected.

Build a list `detected = ["dotnet", "node", ...]`.

If `detected` is empty, ask the user: "No runtimes detected from manifests/lockfiles in root + 1 level. Specify the primary runtime manually (e.g. `dotnet`, `node`, `python`) or pass `--runtime <name>` and re-run."

### 5. Detect versions (best-effort)

For each detected runtime, try to read a version from project files. Do **not** be exhaustive — best-effort only, fail open to the snippet's `default-version`.

- **dotnet**: grep `<TargetFramework>` from the first `*.csproj` found (e.g. `net8.0` → `8.0`). If multi-target, take the highest.
- **node**: read `.nvmrc` if present; else `engines.node` from `package.json`.
- **python**: read `.python-version` if present; else `requires-python` from `pyproject.toml`.
- **go**: read `go` line from `go.mod`.
- **bun**, **ruby**, **rust**: skip version detection (defaults are fine).

For each detected version that **differs** from the snippet's `default-version`, ask the user: "Detected `dotnet 9.0` in `foo.csproj` but snippet pins `8.0` — override to `9.0`? [y/n]". Collect confirmed overrides into `versionOverrides = { dotnet: "9.0", ... }`.

### 6. Handle unknown stacks (generator fallback)

If you detected a manifest signature that suggests a known stack but no plugin snippet matches (e.g. `mix.exs` → Elixir, `Package.swift` → Swift), or if the user passes `--runtime <name>` with an unknown name:

For each unknown stack `<name>`:

1. Fetch the official install docs via WebFetch. Heuristic URL to try:
   - elixir → `https://elixir-lang.org/install.html`
   - swift → `https://www.swift.org/install/linux/`
   - dart → `https://dart.dev/get-dart`
   - generic → search "install <name> on Debian"
2. Spawn an Agent (subagent_type: `general-purpose`) with prompt:
   > Write a sandcastle-snippet Dockerfile fragment to install <name> {{VERSION}} on `debian:bookworm-slim` (already FROM-ed by a previous snippet). Output must:
   > - Start with the header block: `# sandcastle-snippet`, `# name: <name>`, `# role: runtime`, `# default-version: <X>`, `# detect: <patterns>`.
   > - Start the install with `USER root`.
   > - Use `apt-get install -y` only if the package is on Debian bookworm; otherwise use the official install script from the docs (which I attached below).
   > - Append any required `ENV PATH=$PATH:<bindir>` lines.
   > - Do NOT switch back to a non-root USER at the end — the agent.dockerfile snippet (appended later) handles user setup.
   > - Do NOT include FROM, ENTRYPOINT, or WORKDIR.
   >
   > Reference docs: <WebFetch content>
3. Write the generated snippet to `<repo>/.sandcastle/snippets/<name>.dockerfile` (project-local registry; ranks above plugin snippets at composition time).
4. **Pause** and print: "Generated snippet `<repo>/.sandcastle/snippets/<name>.dockerfile` for <name>. Review the install commands, then re-run `/sandcastle-build` to build the image."

The generated snippet stays in the user's repo. If they want to promote it to the plugin's global registry, they submit a PR to the marketplace explicitly.

### 7. Compose the final Dockerfile

Assemble `<repo>/.sandcastle/Dockerfile` by concatenating, in this exact order:

1. `${CLAUDE_PLUGIN_ROOT}/templates/snippets/base.dockerfile`
2. For each runtime in `detected`, in detection order:
   - First check if `<repo>/.sandcastle/snippets/<name>.dockerfile` exists (project-local override) → use that.
   - Else use `${CLAUDE_PLUGIN_ROOT}/templates/snippets/<name>.dockerfile`.
   - Substitute `{{VERSION}}` with `versionOverrides[name]` if set, else the snippet's `default-version`.
3. If `<repo>/.sandcastle/snippets/extras.dockerfile` exists, append it (escape hatch for per-project ad-hoc additions).
4. `${CLAUDE_PLUGIN_ROOT}/templates/snippets/agent.dockerfile` (always last).

Strip the `# sandcastle-snippet` header comment blocks from each segment before concatenating (they're metadata, not Dockerfile content).

Add a generated-file header to the top:

```
# Generated by /sandcastle-init. DO NOT EDIT manually.
# Customize via .sandcastle/config.json (versions, runtimes) or by adding
# .sandcastle/snippets/<name>.dockerfile overrides. Regenerated on each
# /sandcastle-init run.
```

### 8. Write .sandcastle/config.json

```json
{
  "imageName": "sandcastle-<basename-of-repo>",
  "runtimes": [...detected],
  "versions": {...versionOverrides},
  "promptFile": ".sandcastle/prompt.md",
  "dockerfile": ".sandcastle/Dockerfile",
  "model": "claude-opus-4-7"
}
```

Use the lowercased basename of `git rev-parse --show-toplevel` for `imageName`, replacing any non-alphanumeric characters with `-`.

Omit `versions` field entirely if `versionOverrides` is empty.

### 9. Copy template files

From `${CLAUDE_PLUGIN_ROOT}/templates/` into the repo:

- `prompt.md` → `<repo>/.sandcastle/prompt.md` (skip if exists and not `--force`)
- `env.example` → `<repo>/.sandcastle/.env.example` (already v2-correct — no patching needed)
- `resources.json.example` → `<repo>/.sandcastle/resources.json.example` (always copied verbatim; reference for what schema is supported)

If `<repo>/.sandcastle/resources.json` does not exist, also copy `resources.json.example` → `<repo>/.sandcastle/resources.json` so the user has a working starting point. Print: "Copied default resources.json — edit it to declare the DBs, APIs, queues, etc. that AFK agents must verify reachable before implementing. Set `policy: mandatory` on resources where the agent must NOT mock."

If `<repo>/.sandcastle/resources.json` already exists, skip it (idempotency) unless `--force`.

Create `<repo>/.sandcastle/.gitignore` with:

```
.env
logs/
worktrees/
prompts/
wave-reports/
```

### 10. Update root .gitignore

Append (do not duplicate) to `<repo>/.gitignore`:

```
.sandcastle/.env
.sandcastle/logs/
.sandcastle/prompts/
.sandcastle/wave-reports/
.sandcastle/worktrees/
```

If `.gitignore` does not exist, create it with those lines.

### 11. Final checklist

Print:

```
Sandcastle scaffolded for: <basename> (runtimes: <list>)

Next steps:
1. (one-time) claude setup-token        ← skip if Keychain entry already exists (macOS) or
                                           set CLAUDE_CODE_OAUTH_TOKEN in .sandcastle/.env
2. Edit .sandcastle/resources.json      ← declare the external resources (DB/HTTP/queue/etc)
                                           your AFK agents must verify before implementing.
                                           Set policy=mandatory for resources that must NOT
                                           be mocked. The example is a starting point.
3. Add env vars to .sandcastle/.env     ← put the env_required vars from resources.json here
                                           (DATABASE_URL, AUTH_API_TOKEN, etc).
4. /sandcastle-probe-resources          ← bootstraps .sandcastle/probes/<name>.schema cache so
                                           /to-issues and /agent-brief can anchor briefs to
                                           real column names, endpoints, topics. Re-run after
                                           schema migrations.
5. /sandcastle-build                    ← builds the per-project image
                                           (takes 2-5 min first time; cached after)
6. /sandcastle-run                      ← runs the smoke prompt in .sandcastle/prompt.md
                                           should print <promise>COMPLETE</promise>

For real AFK execution (after smoke passes):
- /sandcastle-dispatch-wave             ← detects ready issues, launches parallel agents
- /sandcastle-merge-wave                ← reviews + merges the resulting PRs
- /sandcastle-pipeline                  ← loops dispatch → validate → merge until done

Customization:
- Edit .sandcastle/config.json to change model, override versions, etc.
- Edit .sandcastle/resources.json to declare external resources AFK agents must verify
  (databases, APIs, queues). mandatory resources cannot be mocked and abort dispatch on
  probe failure. See .sandcastle/resources.json.example for the full schema.
- If you need extra Docker capabilities (NET_ADMIN), devices (/dev/net/tun), or a
  post-create hook (Netbird bring-up, custom CA mount), add a `docker` block to
  .sandcastle/config.json with capAdd/devices/postCreateHook arrays/strings. Details
  in the skill `sandcastle-afk`.
- Drop a snippet at .sandcastle/snippets/extras.dockerfile for ad-hoc additions
  (auto-included on next /sandcastle-init).
- Override a built-in snippet by creating .sandcastle/snippets/<name>.dockerfile.

Troubleshooting: skill `sandcastle-afk` has the full guide.
```

## Important notes

- **Never print or log secrets.** Tokens stay in env vars / Keychain / `.env`. Never echo them.
- **Do not commit `.sandcastle/.env`.** The `.gitignore` updates handle this; verify after running.
- **macOS-only Keychain helper.** On Linux/server, the user must paste tokens into `.sandcastle/.env`.
- **Image name is per-project.** Each repo gets its own image. After many repos, run `docker image prune` periodically.

## Arguments

- `--force` — overwrite existing `.sandcastle/`. Default: error on collision.
- `--runtime <name>` — force inclusion of a specific runtime regardless of detection (can be repeated). If `<name>` has no snippet, triggers the generator (step 6).
- `--exclude <name>` — exclude a detected runtime from the final Dockerfile.
- `--no-bootstrap` — skip step 3 (don't auto-install plugin runtime deps). Useful in dry-run.

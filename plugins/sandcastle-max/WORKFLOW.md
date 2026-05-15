# Workflow synthesis — sandcastle-max

How Leo and Claude use this plugin together. **One page**, every step explicit. If something here isn't implicit in the plugin, that's a gap to fix.

## Mental model in one paragraph

Leo writes a PRD → breaks it into GH issues with vertical-slice agent briefs → Claude (this plugin) reads the briefs and orchestrates Docker containers, one per issue, that run Claude Code AFK against the user's Max subscription. Each container opens a PR. CI gates the PRs by tier (foundations hold for human review, verticals auto-merge on green). Leo wakes up to a wave summary; reviews foundations; merges; runs the dispatcher again for the next wave. Repeat until the MVP ships.

**v0.7.0 addition**: before any container implements anything, the plugin enforces a 3-level reality check against resources the project declares in `.sandcastle/resources.json` (DB, APIs, queues). Host probes connectivity; container re-probes connectivity; container diffs the brief against the real schema. Tests then follow red-green-reality-first per acceptance criterion — no mocks for mandatory resources, ever. The whole loop is designed so an agent cannot ship a green PR that mocks divergent reality.

## The four moments

### Moment 1 — Setup (one-time per repo)

**Leo:** `/sandcastle-init` then `/sandcastle-build` then `/sandcastle-run` (the init prints this checklist).

**Claude (the plugin, v0.6.0):** detects the project's stack (.NET / Node / Bun / Python / Go / Ruby / Rust / polyglot) from manifests + lockfiles, composes a per-project Dockerfile from snippets, and scaffolds `.sandcastle/` (`Dockerfile`, `config.json`, `prompt.md`, `.env.example`, `.gitignore`). **Does NOT touch `package.json`, does NOT create `scripts/`, does NOT install JS deps in the repo.** Idempotent — refuses overwrites without `--force`. Errors loud on detection of v1 scaffold artifacts and tells Leo what to manually delete before re-running with `--force`.

**Plugin files responsible:** `commands/sandcastle-init.md` (detection + composition logic), `templates/snippets/*.dockerfile` (per-runtime fragments), `templates/prompt.md` + `templates/env.example` (copied to repo), `runtime/main.mts` (the orchestrator — lives in the plugin, never copied).

**Out-of-band knowledge required:** none. The slash command's printed checklist is self-contained.

---

### Moment 2 — Daily AFK dispatch

**Pre-conditions Leo must satisfy** (the plugin verifies + auto-recovers most of these):

- `docker info` works (Docker daemon up) — hard error if not.
- `gh auth status` works — auto-recovered to `GH_TOKEN` by pre-flight.
- `CLAUDE_CODE_OAUTH_TOKEN` available — auto-extracted from macOS Keychain (or fallback to `.sandcastle/.env` on Linux) by pre-flight.
- Per-project image already built — checks `.sandcastle/config.json`'s `imageName` against `docker image inspect`. If not, prints `run /sandcastle-build`.
- **(v0.7.0)** `.sandcastle/resources.json` declares external resources; `env_required` vars must be set on the host (Keychain / `.env`); each `mandatory` resource's `connectivity_probe` must pass from the host. **Level 1 probes run automatically as part of pre-flight** — a mandatory failure aborts dispatch before any container is launched.

**Leo:** `/sandcastle-dispatch-wave`

**Claude (the plugin):**

1. **Pre-flight** (verifies all pre-conditions; aborts with actionable error if any fail).
2. **Reads dep graph** — queries `gh issue list --search 'label:"ready-for-agent","state/ready-for-agent"'` (acepta ambas convenciones), parses each issue body for `## Blocked by`, checks dep status via `gh issue view N --json closedAt`, checks for in-flight PRs.
3. **Buckets issues**: eligible (deps met, no PR) / blocked (waiting on upstream) / skipped (`agent-blocked` label).
4. **Shows preview** — formatted table of all three buckets. Marks retries (issues with `agent-stuck`/`agent-crashed` labels but no PR).
5. **Asks** `[y/N/select <list>]`.
6. **On yes**: for each issue in the launch set:
   - Extracts the latest `## Agent Brief` comment via `gh api .../comments`.
   - Composes per-issue prompt at `.sandcastle/prompts/issue-N.md` using a fixed template (issue context + brief inlined + reading order: CLAUDE.md → brief → docs/phase1-decisions.md if linked → codebase + completion signal contract).
   - Pre-deletes any stale `agent/issue-N` branch (local + remote) to enable retries.
   - Launches Sandcastle in a background subshell with `SANDCASTLE_ISSUE_NUMBER`, `SANDCASTLE_BRANCH`, `SANDCASTLE_PROMPT_FILE` env vars.
7. **Monitors** — polls Docker every 30s for daemon health (Q11 wave-fatal); polls PIDs for completion; parses logs for `<promise>COMPLETE</promise>` / `<promise>BLOCKED</promise>` / `AgentIdleTimeoutError`.
8. **Applies outcomes**:
   - COMPLETE + PR opened → ✓
   - BLOCKED → (agent already commented + labeled, just record)
   - idle timeout → label `agent-stuck` + comment with log path
   - crash → label `agent-crashed` + comment with log path
9. **Prints final report** + saves `.sandcastle/wave-reports/<timestamp>.json`.

**Plugin file responsible:** `commands/sandcastle-dispatch-wave.md` + `templates/main.mts` (env-var-driven runtime).

**Out-of-band knowledge required (PROJECT-LOCAL but documented):**
- The project must use `engineering-workflow >= 2.1.0` for the single-brief invariant. The dispatcher's preflight warns if multiple briefs are detected. *(Documented in README + dispatcher command.)*
- The project's CI must understand the `afk-agent-pr` label that the agent applies to its PR. *(Documented in dispatcher prompt template + README.)*

---

### Moment 3 — CI gates (project-local, NOT in this plugin)

The agent's PR has the `afk-agent-pr` label. Project CI workflows decide automerge:

- `.github/workflows/afk-checks.yml` — typecheck + tests + (eventually) Playwright. Single aggregator job `all-checks-passed`.
- `.github/workflows/afk-automerge.yml` — on `workflow_run` of `afk-checks` success, evaluates Q8 tier rules:
  - Linked issue is `slice/foundation` → hold for human review (comment on PR explaining).
  - Linked issue has `agent-blocked` label or PR body has `<promise>BLOCKED</promise>` → hold.
  - PR body has unchecked acceptance criteria checkboxes → hold.
  - All clear → `gh pr merge --squash --delete-branch`.

**This plugin does NOT generate these workflows.** The plugin's responsibility ends at "PR opened with `afk-agent-pr` label". Each project owns its CI. *(Explicitly stated in README + WORKFLOW.md.)*

A reference implementation lives in `monitor_contrataciones/.github/workflows/` if you want to copy it.

---

### Moment 4 — Failure & recovery

When a wave finishes with mixed outcomes, Leo just runs `/sandcastle-dispatch-wave` again (Q12 smart wave): the dispatcher detects:
- Issues with PR open → in flight, skip.
- Issues with `agent-stuck` / `agent-crashed` labels but no PR → re-include in this wave (retries).
- Issues with `agent-blocked` → skip until Leo edits the brief and removes the label (per Q5: edit the existing `## Agent Brief` comment in place).

When a single retry fails repeatedly, the skill `sandcastle-afk` is the troubleshooting reference — three gotchas + Sandcastle internals grep map for forward-compat debugging.

**Plugin file responsible:** `skills/sandcastle-afk/SKILL.md` + the dispatcher's monitor logic (in `commands/sandcastle-dispatch-wave.md`).

---

## Self-containment audit

Per Leo's request: is the workflow above truly implicit in the plugin, or does it rely on shared knowledge between Leo and Claude that lives outside the plugin?

| Concern | Implicit in plugin? | Where |
|---|---|---|
| OAuth token wiring (Keychain → env → container) | ✓ | Inline en `commands/sandcastle-build.md` + `commands/sandcastle-run.md` + `commands/sandcastle-dispatch-wave.md` pre-flight; `runtime/main.mts` propaga al container vía `claudeCode(model, { env: { CLAUDE_CODE_OAUTH_TOKEN } })`. Sin `scripts/` en el repo del usuario. |
| The three Sandcastle gotchas | ✓ | `skills/sandcastle-afk/SKILL.md` |
| Dockerfile constraints (`chmod 1777`, `.claude.json` cleanup) | ✓ | `templates/snippets/agent.dockerfile` (siempre el último snippet en cada composición) + skill explanation |
| Smoke vs AFK mode switching (env vars) | ✓ | `runtime/main.mts` comments + `skills/sandcastle-afk/SKILL.md` "Two operating modes" |
| Brief is the contract (single per issue, last wins) | ✓ | `commands/sandcastle-dispatch-wave.md` step 4.1 — extracts `last(.body | contains "## Agent Brief")`. Skill's "How this plugin chains with engineering-workflow" section explains the dependency. |
| Dependency graph reading (`## Blocked by` parsing) | ✓ | `commands/sandcastle-dispatch-wave.md` step 1 |
| Wave preview + confirmation | ✓ | `commands/sandcastle-dispatch-wave.md` step 2-3 |
| Failure isolation (container vs env) | ✓ | `commands/sandcastle-dispatch-wave.md` step 5 monitor logic |
| Retry semantics (smart wave) | ✓ | `commands/sandcastle-dispatch-wave.md` step 1 + step 5 (label-based detection) + README "Re-runs (smart wave)" |
| Agent contract (prompt template, COMPLETE/BLOCKED tokens, PR + comment requirements) | ✓ | `commands/sandcastle-dispatch-wave.md` "Per-issue prompt.md template" |
| `afk-agent-pr` label convention | ✓ | Mentioned in dispatcher prompt template; consumer documented in this WORKFLOW.md |
| CI workflows themselves | ✗ (intentional) | Plugin explicitly says CI is project-local. Reference implementation in `monitor_contrataciones`. |
| `engineering-workflow >= 2.1.0` dependency | ✓ | README + skill "How this plugin chains with engineering-workflow" |
| `docs/phase1-decisions.md` (or any project-specific decisions doc) | △ | Dispatcher prompt template references it but acknowledges projects may not have one. The agent reads CLAUDE.md unconditionally; the decisions doc only if the brief mentions a P-anchor. |
| Pre-condition env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`) | ✓ | Dispatcher pre-flight + scaffolded `.env.example` |
| Cleanup of stale agent branches before retry | ✓ | `commands/sandcastle-dispatch-wave.md` step 4.3 |
| External resources declaration (DB/HTTP/queue) | ✓ (v0.7.0) | `templates/resources.json.example` scaffolded by `/sandcastle-init` into `.sandcastle/resources.json` |
| Level 1 host probe (anti-mock pre-flight) | ✓ (v0.7.0) | `commands/sandcastle-dispatch-wave.md` pre-flight block — reads `resources.json`, runs `connectivity_probe` from host, aborts dispatch on mandatory fail |
| Level 2 container probe (RESOURCE_UNREACHABLE) | ✓ (v0.7.0) | Prompt template Step 0 + completion signal subtype + monitor label routing (`agent-blocked-resource`) |
| Level 3 schema diff (SCHEMA_MISMATCH) | ✓ (v0.7.0) | Prompt template Step 0.b — compares brief refs against `.sandcastle/probes/<name>.schema` cached from Level 1 introspect |
| Resource env propagation (host → container) | ✓ (v0.7.0) | `runtime/main.mts` parses `resources.json` and adds `env_required` to `agentEnv` |
| Red-green-reality-first (anti-horizontal) | ✓ (v0.7.0) | Prompt template step 2 (replaces "implement the slice") + anti-patterns + TEST_NOOP subtype |

### Gaps identified (and acceptable)

1. **CI workflows are NOT generated.** Plugin draws a clear line: PR creation is the boundary. Each project's CI is its own concern. Reference implementation in `monitor_contrataciones/.github/workflows/` for projects to copy.
2. **`docs/phase1-decisions.md` path is project-local.** Dispatcher's prompt template hard-codes `docs/phase1-decisions.md` because Leo's first project uses it; for projects that name it differently (e.g. `docs/decisions/phase-2.md`), the prompt template will harmlessly tell the agent to read a non-existent file. Acceptable cost: the agent is told to skip if not present.
3. **Wave size is unbounded** (cap is the natural max from dep graph). If quota becomes a real bottleneck, the `--max-parallel` flag exists. Default behavior optimizes for wall-clock, not quota.

### Conclusion

The plugin is self-contained for the AFK execution domain. The two intentional out-of-plugin dependencies (engineering-workflow plugin + project-local CI) are explicitly documented and bounded. Leo can hand this plugin to a future Claude session with no out-of-band briefing and the future Claude will know:

- How to scaffold (`/sandcastle-init`).
- How to dispatch (`/sandcastle-dispatch-wave`).
- How to debug (`skill: sandcastle-afk` with the gotchas + grep map).
- What the plugin does NOT do (CI, PR review, brief authoring) and where those responsibilities live.

If a future grilling session adds new decisions (Q13+), they should be encoded as updates to `commands/sandcastle-dispatch-wave.md` + bumping the plugin version, NOT as tribal knowledge in conversations.

---

## v0.6.0 addendum — stack-aware scaffold

The plugin used to ship a single hardcoded Dockerfile (Node 22 + Bun + Claude Code). That broke verification on .NET / Python / Go projects (the container didn't have the project's runtime). v0.6.0 redesign:

- `commands/sandcastle-init.md` v2 detects runtimes per project and composes the Dockerfile from snippets in `templates/snippets/`. Each snippet is a Dockerfile fragment with metadata headers (`# name`, `# default-version`, `# detect: <glob patterns>`). Init parses them, matches against the project's files, substitutes versions, concatenates. Generator fallback for unknown stacks: subagent + WebFetch to docs.
- Orchestrator moved out of the user's repo: `runtime/main.mts` reads `.sandcastle/config.json` from cwd. The repo never installs `@ai-hero/sandcastle` or `tsx`.
- New slash commands: `/sandcastle-build` and `/sandcastle-run`. Secrets extracted inline (Keychain + `gh auth token`) with `.sandcastle/.env` fallback. No `scripts/claude-oauth-env.sh` in repo.
- Per-project image (`sandcastle-<repo-basename>`) replaces the global `sandcastle-max`.
- No backward compat: v0.5.x repos require manual cleanup before `/sandcastle-init --force`.

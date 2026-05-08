# sandcastle-max

Run [@ai-hero/sandcastle](https://github.com/mattpocock/sandcastle) (AFK Claude Code agents in Docker) using your **Claude Max subscription** via `CLAUDE_CODE_OAUTH_TOKEN` instead of paying for `ANTHROPIC_API_KEY` tokens.

Workaround for Sandcastle [issue #191](https://github.com/mattpocock/sandcastle/issues/191) (subscription auth — marked **wontfix** by the maintainer).

## End-to-end flow (how Leo and Claude use this together)

```
   1. PRD               2. Issues + briefs      3. Wave dispatch       4. CI gate
   ──────               ────────────────        ───────────────         ────────
   /to-prd              /to-issues + /triage    /sandcastle-dispatch    .github/workflows/
   PRD doc              GH issue body            -wave                   afk-automerge.yml
                        + ## Agent Brief         (this plugin)
                        comment (single,
                        edited not duplicated
                        per engineering-
                        workflow >=2.1.0)
                                                       │
                                                       │  parallel containers
                                                       │  (one per eligible issue)
                                                       ▼
                                                 5. Agent works
                                                    ──────────
                                                    Reads CLAUDE.md, the
                                                    inlined brief, and any
                                                    docs/phase1-decisions.md
                                                    P-anchors the brief links.
                                                    Implements vertical slice,
                                                    runs tests, opens PR with
                                                    `afk-agent-pr` label,
                                                    comments on issue, prints
                                                    <promise>COMPLETE</promise>.
                                                       │
                                                       ▼
                                                 6. CI decides
                                                    ──────────
                                                    afk-checks.yml runs
                                                    typecheck/tests/playwright.
                                                    afk-automerge.yml decides
                                                    auto-merge per tier (Q8):
                                                    F* → hold for review,
                                                    VS* → auto-merge on green
                                                    (escape hatch for BLOCKED
                                                    or unchecked criteria).
```

## What this plugin gives you

### Slash commands

- **`/sandcastle-init`** — scaffolds `.sandcastle/` in any repo: Dockerfile (with chmod 1777 fix + Claude installer state cleanup), env-var-driven `main.mts`, prompt template, `.env.example`, `scripts/claude-oauth-env.sh` (Keychain → env, no leak), package.json scripts, `.gitignore` updates. **Idempotent** — refuses to overwrite without `--force`.

- **`/sandcastle-dispatch-wave`** *(v0.3.0)* — wave-based AFK dispatcher. Reads the GH issue dependency graph (parsing `## Blocked by` from issue bodies), detects eligible issues (`state/ready-for-agent` + all deps closed + no open PR), shows preview, asks confirmation, then launches one Docker container per eligible issue in parallel. Each container gets its own per-issue `prompt.md` with the brief inlined. Failure isolation: a single container failing (idle, BLOCKED, crash) doesn't abort siblings, but env-level failures (Docker daemon, OAuth) abort the entire wave.

### Skill

- **`sandcastle-afk`** — full troubleshooting + architecture guide. Documents:
  - The three non-obvious gotchas (interactive init wizard with no override, UID mismatch between agent install and runtime user, owner-only `.claude.json` that hangs `claude --print` silently).
  - The OAuth-vs-API-key auth wiring.
  - **Sandcastle internals grep map** — 13 anchored symbols (e.g. `process.getuid` in `dist/sandboxes/docker.js`) so future-you can debug Sandcastle version drift without bisecting.

## Usage

### One-time setup per repo

```
/sandcastle-init
```

Then:

```bash
claude setup-token              # one-time per machine, populates macOS Keychain
source scripts/claude-oauth-env.sh
bun run sandcastle:build        # 1-3 min first time (downloads node:22 + Bun + gh CLI + Claude Code)
bun run sandcastle:run          # smoke prompt to verify everything works
```

If smoke prints `<promise>COMPLETE</promise>`, you're set.

### Daily AFK execution

```bash
source scripts/claude-oauth-env.sh
export GH_TOKEN=$(gh auth token)
/sandcastle-dispatch-wave
```

The dispatcher will:
1. Verify pre-conditions (Docker daemon, env vars, image built, `.sandcastle/` scaffolded).
2. Read issue tracker; compute eligible wave.
3. Show preview: eligible issues, blocked issues with reason, skipped issues with `agent-blocked`.
4. Ask `[y/N/select <list>]`.
5. On `y`: extract the latest `## Agent Brief` per issue, generate `.sandcastle/prompts/issue-N.md` per issue, launch containers in parallel.
6. Monitor for completion / failure; apply outcome labels + issue comments.
7. Print final wave summary.

### Re-runs (smart wave)

A second `/sandcastle-dispatch-wave` invocation:
- Skips issues that already have an open PR (in flight).
- Re-includes issues with `agent-stuck` / `agent-crashed` labels (no PR yet) as **retries**.
- Skips issues with `agent-blocked` (need your input on the brief — once you edit and remove the label, they re-enter the wave).

This makes wave-based ops uniform: one command for first-try and retries.

## Why this exists

- Claude Max 20x ($200/mo) has 5h-window quotas. AFK runs through Sandcastle default (API key) bypass that and bill per token instead — a 30-60min brief can cost $5-50.
- Wiring `CLAUDE_CODE_OAUTH_TOKEN` makes AFK runs consume from the same subscription pool as your interactive sessions. No extra billing.
- The Sandcastle maintainer chose not to support this in core (issue #191 wontfix). The workaround is non-obvious enough to deserve a packaged solution.
- Wave-based dispatch + dep-graph reading + failure isolation are not in Sandcastle either — they're operational concerns that emerged when running this against a real 12-issue MVP.

## What this plugin does NOT do

- **CI / auto-merge logic.** That lives in `.github/workflows/afk-automerge.yml` per project (the dispatcher just adds the `afk-agent-pr` label so CI knows what to gate). The plugin does not generate CI workflows — the project chooses its CI provider.
- **PR review.** When the agent opens a PR, a human (you) reviews it via standard GH UI flow. The dispatcher only opens; humans (or auto-merge based on labels + tests) decide ship.
- **Brief authoring.** Briefs come from the `engineering-workflow` plugin's `/agent-brief` and `/triage` skills. This plugin **consumes** the latest `## Agent Brief` comment on the issue. If the comment doesn't exist, the dispatcher refuses with an actionable error.
- **Cross-cutting decisions.** The brief should link to project-local docs (e.g. `docs/phase1-decisions.md`); the agent reads them on-demand inside the container per the prompt's reading order. The dispatcher does NOT inline these docs.

## Limitations

- **macOS-only** for the Keychain helper. On Linux/server, paste the OAuth token directly into `.sandcastle/.env` or wire your own secret store.
- **5h-window quota applies.** If you run 4-6 AFK containers in parallel, they share the same Max window. Tune wave size accordingly or fall back to API key for sustained parallel workloads.
- **Sandcastle hardcodes** `--user $HOST_UID:$HOST_GID` and `HOME=/home/agent`. The Dockerfile is shaped around those constraints. If Sandcastle changes that, the Dockerfile may need adjustment — see the `sandcastle-afk` skill's grep map.
- **Concurrency capped by dep graph.** The dispatcher launches all eligible at once. If your dep graph naturally serializes (e.g. all issues block on a single foundation), the wave will be size 1.

## Files in this plugin

```
sandcastle-max/
├── plugin.json
├── README.md                                     ← this file
├── commands/
│   ├── sandcastle-init.md                        ← /sandcastle-init slash command
│   └── sandcastle-dispatch-wave.md               ← /sandcastle-dispatch-wave (v0.3.0)
├── skills/
│   └── sandcastle-afk/
│       └── SKILL.md                              ← troubleshooting + architecture + grep map
├── templates/
│   ├── Dockerfile                                ← fixed (chmod 1777 + .claude.json cleanup)
│   ├── main.mts                                  ← env-var-driven (smoke or AFK dispatch)
│   ├── prompt.md                                 ← smoke test placeholder
│   └── env.example                               ← CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN
└── scripts/
    └── claude-oauth-env.sh                       ← Keychain → CLAUDE_CODE_OAUTH_TOKEN, no leak
```

## Related plugins in this marketplace

- **engineering-workflow** *(>=2.1.0)* — the pipeline that produces the agent briefs you feed to Sandcastle. `/triage` and `/agent-brief` enforce the **single-brief invariant** (edit, do not duplicate) which `/sandcastle-dispatch-wave` consumes. Without v2.1.0, multiple briefs may exist per issue and the dispatcher's "latest wins" rule can be inconsistent — strongly prefer >=2.1.0.

## Version history

- **0.3.0** — `/sandcastle-dispatch-wave` command added. `main.mts` is now env-var-driven (smoke vs AFK dispatch detected automatically). Per-issue prompt files in `.sandcastle/prompts/`. Failure isolation per Q11. Smart wave (Q12) handles first-try + retries uniformly.
- **0.2.0** — Sandcastle-internals grep map added to skill (forward-compat debugging).
- **0.1.0** — Initial release: `/sandcastle-init` + `sandcastle-afk` skill.

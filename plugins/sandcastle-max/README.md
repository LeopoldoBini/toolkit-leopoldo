# sandcastle-max

Run [@ai-hero/sandcastle](https://github.com/mattpocock/sandcastle) (AFK Claude Code agents in Docker) using your **Claude Max subscription** via `CLAUDE_CODE_OAUTH_TOKEN` instead of paying for `ANTHROPIC_API_KEY` tokens.

Workaround for Sandcastle [issue #191](https://github.com/mattpocock/sandcastle/issues/191) (subscription auth — marked **wontfix** by the maintainer).

## End-to-end flow (how Leo and Claude use this together)

**v0.5.0** introdujo el flujo Opus-everywhere con merge-agent y validator local. El ciclo AFK ahora es completamente managed por este plugin — sin GH Actions, sin `/triage` manual (gracias a engineering-workflow >=2.1.0).

```
   1. Pipeline humano (engineering-workflow)
   ─────────────────────────────────────────
   /grill-with-docs ─► /to-prd ─► /to-issues
                                       │
                                       │ Issues con label `ready-for-agent` directo
                                       │ + `## Agent Brief` comment (single-brief invariant)
                                       ▼

   2. Dispatch + implementación AFK (este plugin)
   ──────────────────────────────────────────────
   /sandcastle-pipeline (o /sandcastle-dispatch-wave manual)
        │
        │  N containers Opus 4.7 en paralelo (default --max-parallel 4)
        │  Cada uno:
        │   - branchStrategy: { type: 'branch', branch: agent/<base-slug>/issue-N }
        │   - Lee CLAUDE.md + brief + diff
        │   - Implementa vertical slice
        │   - Self-check vs brief (single-axis Spec)
        │   - Abre PR con label afk-agent-pr contra $BASE_BRANCH
        │   - Emite <promise>COMPLETE</promise> o <promise>BLOCKED</promise> + subtipo
        ▼

   3. Validate local (este plugin, Fase 3)
   ───────────────────────────────────────
   ${CLAUDE_PLUGIN_ROOT}/scripts/sandcastle-validate.sh $PR
        │  docker run --rm liviano (la per-project sandcastle image del repo,
        │    leída de .sandcastle/config.json — fallback a oven/bun:latest)
        │  install + typecheck + test per stack detectado (Node/.NET/Python/Go)
        │  → label afk-checks-passed o afk-checks-failed + comentario al PR
        ▼

   4. Review + merge (este plugin)
   ───────────────────────────────
   /sandcastle-merge-wave (o lo invoca el pipeline)
        │
        │  Step 1: N reviewers Opus paralelos (read-only)
        │          single-axis Spec — juzga contra el brief
        │          emite <verdict>APPROVE|HOLD|BLOCK</verdict>
        │
        │  Step 2: Coordinator Opus topológico (1 invocación)
        │          orden de merge + pares de riesgo semántico
        │
        │  Step 3: Loop secuencial de merge
        │          auto-rebase → si conflict → conflict-resolver Opus
        │                                       (intent-aware, RESOLVED/INCOMPATIBLE)
        │          sandcastle-validate post-rebase
        │          gh pr merge --squash --delete-branch
        ▼

   5. Loop hasta que no queden issues elegibles
```

**Fase 6 (diferida)**: cuando `/review` de Matt Pocock gradúe de in-progress a stable, el reviewer del Step 1 pasa a two-axis (Standards + Spec en paralelo sin merge ni rerank).

## What this plugin gives you

### Slash commands

- **`/sandcastle-init`** *(v0.6.0 stack-aware)* — detects the project's runtimes from manifests/lockfiles (`.csproj`, `package.json`, `bun.lockb`, `pyproject.toml`, `go.mod`, etc.) and composes a per-project `Dockerfile` from the plugin's snippet registry (Debian base + matching runtime snippets + Claude Code agent layer with UID surgery). Scaffolds **only** `.sandcastle/` in the user repo: `Dockerfile`, `config.json`, `prompt.md`, `.env.example`, `.gitignore`. **Does NOT** touch `package.json`, **does NOT** create `scripts/`, **does NOT** install JS deps. The orchestrator (`main.mts` + `@ai-hero/sandcastle`) lives in the plugin. Idempotent — refuses to overwrite without `--force`. Generator fallback for unknown stacks (subagent + WebFetch to official install docs) writes to `.sandcastle/snippets/<stack>.dockerfile` for user review.

- **`/sandcastle-build`** *(v0.6.0)* — builds the per-project Docker image. Reads `imageName` from `.sandcastle/config.json` (default `sandcastle-<repo-basename>`). Auto-bootstraps plugin runtime deps on first run.

- **`/sandcastle-run`** *(v0.6.0)* — runs the smoke prompt. Extracts `CLAUDE_CODE_OAUTH_TOKEN` from macOS Keychain on-demand (fallback to `.sandcastle/.env` on Linux), invokes the plugin orchestrator. No `source scripts/...` step needed.

- **`/sandcastle-dispatch-wave`** *(v0.5.0)* — wave-based AFK dispatcher. Reads the GH issue dependency graph (parsing `## Blocked by` from issue bodies), detects eligible issues (label `ready-for-agent` o `state/ready-for-agent` + all deps closed + no open PR), shows preview, asks confirmation, then launches one Docker container per eligible issue in parallel. **Soporta feature branches y worktrees** — detecta el HEAD actual como base (no asume `main`), naming `agent/<base-slug>/issue-N` evita colisiones. **Default Opus 4.7** (parametrizable vía `SANDCASTLE_MODEL`). Self-check vs brief antes del PR. Subtipos de BLOCKED (`BRIEF_AMBIGUOUS`, `CODEBASE_UNEXPECTED`, `DEPENDENCY_MISSING`) para ruteo downstream.

- **`/sandcastle-merge-wave`** *(v0.5.0)* — cierre del loop AFK. Espejo de dispatch-wave para la mitad post-implementación. (1) Review paralelo Opus (single-axis Spec) sobre PRs con label `afk-agent-pr + afk-checks-passed`, emite verdicts APPROVE/HOLD/BLOCK con subtipos. (2) Coordinator Opus topológico decide orden de merge y marca pares de riesgo semántico. (3) Merge serial con auto-rebase; si hay conflict, lanza un **conflict-resolver agent intent-aware** que emite `RESOLVED` (push --force) o `INCOMPATIBLE` (escalate a Leo con label `intent-conflict`). Fixer-container para BLOCK + IMPLEMENTATION; re-brief para BRIEF_AMBIGUOUS. Cap 2 rounds por issue.

- **`/sandcastle-pipeline`** *(v0.5.0)* — meta-comando integrador. Loopa dispatch-wave → polling local de sandcastle-validate → merge-wave hasta que no queden issues elegibles. Checkpoints JSON tras cada step grande (`.sandcastle/checkpoints/<wave-ts>.json`) permiten reanudar tras interrupciones. Detección de quota Max exhausted (parseo de logs en busca de rate limit / 429) con abort + label `quota-exhausted`. Default `--max-parallel 4` con Opus. Args `--max-iterations`, `--from-iteration`, `--dry-run`, `--no-confirm`, `--abort-on-block`.

- **`/afk-pr-triage`** *(legacy, v0.4.0)* — deterministic PR triage (typecheck/tests + parsing de acceptance criteria), sin juicio sobre código. **Reemplazado por `/sandcastle-merge-wave`** en v0.5.0. Se mantiene como fallback para casos donde no querés gastar Opus en review (proyectos muy chicos o calibración inicial).

### Scripts ejecutables (en el plugin, no en el repo del usuario)

- **`${CLAUDE_PLUGIN_ROOT}/scripts/sandcastle-validate.sh <PR_NUMBER>`** *(v0.5.0, multi-stack en v0.6.0)* — local CI gate. Corre typecheck + tests en container Docker liviano sobre worktree fresh del PR. **v0.6.0:** default usa la per-project image del repo (`imageName` de `.sandcastle/config.json`) — ya tiene los runtimes correctos instalados. Defaults multi-stack: detecta `package.json` + lockfile (bun/pnpm/yarn/npm), `*.csproj`/`*.sln` (.NET), `pyproject.toml`/`requirements.txt` (Python), `go.mod` (Go). Aplica labels `afk-checks-passed` / `afk-checks-failed` + comentario en el PR si falla. Customizable vía `SANDCASTLE_VALIDATOR_IMAGE` env var o `.sandcastle/validate.cmds` archivo del proyecto.

*(v0.6.0 removed `scripts/claude-oauth-env.sh` — la lógica de extracción de Keychain ahora vive inline en `/sandcastle-build` y `/sandcastle-run` con fallback a `.sandcastle/.env`. Cero `scripts/` en el repo del usuario.)*

### Skill

- **`sandcastle-afk`** — full troubleshooting + architecture guide. Documents:
  - The three non-obvious gotchas (interactive init wizard with no override, UID mismatch between agent install and runtime user, owner-only `.claude.json` that hangs `claude --print` silently).
  - The OAuth-vs-API-key auth wiring.
  - **Sandcastle internals grep map** — 13 anchored symbols (e.g. `process.getuid` in `dist/sandboxes/docker.js`) so future-you can debug Sandcastle version drift without bisecting.

## Usage

### One-time setup per repo (v0.6.0)

```
/sandcastle-init                # detects stack, composes Dockerfile, writes .sandcastle/
```

Then:

```
claude setup-token              # one-time per machine, populates macOS Keychain
/sandcastle-build               # 2-5 min first time, depends on runtimes detected
/sandcastle-run                 # smoke prompt to verify everything works
```

If smoke prints `<promise>COMPLETE</promise>`, you're set.

### Daily AFK execution

```
/sandcastle-dispatch-wave       # secrets extracted automatically from Keychain + gh auth token
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

## What this plugin does NOT do (v0.5.0)

- **Brief authoring.** Briefs come from the `engineering-workflow` plugin's `/agent-brief` and `/triage` skills. Este plugin **consume** el último `## Agent Brief` comment del issue. Si no existe, dispatch-wave aborta con error accionable.
- **Cross-cutting decisions.** El brief linkea a docs del proyecto (ej. `docs/phase1-decisions.md`); el agente las lee on-demand inside the container. El dispatcher NO los inlinea.
- **Standards review.** El reviewer actual evalúa solo Spec (¿la implementación honra el contrato?). El eje Standards (CLAUDE.md, CONTEXT.md, ADRs) se incorpora en Fase 6 cuando `/review` de Matt Pocock gradúe a stable.

**Cambios v0.5.0 (lo que SÍ hace ahora que antes no):**
- ✓ **PR review automático** (era humano-only): `/sandcastle-merge-wave` con Opus reviewer.
- ✓ **Auto-merge sin GH Actions** (era remoto): merge serial con coordinator + intent-aware resolver.
- ✓ **CI gate local** (era `afk-checks.yml` remoto): `scripts/sandcastle-validate.sh`.
- ✓ **Feature branches y worktrees** (era main-only): naming `agent/<base-slug>/issue-N`, PR contra base detectada.

## Limitations

- **macOS-only** for the Keychain helper. On Linux/server, paste the OAuth token directly into `.sandcastle/.env` or wire your own secret store.
- **5h-window quota applies.** If you run 4-6 AFK containers in parallel, they share the same Max window. Tune wave size accordingly or fall back to API key for sustained parallel workloads.
- **Sandcastle hardcodes** `--user $HOST_UID:$HOST_GID` and `HOME=/home/agent`. The Dockerfile is shaped around those constraints. If Sandcastle changes that, the Dockerfile may need adjustment — see the `sandcastle-afk` skill's grep map.
- **Concurrency capped by dep graph.** The dispatcher launches all eligible at once. If your dep graph naturally serializes (e.g. all issues block on a single foundation), the wave will be size 1.

## Files in this plugin (v0.6.0)

```
sandcastle-max/
├── plugin.json
├── README.md                                     ← this file
├── commands/
│   ├── sandcastle-init.md                        ← /sandcastle-init (stack-aware scaffolding, v2)
│   ├── sandcastle-build.md                       ← /sandcastle-build (NEW v0.6.0)
│   ├── sandcastle-run.md                         ← /sandcastle-run (NEW v0.6.0)
│   ├── sandcastle-dispatch-wave.md               ← /sandcastle-dispatch-wave
│   ├── sandcastle-merge-wave.md                  ← /sandcastle-merge-wave
│   ├── sandcastle-pipeline.md                    ← /sandcastle-pipeline
│   └── afk-pr-triage.md                          ← /afk-pr-triage (legacy)
├── skills/
│   └── sandcastle-afk/
│       └── SKILL.md                              ← troubleshooting + architecture + grep map
├── runtime/                                      ← NEW v0.6.0: orchestrator out of user repos
│   ├── main.mts                                  ← reads .sandcastle/config.json from cwd
│   ├── package.json                              ← @ai-hero/sandcastle + tsx (deps)
│   └── node_modules/                             ← bootstrapped on first /sandcastle-build (~95MB)
├── templates/
│   ├── prompt.md                                 ← smoke test placeholder (copied to repo)
│   ├── env.example                               ← CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN (copied to repo)
│   └── snippets/                                 ← NEW v0.6.0: per-runtime Dockerfile fragments
│       ├── base.dockerfile                       ← FROM debian:bookworm-slim + git/curl/gh
│       ├── agent.dockerfile                      ← Claude Code install + UID surgery (always last)
│       ├── dotnet.dockerfile
│       ├── node.dockerfile
│       ├── bun.dockerfile
│       ├── python.dockerfile
│       ├── go.dockerfile
│       ├── ruby.dockerfile
│       └── rust.dockerfile
└── scripts/
    └── sandcastle-validate.sh                    ← local CI gate (multi-stack defaults v0.6.0)
```

## Related plugins in this marketplace

- **engineering-workflow** *(>=2.1.0)* — the pipeline that produces the agent briefs you feed to Sandcastle. `/triage` and `/agent-brief` enforce the **single-brief invariant** (edit, do not duplicate) which `/sandcastle-dispatch-wave` consumes. Without v2.1.0, multiple briefs may exist per issue and the dispatcher's "latest wins" rule can be inconsistent — strongly prefer >=2.1.0.

## Version history

- **0.6.0** *(2026-05-15)* — **Stack-aware scaffold** (rediseño completo de `sandcastle-init`).
  - Disparador: imagen fija Bun + Node 22 rompía la verificación del agente en proyectos .NET / Python / Go (no podía correr `dotnet test`, `pytest`, etc.).
  - Detector de runtimes desde manifests/lockfiles (root + 1 nivel de subdirs) con multi-stack detect-all → fat Dockerfile per-project.
  - Composición vía snippets en `templates/snippets/`: `base.dockerfile` → snippets de runtimes detectados → `agent.dockerfile` (UID surgery + Claude Code, siempre último). Base de `node:22-bookworm` → `debian:bookworm-slim` para neutralidad de stack.
  - Per-project image: `imageName = sandcastle-<repo-basename>` (antes: una sola imagen global `sandcastle-max`).
  - Orchestrator (`main.mts` + `@ai-hero/sandcastle` + `tsx`) movido al plugin (`runtime/`). El repo del usuario ya no necesita `package.json` ni instala deps JS — proyectos .NET/Python/Go puros funcionan nativos.
  - Slash commands nuevos `/sandcastle-build` y `/sandcastle-run` reemplazan `bun run sandcastle:build/run`. Secrets extraídos on-demand del Keychain (macOS) con fallback a `.sandcastle/.env` (Linux/override) — sin `scripts/claude-oauth-env.sh` en el repo.
  - Generador fallback para stacks unknown (Elixir, Swift, etc.): subagente con WebFetch a docs oficiales escribe `.sandcastle/snippets/<stack>.dockerfile` para review manual antes del primer build.
  - Versionado híbrido: cada snippet tiene una "blessed version", override per-project vía `versions: { dotnet: "9.0" }` en `.sandcastle/config.json`.
  - Sin backward compat — cutoff duro. Repos v0.5.x se migran manual: borrar `.sandcastle/main.mts`, `scripts/claude-oauth-env.sh`, scripts `sandcastle:*` de `package.json`, devDeps `@ai-hero/sandcastle` + `tsx`. Luego `/sandcastle-init --force`.
  - `sandcastle-validate.sh`: defaults multi-stack (Node/Bun/.NET/Python/Go), usa la per-project image del repo por default.

- **0.5.0** — Rediseño Opus everywhere + merge-agent + feature branches (5 fases del plan 2026-05-13).
  - `templates/main.mts`: modelo parametrizable vía `SANDCASTLE_MODEL` env var, default Opus 4.7. Lee `SANDCASTLE_BASE_BRANCH` para logging.
  - `/sandcastle-dispatch-wave`: detecta base branch del HEAD actual (soporta feature branches y worktrees), naming `agent/<base-slug>/issue-N` evita colisiones, PR contra base detectada (no main hardcoded). Self-check vs brief antes del PR (single-axis Spec). Subtipos de BLOCKED (BRIEF_AMBIGUOUS / CODEBASE_UNEXPECTED / DEPENDENCY_MISSING). Pre-flight warna si otro worktree tiene PIDs vivos.
  - `/sandcastle-merge-wave` (NUEVO): orquestador de review + merge en 3 steps (review paralelo Opus → coordinator topológico → merge serial con auto-rebase + conflict-resolver intent-aware). Fixer-container para BLOCK + IMPLEMENTATION; re-brief para BRIEF_AMBIGUOUS. Cap 2 rounds.
  - `/sandcastle-pipeline` (NUEVO): integrador con loop, polling local cada 30s, checkpoints JSON para recovery, detección de quota Max exhausted.
  - `scripts/sandcastle-validate.sh` (NUEVO): local CI gate, reemplaza `afk-checks.yml` remoto. Container Docker liviano (`oven/bun:latest` default) sobre worktree fresh del PR.
- **0.4.1** — `/sandcastle-dispatch-wave` acepta label flat (`ready-for-agent`) o namespaced (`state/ready-for-agent`).
- **0.4.0** — `/afk-pr-triage` cierra el AFK loop (reemplazado por merge-wave en v0.5.0).
- **0.3.1** — `/sandcastle-dispatch-wave` pre-flight self-recovers missing env vars (OAuth + GH token).
- **0.3.0** — `/sandcastle-dispatch-wave` command added. `main.mts` env-var-driven. Per-issue prompt files. Failure isolation. Smart wave (first-try + retries uniformes).
- **0.2.0** — Sandcastle-internals grep map added to skill (forward-compat debugging).
- **0.1.0** — Initial release: `/sandcastle-init` + `sandcastle-afk` skill.

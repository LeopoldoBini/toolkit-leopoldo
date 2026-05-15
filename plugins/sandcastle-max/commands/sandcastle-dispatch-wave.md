---
name: sandcastle-dispatch-wave
description: Detect and dispatch a wave of AFK Claude Code agents in parallel via Sandcastle, using the user's Claude Max subscription. Reads the dependency graph from GH issues (parsing `## Blocked by` from issue bodies), shows a preview of eligible issues, and on user confirmation launches one Docker container per eligible issue concurrently. Each agent works on a dedicated branch (`agent/issue-N`), reads the latest `## Agent Brief` comment as its contract, and is expected to open a PR + comment on the issue when done. Triggers when the user says "dispatch wave", "lanzar ola AFK", "dispatch issues", "correr los agentes AFK".
---

# /sandcastle-dispatch-wave

Wave-based dispatcher for AFK agents. Reads the GH issue tracker, computes the next wave (issues whose dependencies are merged), shows you a preview, and on confirmation launches Sandcastle containers in parallel — one per eligible issue.

This command implements the design decisions from the `/grill-me` round of 2026-05-08:
- **Q6 (hybrid prompt)**: brief is inlined into a per-issue `prompt.md`; agent gets a header with callback instructions (PR, comment, COMPLETE/BLOCKED tokens).
- **Q9 (wave-based parallelism)**: no fixed N; runs all eligible in parallel, capped by the natural max from the dep graph.
- **Q10 (auto-detection + confirmation)**: parse `## Blocked by` from issue bodies, preview, ask y/N before launching.
- **Q11 (failure isolation)**: container-level failures don't kill siblings; env-level failures (Docker daemon, OAuth) abort the wave.
- **Q12 (smart wave)**: a single invocation handles first-try and retries uniformly. Issues with `agent-blocked` label are skipped (need user input on the brief).

## Pre-conditions (verify + auto-recover before doing anything)

The dispatcher self-recovers missing env vars when possible. **All subsequent Bash steps must run inside a single shell session that inherits the recovered vars** — that's why pre-flight, brief extraction, and the launch loop are run as one Bash invocation (or chained via `&&`), not as separate Bash tool calls.

Run this self-recovering pre-flight via a SINGLE Bash invocation:

```bash
set -e

# Hard checks — abort if any fail.
git rev-parse --show-toplevel >/dev/null || { echo "✗ not a git repo"; exit 1; }
[[ -f .sandcastle/config.json ]] || { echo "✗ .sandcastle/ not scaffolded — run /sandcastle-init first"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker daemon not running"; exit 1; }
gh repo view --json nameWithOwner --jq .nameWithOwner >/dev/null || { echo "✗ gh repo unresolved"; exit 1; }

# Read per-project image name from config (v2 scaffold).
IMAGE_NAME=$(jq -r '.imageName' .sandcastle/config.json)
[[ -n "$IMAGE_NAME" && "$IMAGE_NAME" != "null" ]] || { echo "✗ imageName missing from .sandcastle/config.json"; exit 1; }
export IMAGE_NAME
docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || { echo "✗ image '$IMAGE_NAME' not built — run /sandcastle-build"; exit 1; }

# Bootstrap plugin runtime if missing (one-time).
if [[ ! -d "${CLAUDE_PLUGIN_ROOT}/runtime/node_modules" ]]; then
  echo "✓ bootstrapping plugin runtime (one-time)..."
  (cd "${CLAUDE_PLUGIN_ROOT}/runtime" && (bun install || npm install)) >/dev/null
fi

# Auto-recover OAuth token: Keychain → .sandcastle/.env fallback.
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [[ -z "$CLAUDE_CODE_OAUTH_TOKEN" && -f .sandcastle/.env ]]; then
    CLAUDE_CODE_OAUTH_TOKEN=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' .sandcastle/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
  export CLAUDE_CODE_OAUTH_TOKEN
  [[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]] || {
    echo "✗ CLAUDE_CODE_OAUTH_TOKEN missing — not in Keychain and no .sandcastle/.env."
    echo "  macOS: run 'claude setup-token' then re-run."
    echo "  Linux: paste token into .sandcastle/.env."
    exit 1
  }
fi

# Auto-recover GH token: if missing, attempt to read from gh CLI.
if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  if gh auth status >/dev/null 2>&1; then
    export GH_TOKEN=$(gh auth token)
  fi
  [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] || {
    echo "✗ No GH_TOKEN/GITHUB_TOKEN and gh CLI not authenticated."
    echo "  Try: gh auth login   (or set GH_TOKEN manually)"
    exit 1
  }
fi

echo "✓ pre-flight passed (oauth=present gh_token=present docker=ok image=$IMAGE_NAME)"

# Level 1 probe — host-side resource reachability.
# Reads .sandcastle/resources.json (per-project declarative resource registry).
# For each resource with policy=mandatory: verifies env_required are set, runs
# connectivity_probe FROM THE HOST. Any failure aborts dispatch before launching
# a single container. Optional resources are probed too but failures are warnings.
# Schema introspect outputs are cached to .sandcastle/probes/<resource>.schema so
# the per-issue prompts can reference them in Step 0.b (Level 3 probe).
if [[ -f .sandcastle/resources.json ]]; then
  echo "✓ resources.json found — running Level 1 probes (host-side)..."
  mkdir -p .sandcastle/probes
  RESOURCES_FAILED=()
  RESOURCES_OPTIONAL_FAILED=()
  # Validate JSON before iterating.
  jq -e . .sandcastle/resources.json >/dev/null || { echo "✗ .sandcastle/resources.json is not valid JSON"; exit 1; }

  RESOURCE_COUNT=$(jq '.resources | length' .sandcastle/resources.json)
  for IDX in $(seq 0 $((RESOURCE_COUNT - 1))); do
    R_NAME=$(jq -r ".resources[$IDX].name" .sandcastle/resources.json)
    R_TYPE=$(jq -r ".resources[$IDX].type" .sandcastle/resources.json)
    R_POLICY=$(jq -r ".resources[$IDX].policy // \"optional\"" .sandcastle/resources.json)
    R_PROBE=$(jq -r ".resources[$IDX].connectivity_probe" .sandcastle/resources.json)
    R_INTROSPECT=$(jq -r ".resources[$IDX].schema_introspect // empty" .sandcastle/resources.json)

    # Verify env_required are set on the host.
    ENV_MISSING=()
    ENV_COUNT=$(jq ".resources[$IDX].env_required | length" .sandcastle/resources.json)
    for EIDX in $(seq 0 $((ENV_COUNT - 1))); do
      EVAR=$(jq -r ".resources[$IDX].env_required[$EIDX]" .sandcastle/resources.json)
      if [[ -z "${!EVAR:-}" ]]; then
        # Try to source from .sandcastle/.env as fallback.
        if [[ -f .sandcastle/.env ]]; then
          EVAL=$(grep -E "^${EVAR}=" .sandcastle/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
          if [[ -n "$EVAL" ]]; then
            export "$EVAR=$EVAL"
            continue
          fi
        fi
        ENV_MISSING+=("$EVAR")
      fi
    done

    if [[ ${#ENV_MISSING[@]} -gt 0 ]]; then
      if [[ "$R_POLICY" == "mandatory" ]]; then
        echo "  ✗ $R_NAME ($R_TYPE) [mandatory] — missing env: ${ENV_MISSING[*]}"
        RESOURCES_FAILED+=("$R_NAME: missing env ${ENV_MISSING[*]}")
      else
        echo "  ⚠ $R_NAME ($R_TYPE) [optional] — missing env: ${ENV_MISSING[*]} (skipping probe)"
        RESOURCES_OPTIONAL_FAILED+=("$R_NAME")
      fi
      continue
    fi

    # Run probe.
    if bash -c "$R_PROBE" 2>/tmp/probe-err-$R_NAME; then
      echo "  ✓ $R_NAME ($R_TYPE) reachable"
      # If introspect command exists, cache its output for Level 3.
      if [[ -n "$R_INTROSPECT" ]]; then
        if bash -c "$R_INTROSPECT" >".sandcastle/probes/${R_NAME}.schema" 2>/dev/null; then
          echo "      schema introspected -> .sandcastle/probes/${R_NAME}.schema"
        fi
      fi
    else
      ERR=$(cat /tmp/probe-err-$R_NAME 2>/dev/null | head -3)
      if [[ "$R_POLICY" == "mandatory" ]]; then
        echo "  ✗ $R_NAME ($R_TYPE) [mandatory] — probe FAILED: $ERR"
        RESOURCES_FAILED+=("$R_NAME: $ERR")
      else
        echo "  ⚠ $R_NAME ($R_TYPE) [optional] — probe failed: $ERR"
        RESOURCES_OPTIONAL_FAILED+=("$R_NAME")
      fi
    fi
    rm -f /tmp/probe-err-$R_NAME
  done

  if [[ ${#RESOURCES_FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "✗ ABORT: ${#RESOURCES_FAILED[@]} mandatory resource(s) failed pre-flight."
    echo "  Containers would mock these and produce false-green tests. Fix before retry:"
    for F in "${RESOURCES_FAILED[@]}"; do echo "    - $F"; done
    echo ""
    echo "  Edit .sandcastle/.env or .sandcastle/resources.json then re-run."
    exit 1
  fi

  # Persist the list of mandatory resource names so the agent prompt can reference them.
  jq -r '.resources[] | select(.policy == "mandatory") | .name' .sandcastle/resources.json \
    > .sandcastle/probes/.mandatory-resources
  echo "✓ Level 1 probes passed (mandatory: $(wc -l < .sandcastle/probes/.mandatory-resources | tr -d ' '), optional skipped: ${#RESOURCES_OPTIONAL_FAILED[@]})"
else
  echo "⚠ no .sandcastle/resources.json — agents may mock external resources without detection."
  echo "  Recommended: copy .sandcastle/resources.json.example and declare your DBs/APIs/queues."
fi

# Detectar base branch (HEAD donde estamos parados) y slug para naming.
# Soporta feature branches y worktrees — el dispatch parte desde HEAD y los
# PRs se abren contra esa misma branch (no hardcoded a main).
export SANDCASTLE_BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
export SANDCASTLE_BASE_BRANCH_SLUG=$(echo "$SANDCASTLE_BASE_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
echo "✓ base branch detected: $SANDCASTLE_BASE_BRANCH (slug: $SANDCASTLE_BASE_BRANCH_SLUG)"

# Warning si hay otro worktree del mismo repo con PIDs vivos en .sandcastle/logs/
# (puede indicar dispatch simultáneo, riesgo de colisión en branches/PRs).
GIT_COMMON_DIR=$(git rev-parse --git-common-dir)
OTHER_WORKTREES=$(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep -v "^$(git rev-parse --show-toplevel)$" || true)
if [[ -n "$OTHER_WORKTREES" ]]; then
  for wt in $OTHER_WORKTREES; do
    if ls "$wt/.sandcastle/logs/issue-"*.pid 2>/dev/null | head -1 >/dev/null; then
      echo "⚠ WARNING: worktree $wt has active dispatch PIDs in .sandcastle/logs/"
      echo "  Two dispatches in parallel on the same repo can collide on branch names"
      echo "  if both target the same issue. Consider waiting or using --issues to disambiguate."
    fi
  done
fi
```

**Important for Claude (the AI executing this command):** all the steps below — dep graph reading (Step 1), preview (Step 2), per-issue preparation (Step 4), launch loop (Step 5), monitor (continuation of Step 5) — must inherit the recovered env vars. The simplest way is to chain pre-flight + read + preview into one Bash call, then chain prep + launch + monitor into another Bash call (or all into one big `bash -c`). Do NOT call Bash 12 times for 12 steps — env vars will reset between calls.

If any check fails, **stop** and print the actionable instructions printed by the script itself.

## Step 1 — Read dependency graph

Query the GH issue tracker for issues that are ready for agent work:

```bash
# Acepta ambas convenciones de label: flat (`ready-for-agent`) y namespaced (`state/ready-for-agent`).
# La sintaxis comma-OR del search de GitHub matchea cualquiera de los dos labels en el mismo qualifier.
gh issue list \
  --state open \
  --search 'label:"ready-for-agent","state/ready-for-agent"' \
  --json number,title,body,labels \
  --limit 100
```

For each returned issue:
1. Parse the `## Blocked by` section in `body`. Each `#N` reference is a dep.
2. For each dep `#N`, query `gh issue view N --json state,closedAt`. If `state == 'CLOSED'`, dep is met.
3. Also check via `gh pr list --search "fixes #X OR closes #X"` whether a PR for THIS issue is already open. If yes, skip (a previous dispatch is in flight).

Compute three buckets:
- **Eligible** (this wave): all deps closed AND no open PR for this issue.
- **Blocked** (waiting on upstream): at least one dep still open. Show which.
- **Skipped** (need input): has label `agent-blocked` (a previous dispatch flagged the brief as ambiguous).

## Step 2 — Show preview

Print a structured preview:

```
Wave detected (N issues, all deps merged):

  #2  F2 — Primitives library            (deps: none)            [first try]
  #5  F5 — Org context resolver          (deps: none)            [retry — was stuck]

Issues blocked (waiting for upstream):
  #6  F6 — Plan limits enforcer          (waiting on #5)
  #10 VS4 — Lista v2                     (waiting on #2)

Issues SKIPPED (require your input first):
  #14 VS8 — agent-blocked: brief unclear about share token expiry behavior

Image: $IMAGE_NAME  ·  Mode: parallel  ·  Concurrency: N (natural wave size)

Launch wave? [y/N/select <issue numbers comma-separated>]:
```

`[first try]` vs `[retry — was X]` is determined by the presence of labels `agent-stuck` / `agent-crashed` (see Step 5).

## Step 3 — User confirmation

Wait for user input:
- `y` or `Y` → launch the entire eligible set.
- `N` or empty → abort, do nothing.
- `select 2,5` (or `2,5`) → launch only those issues from the eligible list.
- Anything else → re-prompt.

## Step 4 — Per-issue preparation

For each issue in the launch set, do these BEFORE launching anything:

1. **Extract the brief.** Run:
   ```bash
   gh api repos/$REPO/issues/$N/comments \
     --jq '[.[] | select(.body | contains("## Agent Brief"))] | last | .body'
   ```
   This gets the LATEST `## Agent Brief` comment (per the single-brief invariant from engineering-workflow v2.1.0). If no brief exists, abort with error: "issue #N has no Agent Brief comment. Run /triage on it first."

2. **Compose `prompt.md` for this issue.** Write to `.sandcastle/prompts/issue-N.md` using the template below. Mkdir `-p` `.sandcastle/prompts/` if needed.

3. **Verify base branch is up to date.** The base branch was detected in pre-flight (`$SANDCASTLE_BASE_BRANCH` — whatever HEAD pointed at when dispatch was invoked, supports feature branches and worktrees). Fetch its remote tip:
   ```bash
   git fetch origin "$SANDCASTLE_BASE_BRANCH"
   ```
   Sandcastle will create `agent/${SANDCASTLE_BASE_BRANCH_SLUG}/issue-${N}` from HEAD inside the container (HEAD = the base branch you're on). If that branch already exists locally OR remotely, **delete it first** (this is a retry path):
   ```bash
   AGENT_BRANCH="agent/${SANDCASTLE_BASE_BRANCH_SLUG}/issue-$N"
   git branch -D "$AGENT_BRANCH" 2>/dev/null || true
   git push origin --delete "$AGENT_BRANCH" 2>/dev/null || true
   ```

### Per-issue `prompt.md` template

```markdown
You are an AFK Claude Code agent working on a GitHub issue inside a Sandcastle Docker container.

## Issue context

- **Repo:** {{REPO}}
- **Issue:** #{{N}} — {{TITLE}}
- **Branch:** {{BRANCH}} (Sandcastle created this from `{{BASE_BRANCH}}`)
- **Base for PR:** {{BASE_BRANCH}}

## Your contract

The block below is the durable contract for this work. The original
issue body and discussion are context only — this brief is the contract.

---

{{BRIEF_INLINE}}

---

## Reading order

1. `CLAUDE.md` (auto-loaded by Claude Code) — repo conventions, stack, architecture.
2. The contract above.
3. `docs/phase1-decisions.md` — IF the brief mentions a P-decision (e.g. "see P11"),
   open this file and read the relevant section before implementing.
4. Explore the codebase as needed. Use the project's CONTEXT.md vocabulary.

## What you must do

0. **Reality check (BLOCKING — do this before touching code).** Open `.sandcastle/resources.json` if it exists.

   For each resource with `policy: mandatory`:

   a. **Level 2 — Connectivity from inside the container.** Run the resource's `connectivity_probe`. Networking from host vs container can differ (DNS, firewalls, container-only env). If the probe fails here even though the dispatcher's Level 1 probe passed, it's still a hard block:
      ```bash
      gh issue comment {{N}} --body "@LeopoldoBini blocked: resource '<name>' unreachable from container. Probe error: <error>. The dispatcher (host) could reach it, the container can't. Likely networking/DNS issue."
      gh issue edit {{N}} --add-label agent-blocked
      ```
      Then emit:
      ```
      <promise>BLOCKED</promise>
      <block-reason>RESOURCE_UNREACHABLE</block-reason>
      ```
      Do NOT proceed to step 1.

   b. **Level 3 — Schema diff against brief.** If `.sandcastle/probes/<name>.schema` exists (cached by host pre-flight), re-run the resource's `schema_introspect` from inside the container and diff vs the brief's assumptions:
      - Extract every reference in the brief (sección "Your contract" arriba) to tables, columns, endpoints, topics, bucket keys, etc.
      - For each reference: confirm it exists in the introspected schema.
      - Build a mismatch list: missing tables, renamed columns, type changes, missing endpoints.
      - If the mismatch list is non-empty:
        ```bash
        gh issue comment {{N}} --body "@LeopoldoBini blocked: schema mismatch between brief and real <resource>. Detail:
        - Brief mentions \`users.email_address\` but real schema has \`users.email\` (typo?)
        - Brief mentions table \`orders\` but real schema has no such table
        - <etc>"
        gh issue edit {{N}} --add-label agent-blocked
        ```
        Then emit:
        ```
        <promise>BLOCKED</promise>
        <block-reason>SCHEMA_MISMATCH</block-reason>
        ```
        Do NOT attempt to "fix" the brief by guessing the correct column — that's the human's call.

   c. **NEVER mock a mandatory resource.** If `.sandcastle/probes/.mandatory-resources` lists a resource, you MUST exercise tests against the real resource. Substituting a mock, fixture, or in-memory double for a mandatory resource is a contract violation — emit BLOCKED with `<block-reason>RESOURCE_UNREACHABLE</block-reason>` rather than mocking.

   Only after all mandatory resources pass Level 2 + Level 3 do you proceed to step 1.

1. **Install dependencies inside the container.** The bind-mounted workspace does NOT include `node_modules` (host-built artifacts wouldn't work cross-platform anyway). Detect the package manager from lockfiles and install with the frozen-lockfile flag so you get the exact versions the repo expects:
   - `pnpm-lock.yaml` present → `pnpm install --frozen-lockfile`
   - `bun.lockb` or `bun.lock` present → `bun install --frozen-lockfile`
   - `yarn.lock` present → `yarn install --frozen-lockfile`
   - `package-lock.json` present → `npm ci`

   This usually takes 1-5 minutes for large repos; it's a one-time cost per dispatch.

2. **Implement the contract via red-green-reality-first.** Each acceptance criterion is implemented as a tracer bullet against the REAL mandatory resources (no mocks). For each criterion in the brief, in order:

   **RED.** Write ONE test that exercises the behavior of this criterion. The test MUST hit the real resource (DB, API, queue) declared `mandatory` in `.sandcastle/resources.json`. No `jest.mock`, no `vi.mock`, no `Mock.Of`, no in-memory doubles, no fixtures-pretending-to-be-real. If the only data path this criterion exercises is a mandatory resource, you MUST go through it.

   Run the test. It MUST fail.

   - If it passes without any implementation, the test is a no-op (asserts something trivially true, doesn't actually exercise the resource, or the behavior already exists somewhere). STOP and emit `<promise>BLOCKED</promise>` + `<block-reason>TEST_NOOP</block-reason>` with a comment explaining which criterion couldn't be reduced to a failing test.
   - If it fails for the wrong reason (resource unreachable mid-test, syntax error, fixture missing), fix the test setup before proceeding — do NOT continue to GREEN.

   **GREEN.** Write the MINIMUM code to make this one test pass against the real resource. Do not anticipate future criteria. Do not add behavior the test doesn't demand.

   Run the test. It MUST pass.

   Commit with a message linking the criterion: `feat(#{{N}}): <criterion summary>`.

   Move on to the next criterion. Repeat RED → GREEN until every criterion in the brief has a passing test against real resources.

   **Vertical, not horizontal.** Do NOT write all tests first then all code. Do NOT write all code first then add tests. One test, one impl, one commit — that order — per criterion. The slice is still vertical (schema → API → UI → tests is fine as the SHAPE of one tracer bullet), but the loop is one criterion at a time.

   Optional resources (policy: optional in resources.json) MAY be mocked if necessary, but prefer real where possible. Mandatory resources NEVER.
3. **Run the project's checks locally inside the container before committing.** Use whichever scripts the repo actually defines (read `package.json`'s `scripts` section); typical commands per package manager:
   - **pnpm:** `pnpm tsc --noEmit`, `pnpm test:run` (Vitest CI mode) or `pnpm test`, plus any `lint`/`analyze-changed` scripts the project exposes.
   - **bun:** `bun run typecheck` (or `tsc --noEmit`), `bun test`, plus `bun run typecheck:ui` / `bun run test:ui` if the project has them.
   - **yarn/npm:** the equivalent `yarn`/`npm run <script>` invocations.

   If a check fails, FIX it — do not commit failing code. If a script doesn't exist in the repo, skip it (don't invent commands).
4. Commit your work to the current branch (`{{BRANCH}}`) with conventional-commit style messages.
5. **Self-check vs brief antes de abrir el PR.** Esto NO es opcional — es la última oportunidad de detectar que falta algo antes de que el revisor externo lo encuentre:
   1. Re-leé el brief original (sección "Your contract" arriba).
   2. Listá los criterios de aceptación uno por uno.
   3. Para cada criterio, decidí explícitamente:
      - **Cubierto por código** → marcalo `[x]` y citá el archivo/función concreta.
      - **Cubierto por tests** → marcalo `[x]` y citá el test concreto.
      - **No cubierto** → decidí:
         a. Si es chico y claro, implementalo ahora (commit adicional al mismo branch).
         b. Si es ambiguo o requiere clarificación del usuario, emitir `<promise>BLOCKED</promise>` con `<block-reason>BRIEF_AMBIGUOUS</block-reason>` (ver "Completion signals" abajo).
   4. Solo procedé a `gh pr create` si **todos** los criterios están `[x]` o explícitamente excluidos en una sección "Out of scope" del brief.

   Anotá el resultado de este self-check en el cuerpo del PR (paso 6) para que el revisor tenga el rastro.

6. Open a PR:
   ```bash
   gh pr create \
     --base {{BASE_BRANCH}} \
     --head {{BRANCH}} \
     --title "feat(#{{N}}): <one-line summary>" \
     --body "Closes #{{N}}.

     <Summary of what you implemented and why>

     ### Acceptance criteria
     <Copy each criterion from the brief, mark [x] if implemented>

     🤖 Generated by Sandcastle AFK agent."
   ```
   Add the label `afk-agent-pr` to the PR so the auto-merge workflow recognizes it:
   ```bash
   gh pr edit <PR_NUMBER> --add-label afk-agent-pr
   ```
7. Comment on the issue with a short summary + PR link:
   ```bash
   gh issue comment {{N}} --body "Implemented by AFK agent. PR: <link>. Acceptance criteria: <N/N>."
   ```

## Completion signals (REQUIRED)

End your run with EXACTLY one of these tokens. The dispatcher reads them to determine outcome:

- `<promise>COMPLETE</promise>` — you implemented the contract, opened a PR, commented on the issue. CI will decide auto-merge per its tier rules.
- `<promise>BLOCKED</promise>` — you cannot complete the contract. Include a subtype indicating why:
  - `<block-reason>BRIEF_AMBIGUOUS</block-reason>` — the brief is unclear, missing detail, or has contradictions. The reviewer can re-clarify and re-dispatch.
  - `<block-reason>CODEBASE_UNEXPECTED</block-reason>` — the codebase state doesn't match what the brief assumed (missing module, broken existing code, dep that doesn't exist).
  - `<block-reason>DEPENDENCY_MISSING</block-reason>` — work depends on something not yet merged (a sibling PR, an external service not deployed).
  - `<block-reason>RESOURCE_UNREACHABLE</block-reason>` — a mandatory resource declared in `.sandcastle/resources.json` failed Level 2 (container connectivity) probe. The host could reach it but the container cannot — likely networking, DNS, firewall, or missing credentials in `agentEnv`.
  - `<block-reason>SCHEMA_MISMATCH</block-reason>` — a mandatory resource is reachable but its actual schema does not match what the brief assumes (missing column, renamed table, wrong endpoint shape). Brief or migration is out of sync with reality. Human investigation needed — do NOT guess corrections.
  - `<block-reason>TEST_NOOP</block-reason>` — during red-green-reality-first you wrote a test that PASSED before any implementation existed. This means the test is a no-op (asserts something trivial, or doesn't exercise the data path it claims to). Re-think the test against the real resource and BLOCK if you cannot make it fail correctly.

  **Before printing this, you MUST**:
  1. `gh issue comment {{N}} --body "@LeopoldoBini blocked: <reason>. Need clarification on <X>."`
  2. `gh issue edit {{N}} --add-label agent-blocked`
  Then output the BLOCKED block with the subtype, e.g.:
  ```
  <promise>BLOCKED</promise>
  <block-reason>BRIEF_AMBIGUOUS</block-reason>
  ```
- (no token) — your run will time out as `agent-stuck`. Don't do this. If you're truly stuck after best effort, use BLOCKED.

## Anti-patterns (do not do these)

- Do not edit files unrelated to the contract.
- Do not modify CI workflows or repo-wide config unless the brief explicitly asks.
- Do not push to `{{BASE_BRANCH}}` directly — only to `{{BRANCH}}`.
- Do not skip tests with `--no-verify` or `it.skip()` to make CI pass.
- Do not invent API endpoints or types not described in the brief or implied by `CONTEXT.md`.
- **Do not mock any resource declared `mandatory` in `.sandcastle/resources.json`.** If you cannot reach the real resource, emit `<promise>BLOCKED</promise>` with `<block-reason>RESOURCE_UNREACHABLE</block-reason>` — never substitute a mock to "make the test green".
- **Do not guess corrections for schema mismatches.** If the brief says `users.email_address` and the real schema has `users.email`, BLOCK with `SCHEMA_MISMATCH`. Do not silently rename in your code — the brief may be right and the migration missing, or the brief may be stale and need to be edited. Human's call.
- **Do not write tests that pass before the implementation exists.** If your "RED" test passes without code, it's a no-op. Re-design the test or BLOCK with `TEST_NOOP`.
- **Do not batch tests.** Anti-horizontal: never write all tests for the brief first then all implementation. One criterion = one RED → one GREEN → one commit.
```

When generating this file, substitute:
- `{{REPO}}` → whatever `gh repo view --json nameWithOwner --jq .nameWithOwner` resolves to
- `{{N}}` → issue number
- `{{TITLE}}` → issue title from the GH API
- `{{BRANCH}}` → `agent/${SANDCASTLE_BASE_BRANCH_SLUG}/issue-${N}` (namespaced by base branch to avoid collisions across worktrees)
- `{{BASE_BRANCH}}` → `$SANDCASTLE_BASE_BRANCH` (detected in pre-flight; supports feature branches)
- `{{BRIEF_INLINE}}` → the entire body of the latest `## Agent Brief` comment

## Step 5 — Launch in parallel

For each issue in the launch set, kick off a background process. Use Bash subshell with env-var injection:

```bash
mkdir -p .sandcastle/logs
for N in $LAUNCH_SET; do
  ISSUE_PROMPT=".sandcastle/prompts/issue-${N}.md"
  ISSUE_BRANCH="agent/${SANDCASTLE_BASE_BRANCH_SLUG}/issue-${N}"
  LOG=".sandcastle/logs/issue-${N}-$(date +%Y%m%d-%H%M%S).log"
  (
    SANDCASTLE_ISSUE_NUMBER="$N" \
    SANDCASTLE_BRANCH="$ISSUE_BRANCH" \
    SANDCASTLE_BASE_BRANCH="$SANDCASTLE_BASE_BRANCH" \
    SANDCASTLE_PROMPT_FILE="$ISSUE_PROMPT" \
      "${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/.bin/tsx" \
      "${CLAUDE_PLUGIN_ROOT}/runtime/main.mts" > "$LOG" 2>&1 &
    echo $! > ".sandcastle/logs/issue-${N}.pid"
  )
done
```

Then enter monitor mode:
- Every 30s, check `docker info` to detect daemon failures (Q11 wave-fatal).
- Every 30s, list still-running PIDs from `.sandcastle/logs/issue-*.pid`.
- For each completed PID, parse the tail of its log for `<promise>COMPLETE</promise>` or `<promise>BLOCKED</promise>` or `AgentIdleTimeoutError` or other.
- If the log contains a `<promise>BLOCKED</promise>` token, also parse the accompanying `<block-reason>...</block-reason>` (one of `BRIEF_AMBIGUOUS`, `CODEBASE_UNEXPECTED`, `DEPENDENCY_MISSING`); record it in the wave report so downstream tooling (merge-wave, retry logic) can route the issue.
- Apply the outcome:
  - `COMPLETE` + PR opened → ✓
  - `BLOCKED` → already commented + `agent-blocked` label applied by the agent. Additionally apply a subtype label based on `<block-reason>`:
    - `BRIEF_AMBIGUOUS` → label `agent-blocked-rebrief` (merge-wave/triage will re-clarify and re-dispatch)
    - `CODEBASE_UNEXPECTED` or `DEPENDENCY_MISSING` → label `agent-blocked-codebase` (human investigation needed)
    - `RESOURCE_UNREACHABLE` → label `agent-blocked-resource` (fix networking, credentials, or `env_required` in `.sandcastle/resources.json`; do NOT re-dispatch until host AND container can probe the resource)
    - `SCHEMA_MISMATCH` → label `agent-blocked-schema` (brief vs reality is out of sync; either update the brief to match the real schema or run the missing migration; never re-dispatch without resolving)
    - `TEST_NOOP` → label `agent-blocked-noop` (the agent could not write a test that fails before implementation against the real resource; likely brief is too vague to test, or the resource introspect doesn't expose what the test needs)
    - If no subtype emitted → label `agent-blocked-unknown` and prompt user to inspect logs
  - idle timeout (`AgentIdleTimeoutError`) → `gh issue edit N --add-label agent-stuck` + `gh issue comment N --body "Agent idle-timed out. Inspect logs at $LOG. Re-run /sandcastle-dispatch-wave to retry."`
  - non-zero exit without COMPLETE/BLOCKED → `gh issue edit N --add-label agent-crashed` + `gh issue comment N --body "Agent crashed. Inspect logs at $LOG."`

If `docker info` fails during the wave, this is wave-fatal:
- `docker stop` all running containers from the launch set.
- Print "WAVE-FATAL: docker daemon error. Aborting siblings."
- Apply `agent-aborted` label to in-flight issues with a comment.

## Step 6 — Final report

When all PIDs have exited (success or failure), print:

```
Wave summary (3/4 success, 1 blocked):

  #2  ✓  PR #45 opened, CI in progress, holding for manual review (slice/foundation)
  #5  ✓  PR #46 opened, CI in progress, holding for manual review (slice/foundation)
  #6  ✗  BLOCKED — see issue comment + agent-blocked label
  #10 ✓  PR #47 opened, CI in progress, will auto-merge on green (VS slice)

Logs: .sandcastle/logs/issue-*-<timestamp>.log
Next wave: re-run /sandcastle-dispatch-wave after CI completes / you merge foundation PRs.
```

Save a structured wave report to `.sandcastle/wave-reports/<timestamp>.json` for postmortem.

## Cleanup

After the wave finishes, remove `.sandcastle/logs/issue-*.pid` files (PIDs no longer valid). Keep the `.log` and `prompts/` files for debugging.

## Arguments

- `--issues <list>` — explicit launch set, skipping detection (e.g. `--issues 2,5`). Useful when you want to override the dep graph.
- `--max-parallel <N>` — cap concurrency to N (default: launch all eligible). Useful if your sv resources are limited.
- `--dry-run` — do everything except actually launching containers. Print the prompt files, the env vars, the docker commands. Useful for verifying brief extraction.
- `--no-confirm` — skip the y/N prompt, launch immediately. Use only in scripts.

## Notes for future maintainers

This command is the user-facing entry to AFK execution. It depends on:

- **engineering-workflow plugin (>=2.1.0)** — `/triage` and `/agent-brief` enforce the single-brief invariant. If a project uses an older version, this dispatcher MAY pick the wrong brief. Verify before deploying.
- **`docs/phase1-decisions.md`** (project-specific) — referenced from briefs via P-anchors. The dispatcher does NOT inline this file; the agent reads it on-demand inside the container per the prompt's reading order. If the file path differs in another project, the prompt template should be parameterized.
- **`afk-agent-pr` label** — applied by the agent to its PR, recognized by `.github/workflows/afk-automerge.yml` to determine auto-merge eligibility per Q8 tier rules.

If Sandcastle's underlying behavior changes (new version, new flags), the `branchStrategy: { type: 'branch', branch: ... }` shape may need updating. See the `sandcastle-afk` skill for grep targets in the Sandcastle source.

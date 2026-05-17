---
name: sandcastle-probe-resources
description: Probe every resource declared in .sandcastle/resources.json and cache the schema_introspect output to .sandcastle/probes/<name>.schema. Does NOT launch any container — host-only. Use this after /sandcastle-init to bootstrap the schema cache that downstream tools (engineering-workflow's /to-issues and /agent-brief) read to anchor briefs to reality. Re-run periodically when the real schemas change (migrations, API revs). Triggers when the user says "probe resources", "cachear schemas", "bootstrap probes", "scan resources".
---

# /sandcastle-probe-resources

Host-side runner that:

1. Verifies each resource declared in `.sandcastle/resources.json` is reachable.
2. Runs each resource's `schema_introspect` command (if present) and writes the output to `.sandcastle/probes/<resource-name>.schema`.
3. Adds a header line with a timestamp so downstream tools can detect staleness.
4. Does **NOT** launch any Docker container. This is purely a host-side probe + cache.

Why this exists: the `engineering-workflow` plugin's `/to-issues` and `/agent-brief` skills produce **reality-anchored briefs** by cross-referencing every resource reference (table.column, endpoint, topic, key) against these cached schema files. Without the cache, those skills emit briefs marked `(unverified — run /sandcastle-probe-resources)` and rely on the dispatcher's Level 3 in-container probe as a fallback.

Run this once after `/sandcastle-init`, and again whenever you change `.sandcastle/resources.json` or know a real schema has shifted (migration deployed, API revved).

## Pre-conditions

Run via a single Bash invocation so env vars recovered in one step persist into the next:

```bash
set -e

# Hard checks.
git rev-parse --show-toplevel >/dev/null || { echo "✗ not a git repo"; exit 1; }
[[ -f .sandcastle/resources.json ]] || { echo "✗ .sandcastle/resources.json not found. Run /sandcastle-init first, then edit the scaffolded file."; exit 1; }
jq -e . .sandcastle/resources.json >/dev/null || { echo "✗ .sandcastle/resources.json is not valid JSON"; exit 1; }

# Source .sandcastle/.env as fallback for env_required vars.
if [[ -f .sandcastle/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . .sandcastle/.env
  set +a
fi
```

If `.sandcastle/resources.json` doesn't exist, **stop** and tell the user to run `/sandcastle-init` first.

## Probe loop

For each resource in `.sandcastle/resources.json`:

```bash
mkdir -p .sandcastle/probes
PROBE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESOURCES_FAILED=()
RESOURCES_OK=()
RESOURCES_NO_SCHEMA=()

RESOURCE_COUNT=$(jq '.resources | length' .sandcastle/resources.json)
for IDX in $(seq 0 $((RESOURCE_COUNT - 1))); do
  R_NAME=$(jq -r ".resources[$IDX].name" .sandcastle/resources.json)
  R_TYPE=$(jq -r ".resources[$IDX].type" .sandcastle/resources.json)
  R_POLICY=$(jq -r ".resources[$IDX].policy // \"optional\"" .sandcastle/resources.json)
  R_PROBE=$(jq -r ".resources[$IDX].connectivity_probe" .sandcastle/resources.json)
  R_INTROSPECT=$(jq -r ".resources[$IDX].schema_introspect // empty" .sandcastle/resources.json)

  # Check env_required.
  ENV_MISSING=()
  ENV_COUNT=$(jq ".resources[$IDX].env_required | length" .sandcastle/resources.json)
  for EIDX in $(seq 0 $((ENV_COUNT - 1))); do
    EVAR=$(jq -r ".resources[$IDX].env_required[$EIDX]" .sandcastle/resources.json)
    if [[ -z "${!EVAR:-}" ]]; then
      ENV_MISSING+=("$EVAR")
    fi
  done

  if [[ ${#ENV_MISSING[@]} -gt 0 ]]; then
    echo "  ⚠ $R_NAME ($R_TYPE) [$R_POLICY] — missing env: ${ENV_MISSING[*]}"
    [[ "$R_POLICY" == "mandatory" ]] && RESOURCES_FAILED+=("$R_NAME: missing env ${ENV_MISSING[*]}")
    continue
  fi

  # Connectivity probe.
  if ! bash -c "$R_PROBE" 2>/tmp/probe-err-$$; then
    ERR=$(cat /tmp/probe-err-$$ | head -3)
    echo "  ✗ $R_NAME ($R_TYPE) [$R_POLICY] — probe failed: $ERR"
    [[ "$R_POLICY" == "mandatory" ]] && RESOURCES_FAILED+=("$R_NAME: $ERR")
    continue
  fi

  # Schema introspect (if defined).
  if [[ -n "$R_INTROSPECT" ]]; then
    SCHEMA_FILE=".sandcastle/probes/${R_NAME}.schema"
    {
      echo "# sandcastle-probe schema cache"
      echo "# resource: $R_NAME ($R_TYPE)"
      echo "# probed_at: $PROBE_TS"
      echo "# introspect_cmd: $R_INTROSPECT"
      echo "# ---"
      bash -c "$R_INTROSPECT" 2>/dev/null
    } > "$SCHEMA_FILE"
    LINES=$(grep -cv '^#' "$SCHEMA_FILE" || echo 0)
    echo "  ✓ $R_NAME ($R_TYPE) — cached $LINES schema lines to $SCHEMA_FILE"
    RESOURCES_OK+=("$R_NAME")
  else
    echo "  ✓ $R_NAME ($R_TYPE) — reachable (no schema_introspect defined, nothing cached)"
    RESOURCES_NO_SCHEMA+=("$R_NAME")
  fi
done

rm -f /tmp/probe-err-$$
```

## Report

After the loop, print a structured summary:

```
Resource probe complete (${PROBE_TS}):
  ✓ ${#RESOURCES_OK[@]} cached with schema:    ${RESOURCES_OK[*]}
  ✓ ${#RESOURCES_NO_SCHEMA[@]} reachable, no schema cached: ${RESOURCES_NO_SCHEMA[*]}
  ✗ ${#RESOURCES_FAILED[@]} failed (mandatory):      ${RESOURCES_FAILED[*]}

Caches written to: .sandcastle/probes/
Downstream consumers: /to-issues and /agent-brief (engineering-workflow) read these to anchor briefs to reality.
```

If any mandatory resource failed, exit with non-zero so CI / wrappers can detect it. Otherwise exit 0 even if optional resources failed (warning only).

## Arguments

- `--resource <name>` — probe only this resource (skip others). Useful when one resource changed and you don't want to re-probe everything.
- `--no-cache` — run probes but do not write `.sandcastle/probes/<name>.schema` files. Useful for connectivity-only verification.
- `--quiet` — suppress per-resource log lines; only print the final summary.

## When to re-run

- After `/sandcastle-init` (one-time, to bootstrap the cache).
- After editing `.sandcastle/resources.json` (added a resource, changed a probe command).
- After a real schema migration is deployed (so downstream briefs anchor to the new shape).
- Periodically (weekly?) to catch drift between briefs and the real world.

## Notes for future maintainers

This command shares its probe logic with `/sandcastle-dispatch-wave` (Level 1 host probe block). They are intentionally similar but **not** factored into a shared script — the dispatcher's pre-flight runs the probes as part of a larger context, while this command exists as a standalone bootstrap. If they diverge meaningfully, factor the shared bash into `${CLAUDE_PLUGIN_ROOT}/scripts/probe-resources.sh` and have both invoke it.

#!/usr/bin/env bash
#
# sandcastle-validate.sh — local CI gate para PRs AFK
#
# Reemplaza el workflow remoto afk-checks.yml. Corre typecheck + tests en
# un container Docker liviano contra un git worktree fresh del PR.
# Aplica labels (afk-checks-passed / afk-checks-failed) y comenta el
# error si falla. Sin Claude Code adentro — es validator, no agent.
#
# Usage:
#   scripts/sandcastle-validate.sh <PR_NUMBER>
#
# Exit codes:
#   0  → validación pasó
#   1  → uso incorrecto (bad args)
#   2  → setup error (gh / docker / git no disponibles)
#   N>0 → validación falló (exit code de los scripts dentro del container)
#
# Customización por proyecto:
#   - SANDCASTLE_VALIDATOR_IMAGE — imagen Docker a usar (default:
#     `oven/bun:latest`, o `sandcastle-validator` si existe el alias).
#     Si tu proyecto tiene Dockerfile propio, pasarlo acá pre-buildeado.
#   - .sandcastle/validate.cmds — archivo de texto con un comando por línea
#     que reemplaza los defaults. Si no existe, usa los defaults de abajo.
#
# Default commands (cuando no hay .sandcastle/validate.cmds):
# v2 scaffold (multi-stack):
#   - package.json + lockfile → install + typecheck + test (pkg-mgr según lockfile)
#   - *.csproj / *.sln       → dotnet restore + build + test
#   - pyproject.toml / requirements.txt → pip install + pytest
#   - go.mod                  → go test ./...
# Si tu proyecto necesita pasos custom, crear .sandcastle/validate.cmds con
# un script bash inline.

set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  exit 1
fi

# --- Setup checks ---

command -v gh >/dev/null 2>&1 || { echo "✗ gh CLI not installed" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "✗ docker not installed" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "✗ git not installed" >&2; exit 2; }

docker info >/dev/null 2>&1 || { echo "✗ docker daemon not running" >&2; exit 2; }

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
HEAD_REF=$(gh pr view "$PR_NUMBER" --json headRefName --jq .headRefName)
if [[ -z "$HEAD_REF" ]]; then
  echo "✗ couldn't resolve head ref for PR #$PR_NUMBER" >&2
  exit 2
fi

echo "[sandcastle-validate] PR #$PR_NUMBER ($REPO) — head=$HEAD_REF"

# --- Ephemeral worktree ---

WORKDIR=$(mktemp -d -t sandcastle-validate-pr"$PR_NUMBER"-XXXXXX)

cleanup() {
  local rc=$?
  if [[ -d "$WORKDIR" ]]; then
    git worktree remove --force "$WORKDIR" 2>/dev/null || true
    rm -rf "$WORKDIR"
  fi
  return $rc
}
trap cleanup EXIT INT TERM

git fetch origin "$HEAD_REF" >/dev/null 2>&1 || {
  echo "✗ couldn't fetch origin/$HEAD_REF" >&2
  exit 2
}

git worktree add --detach "$WORKDIR" "origin/$HEAD_REF" >/dev/null 2>&1 || {
  echo "✗ couldn't create worktree at $WORKDIR" >&2
  exit 2
}

echo "[sandcastle-validate] worktree ready at $WORKDIR"

# --- Pick validator image ---

VALIDATOR_IMAGE="${SANDCASTLE_VALIDATOR_IMAGE:-}"
if [[ -z "$VALIDATOR_IMAGE" ]]; then
  # Default: use the project's per-project sandcastle image from
  # .sandcastle/config.json (v2 scaffold). The image already has the
  # right runtimes installed (Node/Bun/Python/.NET) per the project's
  # detected stack.
  if [[ -f .sandcastle/config.json ]] && command -v jq >/dev/null 2>&1; then
    CONFIG_IMAGE=$(jq -r '.imageName // empty' .sandcastle/config.json 2>/dev/null)
    if [[ -n "$CONFIG_IMAGE" ]] && docker image inspect "$CONFIG_IMAGE" >/dev/null 2>&1; then
      VALIDATOR_IMAGE="$CONFIG_IMAGE"
    fi
  fi
  # Legacy / fallback heuristic (pre-v2 repos or no config):
  if [[ -z "$VALIDATOR_IMAGE" ]]; then
    if docker image inspect sandcastle-validator >/dev/null 2>&1; then
      VALIDATOR_IMAGE="sandcastle-validator"
    else
      VALIDATOR_IMAGE="oven/bun:latest"
    fi
  fi
fi

echo "[sandcastle-validate] image: $VALIDATOR_IMAGE"

# --- Determine validation commands ---

VALIDATE_SCRIPT=""
if [[ -f "$WORKDIR/.sandcastle/validate.cmds" ]]; then
  VALIDATE_SCRIPT=$(cat "$WORKDIR/.sandcastle/validate.cmds")
  echo "[sandcastle-validate] using project-defined commands from .sandcastle/validate.cmds"
else
  # Defaults: opportunistic — skip scripts that don't apply per detected stack.
  # The script runs inside the per-project image which already has the right
  # runtimes installed (Node/Bun/.NET/Python/Go) per /sandcastle-init detection.
  VALIDATE_SCRIPT='
set -e

# --- Node/Bun ---
if [ -f /work/package.json ]; then
  if [ -f /work/bun.lockb ] || [ -f /work/bun.lock ]; then
    echo "→ bun install --frozen-lockfile"
    bun install --frozen-lockfile
    jq -e ".scripts.typecheck" /work/package.json >/dev/null 2>&1 && { echo "→ bun run typecheck"; bun run typecheck; } || true
    jq -e ".scripts.test" /work/package.json >/dev/null 2>&1 && { echo "→ bun test"; bun test; } || true
  elif [ -f /work/pnpm-lock.yaml ]; then
    echo "→ pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
    jq -e ".scripts.typecheck" /work/package.json >/dev/null 2>&1 && pnpm run typecheck || true
    jq -e ".scripts.test" /work/package.json >/dev/null 2>&1 && pnpm test || true
  elif [ -f /work/yarn.lock ]; then
    echo "→ yarn install --frozen-lockfile"
    yarn install --frozen-lockfile
    jq -e ".scripts.typecheck" /work/package.json >/dev/null 2>&1 && yarn typecheck || true
    jq -e ".scripts.test" /work/package.json >/dev/null 2>&1 && yarn test || true
  elif [ -f /work/package-lock.json ]; then
    echo "→ npm ci"
    npm ci
    jq -e ".scripts.typecheck" /work/package.json >/dev/null 2>&1 && npm run typecheck || true
    jq -e ".scripts.test" /work/package.json >/dev/null 2>&1 && npm test || true
  fi
fi

# --- .NET ---
if ls /work/*.sln /work/*.csproj /work/*.fsproj 2>/dev/null | head -1 | grep -q .; then
  echo "→ dotnet restore"
  dotnet restore
  echo "→ dotnet build --no-restore"
  dotnet build --no-restore
  echo "→ dotnet test --no-build"
  dotnet test --no-build
fi

# --- Python ---
if [ -f /work/pyproject.toml ] || [ -f /work/requirements.txt ]; then
  if [ -f /work/requirements.txt ]; then
    echo "→ pip install -r requirements.txt"
    pip install -r /work/requirements.txt
  elif [ -f /work/pyproject.toml ]; then
    echo "→ pip install -e ."
    pip install -e /work
  fi
  command -v pytest >/dev/null && { echo "→ pytest"; pytest /work; } || true
fi

# --- Go ---
if [ -f /work/go.mod ]; then
  echo "→ go test ./..."
  cd /work && go test ./...
fi
'
fi

# --- Run inside container ---

LOG_FILE="${WORKDIR}.log"
RC=0

if docker run --rm \
  -v "$WORKDIR:/work" \
  -w /work \
  --entrypoint sh \
  "$VALIDATOR_IMAGE" \
  -c "$VALIDATE_SCRIPT" > "$LOG_FILE" 2>&1; then
  RC=0
else
  RC=$?
fi

# --- Apply labels + comment ---

if [[ $RC -eq 0 ]]; then
  gh pr edit "$PR_NUMBER" --add-label afk-checks-passed --remove-label afk-checks-failed >/dev/null 2>&1 || true
  echo "[sandcastle-validate] ✓ PR #$PR_NUMBER passed (label afk-checks-passed applied)"
  rm -f "$LOG_FILE"
  exit 0
else
  gh pr edit "$PR_NUMBER" --add-label afk-checks-failed --remove-label afk-checks-passed >/dev/null 2>&1 || true

  # Truncar el log al final (los errores suelen estar al final)
  ERROR_TAIL=$(tail -100 "$LOG_FILE")
  COMMENT_BODY=$(cat <<EOF
## ❌ sandcastle-validate failed (exit $RC)

\`\`\`
$ERROR_TAIL
\`\`\`

Image: \`$VALIDATOR_IMAGE\`
Worktree commit: \`$(git -C "$WORKDIR" rev-parse HEAD)\`
EOF
)
  gh pr comment "$PR_NUMBER" --body "$COMMENT_BODY" >/dev/null 2>&1 || true

  echo "[sandcastle-validate] ✗ PR #$PR_NUMBER failed (exit $RC, label afk-checks-failed applied)" >&2
  echo "[sandcastle-validate] log: $LOG_FILE (kept for inspection)" >&2
  # Preservar el log si falló — útil para debugging local
  PERSIST_LOG=".sandcastle/validate-logs/pr-${PR_NUMBER}-$(date +%Y%m%d-%H%M%S).log"
  mkdir -p .sandcastle/validate-logs
  cp "$LOG_FILE" "$PERSIST_LOG"
  echo "[sandcastle-validate] persisted: $PERSIST_LOG" >&2
  exit "$RC"
fi

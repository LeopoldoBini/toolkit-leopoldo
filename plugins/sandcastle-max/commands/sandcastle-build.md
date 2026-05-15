---
name: sandcastle-build
description: Build the per-project Sandcastle Docker image from .sandcastle/Dockerfile. Reads imageName from .sandcastle/config.json (set by /sandcastle-init). Auto-bootstraps the plugin runtime deps the first time. Triggers when the user says "sandcastle build", "build sandcastle image", "rebuild the agent image".
---

# /sandcastle-build

Build the Sandcastle Docker image for the current repo. The image is per-project (imageName = `sandcastle-<basename>`); each repo has its own.

## Steps

### 1. Pre-checks (run in parallel)

- `git rev-parse --show-toplevel` → store as `REPO`. Error if not in a git repo.
- `docker info --format '{{.ServerVersion}}'` — confirm Docker daemon is running.
- Verify `$REPO/.sandcastle/config.json` exists. If not, tell the user to run `/sandcastle-init` first.
- Verify `$REPO/.sandcastle/Dockerfile` exists. If not, tell the user to re-run `/sandcastle-init` (the Dockerfile is a regenerated artifact).

### 2. Bootstrap plugin runtime (one-time per machine)

If `${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/` is missing:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/runtime" && (bun install || npm install)
```

Tell the user this is a ~1-minute one-time install of `@ai-hero/sandcastle` + `tsx` inside the plugin (their repo never sees these deps).

### 3. Read config

```bash
IMAGE_NAME=$(jq -r '.imageName' "$REPO/.sandcastle/config.json")
DOCKERFILE=$(jq -r '.dockerfile // ".sandcastle/Dockerfile"' "$REPO/.sandcastle/config.json")
```

Error if `IMAGE_NAME` is `null` or empty.

### 4. Build

```bash
cd "$REPO" && "${CLAUDE_PLUGIN_ROOT}/runtime/node_modules/.bin/sandcastle" \
  docker build-image \
  --image-name "$IMAGE_NAME" \
  --dockerfile "$DOCKERFILE"
```

Stream the output. First build takes 2-5 min depending on which runtimes are in the Dockerfile (each runtime adds 30-60s of install time). Subsequent builds hit Docker layer cache.

### 5. Verify

```bash
docker image inspect "$IMAGE_NAME" --format '{{.Id}}' >/dev/null 2>&1
```

If success, print:

```
Built: <imageName> (runtimes: <list from config.runtimes>)
Next: /sandcastle-run  ← smoke test
```

If failure, print the last 20 lines of the build log and suggest re-running with `--no-cache` (set env `DOCKER_BUILDKIT_INLINE_CACHE=0` or re-run the build manually).

## Arguments

- `--no-cache` — force rebuild from scratch. Passes `--no-cache` to the Docker build.

## Notes

- The image lives in the local Docker daemon, not pushed to any registry.
- To clean up: `docker image rm <imageName>` or `docker image prune` for all unused.
- If you edit `.sandcastle/Dockerfile` directly, your changes are overwritten on the next `/sandcastle-init` run. Edit `.sandcastle/snippets/<name>.dockerfile` overrides instead, or `.sandcastle/snippets/extras.dockerfile` for ad-hoc additions.

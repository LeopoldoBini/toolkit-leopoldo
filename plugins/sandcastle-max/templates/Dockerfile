FROM node:22-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (needed by AFK agents to comment issues + open PRs)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Bun (most projects this targets use Bun for backend + scripts).
# Strip if your project uses npm/pnpm/yarn only.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Rename the base image's "node" user to "agent" (keeps UID 1000).
RUN usermod -d /home/agent -m -l agent node
USER agent

# Install Claude Code CLI as the agent user, then wipe ALL leftover state
# files from the installer that have restrictive perms (mode 600, owner agent
# UID 1000). Sandcastle runs the container with --user $HOST_UID:$HOST_GID
# (501 on macOS, 1000 on Linux), so agent-owned 600 files are unreadable as
# the host UID and cause silent hangs in `claude --print`. The binary symlink
# in ~/.local/bin survives — it points to ~/.local/share/claude/versions/<v>
# which has 755 perms.
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && rm -rf /home/agent/.claude /home/agent/.claude.json /home/agent/.cache/claude

ENV PATH="/home/agent/.local/bin:/usr/local/bin:$PATH"

WORKDIR /home/agent

# Sandcastle bind-mounts the worktree at ${SANDBOX_REPO_DIR} (=/home/agent/workspace)
# and runs the container as --user <hostUid>:<hostGid> so bind-mounted files
# keep correct ownership. Make /home/agent and its dot-dirs world-writable
# (sticky bit) so the host UID can write .gitconfig, .claude, .npm, etc. that
# tools expect under HOME at runtime.
USER root
RUN chmod 1777 /home/agent \
  && find /home/agent -mindepth 1 -maxdepth 2 -type d -exec chmod 1777 {} +
USER agent

ENTRYPOINT ["sleep", "infinity"]

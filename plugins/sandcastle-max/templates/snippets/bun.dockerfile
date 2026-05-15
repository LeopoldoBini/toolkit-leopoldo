# sandcastle-snippet
# name: bun
# role: runtime
# default-version: latest
# detect: bun.lockb, bun.lock

USER root
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

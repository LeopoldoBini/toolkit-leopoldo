# sandcastle-snippet
# name: agent
# role: agent

USER root
RUN useradd -u 1000 -m -s /bin/bash agent

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && rm -rf /home/agent/.claude /home/agent/.claude.json /home/agent/.cache/claude

ENV PATH="/home/agent/.local/bin:$PATH"

USER root
RUN chmod 1777 /home/agent \
  && find /home/agent -mindepth 1 -maxdepth 2 -type d -exec chmod 1777 {} +
USER agent

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]

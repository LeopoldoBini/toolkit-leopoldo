# sandcastle-snippet
# name: node
# role: runtime
# default-version: 22
# detect: package.json, .nvmrc

USER root
RUN curl -fsSL https://deb.nodesource.com/setup_{{VERSION}}.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

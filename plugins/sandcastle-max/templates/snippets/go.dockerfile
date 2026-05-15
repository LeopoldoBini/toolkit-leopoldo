# sandcastle-snippet
# name: go
# role: runtime
# default-version: 1.22.5
# detect: go.mod

USER root
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL https://go.dev/dl/go{{VERSION}}.linux-${ARCH}.tar.gz -o /tmp/go.tar.gz \
  && tar -C /usr/local -xzf /tmp/go.tar.gz \
  && rm /tmp/go.tar.gz
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPATH=/home/agent/go

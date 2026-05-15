# sandcastle-snippet
# name: ruby
# role: runtime
# default-version: 3.1
# detect: Gemfile, .ruby-version, Gemfile.lock

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby ruby-dev build-essential \
  && rm -rf /var/lib/apt/lists/*

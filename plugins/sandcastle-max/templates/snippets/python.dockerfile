# sandcastle-snippet
# name: python
# role: runtime
# default-version: 3.11
# detect: pyproject.toml, requirements.txt, Pipfile, poetry.lock, setup.py, .python-version

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python

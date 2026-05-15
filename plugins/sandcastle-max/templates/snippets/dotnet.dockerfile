# sandcastle-snippet
# name: dotnet
# role: runtime
# default-version: 8.0
# detect: *.csproj, *.sln, *.fsproj, global.json

USER root
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
  && chmod +x /tmp/dotnet-install.sh \
  && /tmp/dotnet-install.sh --channel {{VERSION}} --install-dir /usr/share/dotnet \
  && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
  && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH=$PATH:/usr/share/dotnet

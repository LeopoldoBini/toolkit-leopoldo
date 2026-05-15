# sandcastle-snippet
# name: rust
# role: runtime
# default-version: stable
# detect: Cargo.toml, Cargo.lock, rust-toolchain.toml

USER root
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain {{VERSION}} --no-modify-path \
    && cp /root/.cargo/bin/* /usr/local/bin/ \
    && rm -rf /root/.cargo /root/.rustup

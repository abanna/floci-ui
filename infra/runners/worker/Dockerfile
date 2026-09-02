# GitHub Actions ephemeral runner with rootless Podman/Buildah.
# Runs unprivileged on Cloudflare Containers (linux/amd64). No Docker daemon:
# dockerd + rootlesskit were tried (v13–v17) and are a dead end here — CF blocks
# /dev/net/tun (no vpnkit/slirp) and iptables. User namespaces DO work on CF,
# so podman/buildah run directly as the container user; builds/containers use
# host networking by default (see containers.conf below).
ARG RUNNER_VERSION=2.337.0
# Plain version tags track the Ubuntu 24.04 image (no -ubuntu-24.04 variant tags).
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl jq podman buildah fuse-overlayfs uidmap build-essential \
        rsync zip unzip file xz-utils pigz gettext-base nodejs npm cargo rustc zstd \
    && rm -rf /var/lib/apt/lists/*
# Tool parity with GitHub-hosted Ubuntu runners: build-essential (CGO/-race Go
# tests need a C compiler — v21 missed it), rsync (agentisan-skills CI hit
# "rsync: command not found", exit 127 — v22 missed it), nodejs+npm (polyglot
# test suites detect package managers on PATH — v25 missed npm), cargo+rustc
# (project scorers auto-run cargo test on Rust worktrees — v26 missed it),
# plus common archive and text utilities workflows assume present.

# Go toolchain: hosted/Blacksmith runners preinstall Go; agentisan-skills'
# skill e2e tests invoke `go` directly and fail without it (v24 missed it).
# Installed at the RUNNER_TOOL_CACHE layout so actions/setup-go treats it as
# a warm cache hit (no 190MB download per Go job); /usr/local/go symlink
# keeps bare `go` on PATH for jobs that don't use setup-go.
ARG GO_VERSION=1.25.0
RUN set -eux; \
    mkdir -p /opt/hostedtoolcache/go/${GO_VERSION}/x64; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
      | tar -xz -C /opt/hostedtoolcache/go/${GO_VERSION}/x64 --strip-components=1; \
    touch /opt/hostedtoolcache/go/${GO_VERSION}/x64/.complete; \
    ln -s /opt/hostedtoolcache/go/${GO_VERSION}/x64 /usr/local/go; \
    # runner owns the toolcache: setup-go must be able to add other versions
    # (ranged pins resolve to newer patches than the pre-baked one)
    chown -R runner:runner /opt/hostedtoolcache
ENV PATH="/usr/local/go/bin:${PATH}" \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache

# CLI wrappers: `docker` and `podman` both exec the real podman; `buildah`
# execs buildah. All three default to host networking for run/create/build
# (see network-wrapper.sh — the only networking that works on CF).
COPY network-wrapper.sh /usr/local/bin/network-wrapper.sh
RUN chmod +x /usr/local/bin/network-wrapper.sh \
    && ln -sf network-wrapper.sh /usr/local/bin/docker \
    && ln -sf network-wrapper.sh /usr/local/bin/podman \
    && ln -sf network-wrapper.sh /usr/local/bin/buildah

# Docker Compose v2 (single Go binary). There is no docker daemon: compose
# talks to the rootless podman API service the entrypoint starts at
# $XDG_RUNTIME_DIR/podman.sock — the network-wrapper shim routes `docker
# compose` here and sets DOCKER_HOST for that exec only (globally exported
# DOCKER_HOST would flip podman itself into remote-client mode). Caveat found
# live: compose --wait and depends_on: service_healthy hang forever — podman
# healthchecks need systemd timers, absent in this sandbox — so workflows
# must gate service readiness with their own exec/curl probes.
ARG COMPOSE_VERSION=v2.39.2
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && ln -sf /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose

# Rootless defaults for the runner user:
#   - no cgroup creation (CF's cgroup fs is not writable rootless; crun runs
#     fine without cgroups in this single-tenant sandbox)
#   - file lock manager (default shm locks need /dev/shm, absent in the CF
#     sandbox; file locks live under $XDG_RUNTIME_DIR/libpod instead)
#   - file-backed events log (no journald in the sandbox)
# NOTE: host networking (the only mode that works on CF — no /dev/net/tun)
# cannot be set as a config default in podman 4.9; the CLI wrappers in
# /usr/local/bin inject --network host instead.
# .config/cni is where podman puts its network lock files — pre-create it, and
# chown .config itself (install -d -o only owns the leaf, not intermediate dirs).
# The same settings also go to /etc/containers/containers.conf: podman only
# reads the USER config via $HOME/.config, and the runner's docker-action
# invocations have shown up with HOME unset — podman then falls back to system
# config, whose defaults want shm locks, which need /dev/shm (absent in the CF
# sandbox) → "failed to get new shm lock manager" kills every docker action.
# System config is read in every invocation mode, so the fix belongs there;
# the user copy stays for explicitness.
RUN set -eux; \
    mkdir -p /home/runner/.config/cni /home/runner/.config/containers; \
    chown -R runner:runner /home/runner/.config; \
    { \
        printf '[containers]\ncgroups = "disabled"\n\n'; \
        printf '[engine]\nevents_logger = "file"\nlock_type = "file"\n'; \
    } | tee /home/runner/.config/containers/containers.conf \
            >/etc/containers/containers.conf; \
    chown runner:runner /home/runner/.config/containers/containers.conf

# Registry mirror: common base images are pre-baked into our CF registry
# (pulled over CF's backbone instead of docker.io). The mirror is tried first;
# anything not present falls through to docker.io upstream.
# unqualified-search-registries must stay: short image names in workflows
# (e.g. Docker-based actions) resolve through it (v29 broke this — docker
# actions failed with "short-name did not resolve").
RUN set -eux; \
    mkdir -p /etc/containers/registries.conf.d; \
    { \
        printf 'unqualified-search-registries = ["docker.io"]\n'; \
        printf '[[registry]]\nprefix = "docker.io"\nlocation = "docker.io"\n'; \
        printf '[[registry.mirror]]\nlocation = "registry.cloudflare.com/97b0dab10c55d2e8a6c952eb4e4914ac/mirror-docker.io"\n'; \
    } > /etc/containers/registries.conf.d/999-cf-mirror.conf

# GitHub Actions docker-based actions mount /github/* INTO their containers
# and run with --workdir /github/workspace. Docker's daemon auto-creates these
# paths in the container; podman does not ("workdir does not exist" /
# "cannot resolve /github/home") — so the runner image must carry them.
RUN mkdir -p /github/home /github/workflow /github/runner_temp \
    /github/file_commands /github/workspace \
    && chown -R runner:runner /github

# Subordinate uid/gid range rootless podman maps containers into.
RUN set -eux; \
    uid="$(id -u runner)"; \
    printf 'runner:%d:65536\n' "$((uid + 100000))" >> /etc/subuid; \
    printf 'runner:%d:65536\n' "$((uid + 100000))" >> /etc/subgid

USER runner
ENV XDG_RUNTIME_DIR=/tmp/runner-runtime
COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh
WORKDIR /home/runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]

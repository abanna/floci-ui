#!/bin/sh
# Force host networking for container-creating subcommands on Cloudflare
# Containers. /dev/net/tun is blocked by the CF device cgroup, so podman's
# rootless network providers (slirp4netns/pasta) can never work and neither
# can bridge networking — host networking is the ONLY working mode. Podman
# 4.9 cannot express "default to host" in containers.conf, so this wrapper
# injects --network host unless one is already given.
#
# Also adapts GitHub Actions' docker invocations for rootless podman:
#   - Docker auto-creates missing bind-mount sources; rootless podman errors
#     (lstat) instead. The runner always mounts /github/home, /github/workflow,
#     /github/runner_temp, /github/file_commands and /var/run/docker.sock for
#     Docker-based actions — pre-create them (sudo is NOPASSWD here).
#   - /var/run/docker.sock is stubbed as a plain file: Docker-based actions
#     get a harmless bind instead of a hard failure. Actions that actually
#     talk to a docker daemon won't work (no daemon exists by design).
#
# Installed as /usr/local/bin/{docker,podman} -> exec /usr/bin/podman, and
# /usr/local/bin/buildah -> exec /usr/bin/buildah (/usr/local/bin precedes
# /usr/bin in PATH). compose/buildx are not available.
case "$0" in
    *buildah) REAL=/usr/bin/buildah ;;
    *) REAL=/usr/bin/podman ;;
esac

cmd="$1"
case "$cmd" in
    run|create|build|bud) ;;
    *) exec "$REAL" "$@" ;;
esac

# Network flag already present (any form) -> skip injection.
net=0
for a in "$@"; do
    case "$a" in
        --network|--network=*|--net|--net=*) net=1 ;;
    esac
done

# Pre-create bind-mount sources (form: -v /src:/dst) that docker's daemon
# would auto-create but rootless podman refuses to (lstat: no such file).
for a in "$@"; do
    case "$a" in
        /*:/*)
            src=${a%%:*}
            if [ ! -e "$src" ]; then
                if sudo -n mkdir -p "$src" 2>/dev/null; then
                    echo "shim: pre-created mount source $src" >&2
                else
                    echo "shim: FAILED to pre-create $src" >&2
                fi
                case "$src" in
                    */docker.sock) sudo -n touch "$src" 2>/dev/null ;;
                esac
            fi ;;
    esac
done

if [ "$net" -eq 1 ]; then exec "$REAL" "$@"; fi
shift
exec "$REAL" "$cmd" --network host "$@"

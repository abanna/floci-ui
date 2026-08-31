#!/bin/sh
# Force host networking for container-creating subcommands on Cloudflare
# Containers. /dev/net/tun is blocked by the CF device cgroup, so podman's
# rootless network providers (slirp4netns/pasta) can never work and neither
# can bridge networking — host networking is the ONLY working mode. Podman
# 4.9 cannot express "default to host" in containers.conf, so this wrapper
# injects --network host unless one is already given.
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

# Network flag already present (any form) -> pass through untouched.
for a in "$@"; do
    case "$a" in
        --network|--network=*|--net|--net=*) exec "$REAL" "$@" ;;
    esac
done

shift
exec "$REAL" "$cmd" --network host "$@"

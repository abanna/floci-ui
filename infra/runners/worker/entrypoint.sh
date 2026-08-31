#!/usr/bin/env bash
# Boot sequence for an ephemeral GitHub Actions runner on Cloudflare Containers.
#
# No container daemon: jobs get rootless Podman/Buildah (user namespaces work
# on CF; /dev/net/tun and iptables do not, so dockerd/rootlesskit were removed
# after v13–v17 proved them a dead end). Podman is preconfigured for host
# networking and cgroup-less containers via containers.conf in the image.
# `docker ...` commands in workflows are shimmed to podman by the image.
#
#   1. DNS sanity check (sandbox resolver normally works; best-effort fallback)
#   2. rootless podman smoke test (non-fatal, result shipped to logs)
#   3. mint a registration token via org PAT -> register --ephemeral -> run.sh
#   4. prune podman state -> re-register (loop)
set -eu

: "${GH_ORG:?GH_ORG required}"
: "${GH_PAT:?GH_PAT required}"
RUNNER_NAME="${RUNNER_NAME:-cf-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-}"
RUNNER_GROUP="${RUNNER_GROUP:-}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runner-runtime}"
mkdir -p "$XDG_RUNTIME_DIR/libpod/locks"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

log() {
    local line="[entrypoint] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
    echo "$line"
    [ -n "${WORKER_URL:-}" ] && curl -fsS -m 5 -X POST -H "Authorization: Bearer ${WEBHOOK_SECRET:-}" \
        -H 'content-type: text/plain' --data "$line" "${WORKER_URL}/debug/log" >/dev/null 2>&1 || true
}

RUNNER_DIR=""
for d in /home/runner /home/runner/actions-runner /actions-runner; do
    if [ -x "$d/config.sh" ]; then RUNNER_DIR="$d"; break; fi
done
[ -n "$RUNNER_DIR" ] || { log "runner distribution not found"; exit 1; }
log "runner distribution: $RUNNER_DIR (rootless podman, no daemon)"

# Image pulls and GitHub API need working DNS. The outer sandbox resolver is
# normally fine (the old dockerd issue was rootlesskit-child-specific), but
# probe and fall back to public resolvers best-effort — /etc/resolv.conf may
# be read-only, in which case we just log it.
if ! curl -fsS -m 8 -o /dev/null https://api.github.com/zen 2>/dev/null; then
    log "DNS probe to api.github.com failed; rewriting /etc/resolv.conf (best-effort)"
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf 2>/dev/null \
        && log "rewrote /etc/resolv.conf" \
        || log "could not rewrite /etc/resolv.conf (read-only?)"
fi

# RAM-backed build caches: the CF rootfs is network-backed virtio (slow for
# compile-heavy workloads) while 12 GiB of RAM otherwise idles. sudo is
# NOPASSWD and tmpfs mounts are permitted in the sandbox — mount an 8 GB RAM
# disk and point Go/pip/uv caches at it. The mount and exports are inherited
# by job steps, so caches are RAM-speed AND persist across jobs within this
# container's lifetime. Best-effort: fall back to disk defaults on failure.
RAM_SIZE="${RAM_DISK_SIZE:-8g}"
if sudo -n mkdir -p /mnt/ram 2>/dev/null \
    && { mountpoint -q /mnt/ram 2>/dev/null \
        || sudo -n mount -t tmpfs -o size="$RAM_SIZE" tmpfs /mnt/ram 2>/dev/null; }; then
    export GOCACHE=/mnt/ram/gocache \
        GOMODCACHE=/mnt/ram/gomodcache \
        PIP_CACHE_DIR=/mnt/ram/pip-cache \
        UV_CACHE_DIR=/mnt/ram/uv-cache \
        GOMEMLIMIT="${GO_MEMORY_LIMIT:-10GiB}"
    mkdir -p "$GOCACHE" "$GOMODCACHE" "$PIP_CACHE_DIR" "$UV_CACHE_DIR" 2>/dev/null || true
    log "tmpfs caches active at /mnt/ram ($RAM_SIZE): GOCACHE/GOMODCACHE/PIP_CACHE_DIR/UV_CACHE_DIR"
else
    log "tmpfs mount unavailable; build caches stay on disk"
fi

# Rootless podman smoke test: validates config parse + storage setup + userns +
# crun end to end before a job lands. Non-fatal by design — non-container jobs
# must keep working even if this fails.
if podman info >/dev/null 2>&1; then
    log "podman ready: $(podman --version) storage=$(podman info -f json 2>/dev/null | jq -r '.store.graphDriverName // "unknown"')"
else
    log "podman info FAILED (container jobs will fail); log tail:"
    podman info 2>&1 | tail -8 | while IFS= read -r line; do log "P| $line"; done
fi
if timeout 120 podman run --rm --network host -q docker.io/library/busybox:latest true 2>/tmp/podman-smoke.log; then
    log "podman smoke OK (pull + userns + crun + host networking)"
else
    log "podman smoke FAILED: $(tail -3 /tmp/podman-smoke.log 2>/dev/null | tr '\n' ' ' | cut -c1-400)"
fi

GH_PAT="${GH_PAT:?GH_PAT required}"
GH_ORG="${GH_ORG:?GH_ORG required}"

# --- Fleet-shared R2 cache sync -------------------------------------------------
# The worker streams /cache/<key> to an R2 bucket. Domains are tarballed
# independently; last-writer-wins (build caches tolerate stale overwrites).
CACHE_DOMAINS="gocache gomodcache uv-cache pip-cache"
CACHE_MAX_BYTES=$((3 * 1024 * 1024 * 1024))  # skip snapshots over 3 GB

cache_restore() {
    for d in $CACHE_DOMAINS; do
        case "$d" in
            gocache) dir="$GOCACHE" ;;
            gomodcache) dir="$GOMODCACHE" ;;
            uv-cache) dir="$UV_CACHE_DIR" ;;
            pip-cache) dir="$PIP_CACHE_DIR" ;;
        esac
        [ -n "$dir" ] && [ -d "$dir" ] || continue
        if curl -fsS -m 240 -H "Authorization: Bearer ${WEBHOOK_SECRET}" \
            "${WORKER_URL}/cache/v1/${d}.tar.gz" 2>/dev/null | tar -xzf - -C "$dir" 2>/dev/null; then
            log "cache restore: $d"
        fi
    done
}

cache_snapshot() {
    for d in $CACHE_DOMAINS; do
        case "$d" in
            gocache) dir="$GOCACHE" ;;
            gomodcache) dir="$GOMODCACHE" ;;
            uv-cache) dir="$UV_CACHE_DIR" ;;
            pip-cache) dir="$PIP_CACHE_DIR" ;;
        esac
        [ -n "$dir" ] && [ -d "$dir" ] || continue
        size=$(du -sb "$dir" 2>/dev/null | cut -f1)
        [ "${size:-0}" -gt 0 ] && [ "${size:-0}" -le "$CACHE_MAX_BYTES" ] || continue
        if tar -czf - -C "$dir" . 2>/dev/null | curl -fsS -m 600 -X PUT \
            -H "Authorization: Bearer ${WEBHOOK_SECRET}" -H 'content-type: application/octet-stream' \
            --data-binary @- "${WORKER_URL}/cache/v1/${d}.tar.gz" >/dev/null 2>&1; then
            log "cache snapshot: $d ($size bytes)"
        fi
    done
}

# Restore is backgrounded so runner registration isn't delayed; caches land
# within ~a minute of boot, before most jobs start doing heavy work.
( sleep 20; cache_restore ) &

mint_registration_token() {
    curl -fsS -X POST \
        -H "Authorization: Bearer ${GH_PAT}" \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/orgs/${GH_ORG}/actions/runners/registration-token" |
        jq -r '.token'
}

# An unclean shutdown can orphan the named runner in the org; deregister it.
# Uses the name query filter — ONE API call. (Scanning all org runners page by
# page here tripped GitHub secondary rate limits when the org has hundreds of
# other ephemeral runners, which made the DELETEs fail and this loop never
# converge.)
deregister_existing() {
    ids="$(curl -fsS -H "Authorization: Bearer ${GH_PAT}" -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/orgs/${GH_ORG}/actions/runners?name=${RUNNER_NAME}&per_page=10" |
        jq -r '.runners[] | .id' 2>/dev/null)" || return 0
    for id in $ids; do
        if curl -fsS -X DELETE -H "Authorization: Bearer ${GH_PAT}" \
            "https://api.github.com/orgs/${GH_ORG}/actions/runners/${id}" >/dev/null 2>&1; then
            log "deregistered orphan runner id=${id}"
        else
            sleep 5   # likely secondary rate limit; back off before next attempt
        fi
    done
}

# Clean shutdown: drop this runner's registration so GitHub doesn't keep an
# offline ghost holding a busy slot after SIGTERM (idle sleep / redeploy).
on_term() {
    log "SIGTERM: deregistering before exit"
    deregister_existing
    exit 0
}
trap on_term TERM INT

attempt=0
while true; do
    reg_token="$(mint_registration_token)" || {
        sleep $((attempt < 5 ? 15 : 60))
        attempt=$((attempt + 1))
        continue
    }
    [ -n "$reg_token" ] && [ "$reg_token" != "null" ] || {
        log "failed to mint registration token"
        sleep $((attempt < 5 ? 15 : 60))
        attempt=$((attempt + 1))
        continue
    }

    args=(--url "https://github.com/${GH_ORG}" --token "$reg_token" --name "$RUNNER_NAME"
        --ephemeral --unattended --work /tmp/runner-work)
    [ -n "$RUNNER_LABELS" ] && args+=(--labels "$RUNNER_LABELS")
    [ -n "$RUNNER_GROUP" ] && args+=(--runnergroup "$RUNNER_GROUP")

    log "registering ${RUNNER_NAME} (attempt $((attempt + 1)))"
    cfg_out="$(cd "$RUNNER_DIR" && ./config.sh "${args[@]}" 2>&1)" && cfg_rc=0 || cfg_rc=$?
    if [ "$cfg_rc" -eq 0 ]; then
        log "$RUNNER_NAME registered"
        attempt=0
        (cd "$RUNNER_DIR" && ./run.sh)
        log "runner session ended"
    else
        printf '%s\n' "$cfg_out" | tail -4 | while IFS= read -r line; do log "C| $line"; done
        case "$cfg_out" in
            *"same name"*) deregister_existing ;;
        esac
        log "registration failed (rc=$cfg_rc)"
        attempt=$((attempt + 1))
        sleep 15
    fi

    # Disk is bounded (20 GB): prune podman state only under pressure — warm
    # caches and images are the point of a long-lived runner now.
    disk_used=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
    if [ "${disk_used:-0}" -ge 70 ]; then
        log "disk at ${disk_used}% — pruning podman state"
        podman system prune -af --volumes >/dev/null 2>&1 || true
    fi
    # Push warm caches to R2 so ANY runner (or a restarted one) starts hot.
    cache_snapshot || true
done

# HANDOFF — floci-ui (updated 2026-09-02, session-end handoff)

**READ THIS FIRST — where Thread A stands (2026-09-02 ~17:45Z):**
- **Migration: 6 of 12 PRs MERGED by Alex** (agentisan-skills#302, homelab#193, attic#3,
  elliot#4, demo-repository#2, properties#269). **7 open + fully green awaiting Alex's merge**:
  interview#15, go-tdad#222, my-dash#2, harness-go#585,
  fraternal-organization-member-portal#72 (repo RENAMED from fraternal-org-portal),
  agentisan-skills#304, **properties#271** (compose jobs → cf-runners, see below).
  **incidents#86** open with 1 red (CodeQL needs repo-level Advanced Security — fails on hosted
  too; Alex must either enable GHAS or tell us to drop `.github/workflows/codeql-analysis.yml`).
- **COMPOSE SUPPORT SHIPPED (2026-09-02, image v41)**: properties' migrations/tests/db-regression
  were stuck QUEUED for a day+ — Blacksmith stopped assigning runners org-wide (~Sept 1 11:08Z;
  Alex's account to chase, not ours). Alex chose "make them live on cf-runners". Shipped:
  image bakes **docker compose v2** (`/usr/local/bin/docker-compose`), entrypoint starts
  **`podman system service --time=0`** at `$XDG_RUNTIME_DIR/podman.sock`, the docker shim routes
  `compose` (with `shift`! v40 forgot it → "compose compose") with DOCKER_HOST set per-exec.
  properties#271 moved the 3 jobs: plain `docker build` instead of buildx actions, explicit
  readiness gates instead of `--wait` (podman healthchecks need systemd timers — absent — so
  `--wait` and `depends_on: service_healthy` hang forever), CI compose file on
  `network_mode: host` (no bridge on CF), minio-setup via localhost, pgvector fetched via
  codeload tarball (GitHub git endpoints throttle shared colo egress: "expected flush after
  ref listing") + curl added to the build. **All 7 checks green**: migrations 1m, tests 20m51s,
  db-regression 2m6s. PR awaiting Alex's merge.
- **Session cron `3bc7a81d`** polls the migration PRs every 20 min (fix failures, answer bot
  reviews, never merge). Session-only — died with each session, recreate on session start
  (previous: ee2c63d1). Delete when all are merged or Alex says stop.
- **Infra PR: abanna/floci-ui#1** (8 commits; latest: 537543a compose support, deaf2ca shim
  shift fix).
- **CLOSED: demo-repository main `Proof HTML` (docker actions)** — root cause: runner spawns
  `docker` with `HOME=/github/home` for docker actions → podman misses user containers.conf →
  shm locks → no /dev/shm on CF. Fix at **/etc/containers/containers.conf** in the image (v39).
  Demo main run green on attempt 10. `max_instances` restored to **6** (wrangler.jsonc had said
  3 — every wrangler deploy was regressing the fleet scale; fixed in d809b50).
- **COLD-CI IS A FLEET PROPERTY (2026-09-02 ~23:45Z, image v42)**: the entrypoint loop wipes
  job containers/networks/volumes between jobs (`podman rm -af` + network/volume prune, images
  kept as warm cache) — long-lived runners otherwise carry a previous job's compose stack into
  the next (properties main broke with "CREATE DATABASE: already exists" after #271 merged).
  properties#272 (workflow-side reset) closed as superseded; main's failed run verified green
  on the v42 fleet with no workflow change.
- **OPS-CRITICAL: stop+wake after deploys MUST be verified at the platform level.** SDK
  `probe=stop` can no-op on wedged containers; a wake then re-registers OLD-image runners that
  instantly grab jobs (v41 stragglers served two failed reruns). Recipe: `probe=stop` ×6 →
  sleep 90 → **GET instances API until ALL state=inactive** → wake → verify 6 registrations →
  then trigger jobs. A job that fails suspiciously fast (seconds into a step that needs a slow
  cold build) is on a warm straggler — check its runner_name and started_at vs deploy time.
- **Perf reality (measured)**: cf-runners are 2–4× slower per job than Blacksmith on
  compile-heavy work (disk character + cold caches); parity for light jobs. Alex declined paying
  for Blacksmith. Mitigations shipped: tmpfs RAM caches, R2 fleet cache, toolcache pre-bake,
  2h warm windows, 6 instances, ENAM placement.

---

# THREAD A — gh-runners: self-hosted GitHub Actions runners on Cloudflare (LIVE)

## What exists
- **Branch `feat/cf-github-runners`, UNCOMMITTED.** Untracked set ready to commit:
  `infra/runners/` (Pulumi.yaml, Pulumi.dev.yaml [secrets encrypted], main.go, go.mod/sum,
  worker/{src/index.ts, wrangler.jsonc, Dockerfile, entrypoint.sh, package.json, tsconfig.json,
  README.md}) + `.gitignore` additions (binary `infra/runners/runners` already ignored) +
  HANDOFF.md itself. NOT part of this work: `docs/architecture/`, `graphify-out/` (pre-existing
  untracked from other sessions — leave them out of the commit).
- Code layout:
  - `Pulumi.yaml` + `main.go` (Go) — owns the **GitHub side only**: org `workflow_job` webhook
    (+ optional runner group via `runnerGroup` config). Stack: `abanna/gh-runners/dev`.
  - `worker/` — CF Worker (TS, dependency-free, low-level Durable Object container API) + `wrangler.jsonc`
    + `Dockerfile` + `entrypoint.sh` — the runner image and boot logic.
  - `README.md` — full setup/ops/verification docs (read this first).
- **LIVE resources** (deployed OUT-OF-BAND via Cloudflare API + wrangler — NOT in Pulumi state):
  - Worker `nerds-run-gh-runners` → `https://nerds-run-gh-runners.solvedgg.workers.dev`
    (`/health`, `/wake`, `/webhook`, `/debug` — all auth'd via `WEBHOOK_SECRET`)
  - Containers app `nerds-run-gh-runners-runnercontainer` (id `a03e4d67-cd73-455b-9127-d75ff0399c5d`),
    3 fixed instances `runner-0/1/2` (standard-4: 4 vCPU/12 GiB/20 GB), DO namespace
    `38f32b04c4884c2b8a75dd6d7a4089c9`
  - Image live: `registry.cloudflare.com/97b0dab10c55d2e8a6c952eb4e4914ac/nerds-run-gh-runners/runnercontainer:v21`
    (v13 = last DinD stable, v18–v20 = podman iterations, v21 = current)
  - GitHub: org webhook `hooks/672230622`; runners `cf-runner-0/1/2` (labels `X64, linux, self-hosted, cf-runner`)
  - Test bed: `nerds-run/cf-runner-test` (private, `workflow_dispatch`-only test workflow)

## Verified working (end-to-end)
- `workflow_dispatch` → org webhook (HMAC) → Worker wakes sleeping instance → ephemeral runner
  registers via PAT-minted token → picks up job → runs → deregisters/re-registers → idle sleeps 30m.
- Job proof: `nerds-run/cf-runner-test` run 33308757614 — `shell` job **passed** on `cf-runner-2`
  (`uname` = `Linux cloudchamber 6.18.36-cloudflare-firecracker` — genuinely on CF infra).
- Auth = Alex's gh token (classic, scopes `admin:org` + `admin:org_hook`, granted via `gh auth refresh`)
  stored as Worker secret `GH_PAT` + Pulumi `githubToken`. No GitHub App / private key (Alex's explicit ask).

## Container jobs: SOLVED — rootless Podman/Buildah (v26 image) + SDK worker
The old limitation ("Docker-in-Docker fails") is gone. DinD via dockerd/rootlesskit was a dead end
(v13–v17); image v18+ replaced it with **apt podman + buildah, no daemon** — userns works on CF.
`worker/cf-runner-test` and real CI verified: `podman run`, networked `podman build`, `docker run`
via shim all pass on live CF infra. Storage driver = native overlay (rootless).

- **Live image**: `…/runnercontainer:v26` (v22 build-essential; v23 rsync+tools; v24 entrypoint
  ghost-dereg single-call + SIGTERM trap; v25 Go 1.25.0; v26 nodejs+npm — each = one hosted-parity
  gap found by real CI).
- **Worker REWRITTEN on @cloudflare/containers SDK** (2026-08-31, version 8ee7cde5): the hand-rolled
  low-level DO wrapper held `container.monitor()` open → DO non-hibernateable → platform EVICTS such
  DOs after 70-140s → container SIGTERMed mid-job. That was the root cause of every "runner lost
  communication" failure. The SDK's alarm loop is the supported keep-alive; idle sleep now lives in
  `onActivityExpired()` gated by a **name-filtered** GitHub busy check (the old unfiltered page-1
  check of a 556-runner org list SIGTERMed busy runners).
- **Ops-critical patterns learned (do not relearn)**:
  - ROLLOUT API calls WIPE the app's env (GH_PAT/GH_ORG/WEBHOOK_SECRET) — rollout-restored boots
    die instantly on `: "${GH_ORG:?}"`. After ANY rollout: `probe=stop` each runner (resets the SDK
    state machine, which can go stale and no-op starts), then POST /wake (DO start injects env).
  - Registry JWTs expire in 15 min — mint AFTER building, right before push.
  - Don't roll images while the pool is busy — full_auto kills in-flight jobs.
  - Entrypoint logs ship to `/debug/log` → read with `wrangler tail` (telemetry query needs
    observability scope the current tokens lack).
  - GitHub org-runner list is ~556 Blacksmith ephemeral runners: ALWAYS use `?name=` filters;
    unfiltered scans trip secondary rate limits.

### CI migration (2026-08-30/31): 12 PRs open, Alex merges
PRs swapping `runs-on` → `[self-hosted, cf-runner]` in ALL private repos with CI: interview#15,
properties#269, go-tdad#222, my-dash#2, agentisan-skills#302, harness-go#585, fraternal-org-portal#72,
homelab#193, attic#3, elliot#4, incidents#86, demo-repository#2 (~50 jobs). Public repos deliberately
EXCLUDED (fork-PR = arbitrary code on self-hosted runners). Codex bot reviewed all 12: properties'
compose/buildx jobs kept on Blacksmith (no docker compose on cf-runners), agentisan-skills isolation
comments rewritten, fork-PR trust answered (private repos, org-member forks, no secrets on
`pull_request`). Known hosted-parity gaps so far: gcc (v22), rsync (v23), go (v25), npm (v26).
`docker compose`/`buildx` NOT available on cf-runners.

### Perf + scale ("beast mode", 2026-08-31)
- **6 instances** (max_instances=6; RUNNER_IDS runner-0..5). CF caps instance SIZE at standard-4
  (4 vCPU/12 GiB/20 GB) — custom types can't exceed it; larger needs an enterprise request.
- **8 GB tmpfs at /mnt/ram** for GOCACHE/GOMODCACHE/PIP_CACHE_DIR/UV_CACHE_DIR (2-4 GB/s vs
  network-backed /dev/vdc) + GOMEMLIMIT=10GiB. sudo is NOPASSWD; tmpfs mounts permitted.
- **R2 fleet cache**: bucket `nerds-run-ci-cache`, Worker CACHE binding streams /cache/v1/<key>;
  entrypoint restores at boot (backgrounded) and snapshots after each job (≤3 GB/domain,
  last-writer-wins).
- **ENAM placement** (constraints.regions=["ENAM"]) — Chicago-region scheduling per Alex.
- **docker.io → CF registry mirror** (`mirror-docker.io`; pre-baked alpine/busybox/debian-slim/
  golang:1.25). unqualified-search-registries MUST stay defined or Docker-based actions fail
  short-name resolution (v29 broke it, v31 fixed).
- Idle sleep 30m → 2h (warm caches survive between pushes; bills idle memory).
- Repo-side fixes pushed to PR branches: go-tdad test timeouts (10m→20m/40m/30m cold-cache
  measurements), elliot trivy pin v0.2.2→v0.3.1 + gofmt config.go, demo auto-assign issues-only,
  incidents CodeQL back to hosted (repo lacks Advanced Security — GHAS decision is Alex's).
- KNOWN ISSUE (partially resolved): stale containers can survive rollouts (SDK stop no-ops on
  wedged state) → mixed image versions for up to 2h. Force-refresh = `probe=stop` ×6, settle 150s,
  wake. max_instances=9 works around zombie slot accounting (was 6). Delete+recreate of the
  containers app clears everything but needs Alex's explicit approval (config: standard-4 ×6,
  ENAM, DO namespace 38f32b04c4884c2b8a75dd6d7a4089c9). Infra PR: abanna/floci-ui#1.

### Recommended next tasks (in order)
1. **Alex merges the 6 green PRs** + decides incidents GHAS-vs-drop + reviews abanna/floci-ui#1.
2. **Unlock 1Password → commit the 2 dangling files** (Dockerfile + network-wrapper.sh, see top).
3. Close the demo Proof HTML thread: verify a main-push run passes on the wrangler-deployed
   image; if the shm-lock error persists, diff the wrangler-built image's containers.conf.
4. Optionally: import the containers app into Pulumi state; fine-grained PAT swap; custom domain;
   compose/buildx (podman system service) if a repo needs it.

## Ops recipes (gotchas that cost time — don't re-derive)
- **`wrangler deploy` applies wrangler.jsonc app config too** (max_instances, instance_type) —
  keep that file in sync with the intended fleet or every deploy silently regresses it
  (it rolled 9→3 once; d809b50 pinned 6).
- **Which image is a runner on?** Boot-time podman smoke passes on old AND new images — useless
  for discrimination. From a job on the runner: `cat /etc/containers/containers.conf` (present
  = v39+). Use the `nerds-run/cf-runner-test` workflow (workflow_dispatch) as the live probe —
  it runs ON a runner with full host-container context; steps run with `bash -e`, so start
  repro scripts with `set +e`.
- **Debugging docker-action failures**: `nerds-run/cf-runner-test` holds the repro matrix for
  the HOME=/github/home podman lock issue (see CLOSED thread in header). Docker actions set
  HOME=/github/home in the step env; anything reading `$HOME/.config` breaks silently.
- **Deploy images via `wrangler deploy`** (in infra/runners/worker): builds + pushes the
  Dockerfile with wrangler's OAuth + rolls the app — NO registry JWTs, NO manual rollout API
  calls (those 401'd flakily late-session). Then ALWAYS: `probe=stop` ×6 → settle 150s → wake
  (rollout/env-less boots die instantly; SDK state needs the reset; wake injects env).
  NOTE: even then, an instance can boot a stale layer right after a push (runner-0 failed
  post-roll, passed after a second stop+wake) — if a job fails with an error the new image
  already fixed, stop that instance and rerun before re-diagnosing.
- **Registry JWTs** (only needed for manual pushes): 15–20 min TTL, mint right before push.
  Docker login 401s are usually expiry or registry auth flakiness — clear
  `~/.docker/config.json` auths entry, re-mint, retry.
- **Logs**: container stdout is NOT captured anywhere → entrypoint ships logs via
  `curl $WORKER_URL/debug/log`. Read them: **`bunx wrangler tail nerds-run-gh-runners`** (the
  telemetry API needs scopes we lack — 400/401/403 via MCP, wrangler OAuth, and Pulumi tokens).
  NOT `workers_logs`).
- **Wake pool**: `curl -X POST -H "Authorization: Bearer $(pulumi -C infra/runners stack output webhookSecret --show-secrets)" https://nerds-run-gh-runners.solvedgg.workers.dev/wake`
- **Deploy worker**: `cd infra/runners/worker && CLOUDFLARE_API_TOKEN=$(grep -oP 'oauth_token = "\K[^"]+' ~/.config/.wrangler/config/default.toml) bunx wrangler deploy`
  (token expires ~1h; refresh via `script -qec "bunx wrangler whoami" /dev/null`).
  wrangler.jsonc has NO `migrations` (already applied; re-sending → API error 10074).
- **Image rollout** (PATCH alone does NOT roll):
  `POST /accounts/{id}/containers/applications/a03e4d67-.../rollouts` body
  `{description, strategy:"rolling", step_percentage:100, kind:"full_auto", target_configuration:{image, instance_type:"standard-4", observability:{logs:{enabled:true}}}}`
- **Image push**: `POST /accounts/{id}/containers/registries/registry.cloudflare.com/credentials`
  `{expiration_minutes:15, permissions:["push","pull"]}` → `{username,password}` → `docker login --password-stdin` → push.
  (CF API MCP plugin token can't mint API tokens and its sandbox blocks localhost/external fetch —
  payloads inline as base64+sha256 or use the wrangler OAuth path above.)
- **Deploy CF containers via API** (replicated wrangler flow): build locally → registry JWT → push →
  `PUT /workers/scripts/{name}` multipart (metadata: `migrations` = single OBJECT, plus
  `containers:[{name,class_name}]` link, `keep_bindings:["secret_text"]`) →
  `POST /containers/applications` `{scheduling_policy:"default", instances:0, max_instances:3,
  configuration:{image, instance_type}, durable_objects:{namespace_id}}`.
- **wrangler.jsonc warning**: needs `"exports": {"RunnerContainer": {"type":"durable-object","storage":"sqlite"}}`
  — without it containers bind incorrectly and die instantly (this bug cost the longest debug loop).
- **Pulumi**: `command:local:Command` rejects secret-marked `triggers` (malformed RPC secret) — secrets
  flow through `Environment` instead. pulumi-github provider needs `Organization: "nerds-run"`.
- `gh auth refresh` times out in-session — run as a background Bash task and read the device code from
  the output file.

---

# THREAD B — Floci console design in OpenDesign (PAUSED, mid-stream)

## TL;DR state
- Design runs 1–5 + fix runs through `4e184219` all landed; project `floci-console-design-0519`
  (`Floci Console.dc.html`). After `4e184219` verifies clean: design done → floci-ui source implementation.
- Backups: post-batch5 (pre-fix), artifact-fix2 (verified good), artifact-fix3 (broken, forensics),
  artifact-fix4 (post-run-4); verify screenshots `/tmp/floci-design/verify*.png verify2-* verify3-* verify4-* verify5-* leak-*`.
- NOTE: comments left in the OpenDesign UI do NOT reach the assistant (probed). Type feedback here.

## Open items (from runs 4/5 + 2026-08-29 survey)
- Run 5 `4e184219` result NOT yet verified: was to fix (1) detail-view components leaking into list
  pages, (2) detail-view vertical rhythm, (3) drawer scrollbar, (4) service-switch bounce.
- Known-good after run 4 `f4208094`: EKS 1.30, EKS STATUS column, CFN dedupe+counts, APIGW trio gone,
  data blocks intact. Still open from before: Secrets SECRET VALUE empty, Secrets double-render,
  APIGW methods 3 vs header 4.

## Regression catalog (2026-08-29 survey; statuses per runs d1dec31e/f4208094)
A. Non-AWS personas: (1) persona list pages zero rows; (2) stat band AWS-only zeroed; (3) SOON cards
   AWS-only; (4) OCI hero truncation.
B. AWS: (5) CFN/RDS/EKS table clipping; (6) RDS dataset contradictions; (7) dead tab rows (removed by
   d1dec31e ✓); (8) bespoke sections (CFN TEMPLATE/RESOURCES/OUTPUTS ✓ by d1dec31e; VPC IGW/NAT/
   subnets/routes ✓; APIGW endpoint+methods ✓; Secrets REVEAL flow ✗); (9) chip cosmetics.
Healthy (do not touch): AWS dashboard, themes/voices, drawer logo, EC2/S3/DynamoDB/Lambda, services index, Coverage.

## How to commission runs (OpenDesign local Docker)
- UI http://127.0.0.1:7456 (basic auth `open-design` / `OD_API_TOKEN` from
  `~/Development/github/nexu-io/open-design/deploy/.env`); REST `POST /api/runs` with Bearer token,
  payload built with `jq -n --rawfile brief file` (shell-var heredoc → empty message → BAD_REQUEST).
- Runs claiming `succeeded` still need visual verification. Artifact raw URL:
  `http://127.0.0.1:7456/api/projects/floci-console-design-0519/raw/Floci%20Console.dc.html`
  (Bearer header; `/raw/` without `/api` serves SPA shell — wrong). 100vh layout: scroll via
  `[...document.querySelectorAll('main div')].find(e=>e.scrollHeight>e.clientHeight+50)`.
- GLM 5h quota caps runs (429 → `endedWithUnfinishedWork`).

## Constraints (every run brief)
- Data honesty (AGENTS.md): counts/state/sizes/probe latency only; no cost/CPU/alarms; no Monitoring tabs.
- Provider voices never recolor status semantics; AWS naming exact. Standing spec in memory
  `dashboard-design-opendesign.md`.
- Quality gate that works: per-view runtime render-path execution + renderedRowCount === headerClaimedCount.

## Memory pointers
- `dashboard-design-opendesign.md` — design state + standing spec
- `open-design-docker.md` — daemon wiring, REST contract
- `gh-runners-infra.md` — Thread A full technical state
- Plan files: `~/.claude-glm/plans/atomic-mapping-crab.md` (console impl), `~/.claude-glm/plans/delegated-soaring-bear.md` (gh-runners)

# HANDOFF — floci-ui (updated 2026-08-30)

Two active threads. **Thread A (gh-runners)** is new this session and is LIVE in production.
**Thread B (console design in OpenDesign)** is paused mid-stream — full state preserved below.

Linear: still no project for either thread (memory `floci-no-linear-yet`) — no issue tracking
beyond this file. ADRs still planned for console-on-emulated-cloud + dynamic service specs.

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
- KNOWN ISSUE: 3 DOs (runner-2/3/5) wedged — platform counts them running though the instances
  list says inactive; no per-instance kill API. Fix = delete+recreate the containers app (needs
  Alex's approval; config: v31, standard-4, instances/max 6, ENAM, DO namespace
  38f32b04c4884c2b8a75dd6d7a4089c9). Infra PR: abanna/floci-ui#1.

### Recommended next tasks (in order)
1. **Commit the branch** + PR (now includes SDK worker + v18–v26 image work; Alex's go-ahead pending).
2. Let the rerun wave drain; cron `ee2c63d1` (session-only, /20min) polls PRs: failures → diagnose,
   review comments → respond; report ready-to-merge set to Alex. NEVER self-merge.
3. Optionally: import live CF resources into Pulumi state (webhook already is; containers app is not).
4. Hardening: swap Alex's broad gh token for a fine-grained PAT (Self-hosted runners: RW).
5. Optional: custom domain on the worker; compose/buildx support (podman system service) if a repo
   genuinely needs it.

## Ops recipes (gotchas that cost time — don't re-derive)
- **Logs**: container stdout is NOT captured anywhere → entrypoint ships logs via
  `curl $WORKER_URL/debug/log`. Read them: telemetry query
  `POST /accounts/{id}/workers/observability/telemetry/query` `{view:"events", limit:N,
  timeframe:{from,to}, parameters:{datasets:["cloudflare-workers"], filters:[{key:"$workers.scriptName",
  operation:"eq", value:"nerds-run-gh-runners", type:"string"}]}}` (dataset is `cloudflare-workers`,
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

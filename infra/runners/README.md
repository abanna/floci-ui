# gh-runners — 3 self-hosted GitHub Actions runners on Cloudflare

> **STATUS (2026-08-30): LIVE — end-to-end verified, including container jobs.**
> Worker `nerds-run-gh-runners` + containers app `nerds-run-gh-runners-runnercontainer` (3 fixed
> instances `runner-0/1/2`) run image `…/nerds-run-gh-runners/runnercontainer:v21` — rootless
> Podman/Buildah, no daemon. Jobs: `podman run`, networked `podman build`, and `docker run` (via
> shim) all verified on live CF infra (`nerds-run/cf-runner-test` run 33336844833).
> Note: the live CF resources were created out-of-band (not in Pulumi state); `pulumi up` would try
> to re-create them until imported.

Replaces GitHub-hosted runners for the `nerds-run` org with 3 ephemeral runners
running as **Cloudflare Containers** (4 vCPU / 12 GiB / 20 GB disk each), fully
outbound-only: GitHub reaches them via a webhook; runners talk to GitHub over
HTTPS polling. No inbound ports anywhere.

```
GitHub org nerds-run ──(workflow_job queued webhook, HMAC-SHA256)──►  CF Worker (TS)
                                                                        │ wake stopped instances
                                                         ┌──────────────┼──────────────┐
                                                      runner-0        runner-1        runner-2
                                                      containers: actions-runner image
                                                      + rootless Podman/Buildah (no daemon)
                                                      entrypoint: org PAT → registration token
                                                      → config --ephemeral → run.sh → prune → loop
```

Design notes:
- **Containers in jobs**: podman/buildah run rootless (user namespaces work on CF; /dev/net/tun and
  iptables do NOT, so dockerd/rootlesskit/slirp are impossible — v13–v17 proved it). Host networking
  is the only working mode; `docker`/`podman`/`buildah` wrappers inject `--network host` unless one
  is given. `docker compose`/`buildx` are not available. See `worker/Dockerfile` + `worker/network-wrapper.sh`.
- **Ephemeral**: each runner registers, runs exactly one job, deregisters (`--ephemeral`), re-registers
  for the next job. Fresh disk per boot; podman state pruned between jobs.
- **Wake-on-queue**: instances sleep after 30m idle. The org webhook (`workflow_job`) wakes sleeping
  instances; `onActivityExpired` in the Worker checks GitHub's `busy` flag so a running job is never
  interrupted by the idle sleep.
- **Registration via GitHub App** (no long-lived PAT): the container mints a 1-hour registration token
  at each boot from the App credentials passed as Worker secrets.
- **Why wrangler inside Pulumi**: pulumi-cloudflare has no Containers resources yet, so the CF side
  (Worker + containers app) deploys via a `command:local:Command` step running `wrangler deploy`.
  It re-runs when worker sources (content hash) or secrets change. GitHub resources are native pulumi-github.
- Target workflows with: `runs-on: [self-hosted, cf-runner]`

## Remaining steps to go live

No GitHub App / private key needed — registration and busy-checks use a token with `admin:org`.

1. ☐ `gh auth refresh -h github.com -s admin:org -s admin:org_hook` (one browser confirm)
2. ☐ `cd infra/runners && pulumi config set --secret githubToken "$(gh auth token)" && pulumi up`
   (creates the org webhook; Claude then sets the `GH_PAT` Worker secret via the API and wakes the pool)
3. ☐ Test with the `cf-runner-test` workflow (below).

> Hardening note: the `admin:org` token is broader than strictly needed. Later, swap it for a
> fine-grained PAT with only *Organization → Self-hosted runners: RW* (set as `GH_PAT` secret)
> without touching anything else.

## One-time setup

1. **GitHub App** (org `nerds-run`):
   - Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - Name it (e.g. `nerds-run runners`); leave webhook URL empty; no callback URL.
   - Permissions → Organization → **Self-hosted runners: Read and write**.
   - "Where can this GitHub App be installed?" → **Only on this account**. Create, then **Install**
     on `nerds-run`.
   - Collect the **App ID** (app settings page) and **generate a private key** (downloads a `.pem`).
2. **Cloudflare API token**: My Profile → API Tokens → Create Custom Token:
   - Account → **Workers Scripts → Edit**, Account → **Containers → Edit** (labels as shown in the UI),
     account resources: iResolved, LLC. No zone permissions needed (uses `*.workers.dev`).
3. **GitHub token for Pulumi** (org webhook management needs `admin:org_hook`, which your usual
   `gh` token lacks): create a **classic PAT** with scope `admin:org_hook`.
4. Feed the stack (from `infra/runners/`):
   ```bash
   pulumi config set cfAccountId 97b0dab10c55d2e8a6c952eb4e4914ac   # already set
   pulumi config set --secret cfApiToken '<cloudflare api token>'    # replace placeholder
   pulumi config set --secret ghAppId '<github app id>'              # replace placeholder
   pulumi config set --secret ghAppPrivateKey "$(cat path/to/app.private-key.pem)"
   pulumi config set --secret githubToken '<classic PAT with admin:org_hook>'
   ```

## Deploy & verify

```bash
cd infra/runners
pulumi up                          # deploys worker+containers, creates org webhook

curl "https://nerds-run-gh-runners.<subdomain>.workers.dev/health"
# → {"runners":[{"id":"runner-0","status":"stopped",...}, ...]}

gh api orgs/nerds-run/actions/runners              # empty until first job

# start all three without a job:
SEC=$(pulumi stack output webhookSecret --show-secrets)
curl -X POST -H "Authorization: Bearer $SEC" "https://nerds-run-gh-runners.<subdomain>.workers.dev/wake"
gh api orgs/nerds-run/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Test workflow in any org repo:

```yaml
# .github/workflows/cf-runner-test.yml
name: cf-runner-test
on: workflow_dispatch
jobs:
  test:
    runs-on: [self-hosted, cf-runner]
    steps:
      - run: uname -a && podman run --rm docker.io/library/alpine:3 echo hi   # or: docker run (shimmed to podman)
```

Expected: webhook fires → a sleeping instance starts (~15–30s cold start) → job runs on
`cf-runner-*` → runner deregisters/re-registers (ephemeral) → instance sleeps 30m after the last job.

## Operations

- Logs: `cd infra/runners/worker && bunx wrangler tail` (also: Cloudflare dashboard → Workers →
  nerds-run-gh-runners → Logs).
- Stuck/queued job (e.g. a missed webhook delivery): re-deliver from GitHub → Org Settings →
  Webhooks, or hit the `/wake` endpoint above.
- Redeploy after editing worker sources: `pulumi up` (re-hashes sources → reruns wrangler), or
  directly `cd worker && bunx wrangler deploy` for a quick iteration (then `pulumi up` to sync state).
- Image changes (Dockerfile/entrypoint/wrapper): build + push a new tag to
  `registry.cloudflare.com/97b0dab10c55d2e8a6c952eb4e4914ac/nerds-run-gh-runners/runnercontainer`,
  then roll via `POST /accounts/{id}/containers/applications/a03e4d67-cd73-455b-9127-d75ff0399c5d/rollouts`
  (PATCH alone does NOT roll). Registry creds: `POST .../containers/registries/registry.cloudflare.com/credentials`
  — JWTs expire after 15 min, so mint right before pushing.
- Runner group isolation (optional): create group `cloudflare` in org settings, set
  `pulumi config set runnerGroup cloudflare`, and set `"RUNNER_GROUP": "cloudflare"` in
  `worker/wrangler.jsonc`. Restrict group → repo access in the GitHub UI.

## Limits & trade-offs

- Linux/amd64 only, max 3 concurrent jobs (that's the pool), no cross-job cache reuse (ephemeral by design).
- 20 GB ephemeral disk per instance — big Docker builds should prune or push layers as they go.
- Cloudflare does not guarantee indefinite container uptime (host restarts happen); the wake path
  makes runners self-heal: a stopped instance is restarted by the next queued-job webhook.
- Containers pricing bills memory for the lifetime of the instance + CPU when active; idle
  instances sleep after 30 minutes, so an idle pool costs ~nothing.

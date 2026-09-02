// GitHub Actions runners on Cloudflare Containers.
//
// Built on the @cloudflare/containers SDK Container class: the SDK maintains
// the keep-alive alarm loop every container DO requires (a container DO that
// stops having alarms is evicted by the platform within 70-140s, which
// SIGTERMs the container mid-job — hand-rolling this produced exactly that
// failure mode). Idle sleep is driven by GitHub's per-runner `busy` flag:
// onActivityExpired() only stops the container once the runner has been idle
// for sleepAfter, so a running job is never interrupted. NOTE: the busy check
// MUST be name-filtered — the org runner list is dominated by hundreds of
// unrelated ephemeral runners, and the old unfiltered page-1 check made the
// idle-sleep path SIGTERM busy runners.
//
// 3 fixed instances (runner-0..2). GitHub org webhook (workflow_job) wakes
// sleeping instances; each container registers itself with GitHub as an
// ephemeral runner at boot (see Dockerfile entrypoint.sh). Registration and
// busy checks use a classic PAT with `admin:org` (GH_PAT secret) — no GitHub
// App / private key required.
import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export const RUNNER_IDS = [
	"runner-0",
	"runner-1",
	"runner-2",
	"runner-3",
	"runner-4",
	"runner-5",
] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export type Env = {
	RUNNER_CONTAINER: DurableObjectNamespace<RunnerContainer>;
	CACHE: R2Bucket;
	// vars
	GH_ORG: string;
	RUNNER_GROUP: string;
	RUNNER_LABELS: string;
	// secrets
	GH_PAT: string;
	WEBHOOK_SECRET: string;
};

function runnerEnv(env: Env, id: RunnerId, workerUrl?: string) {
	return {
		envVars: {
			RUNNER_NAME: `cf-${id}`,
			GH_ORG: env.GH_ORG,
			RUNNER_GROUP: env.RUNNER_GROUP,
			RUNNER_LABELS: env.RUNNER_LABELS,
			GH_PAT: env.GH_PAT,
			WEBHOOK_SECRET: env.WEBHOOK_SECRET,
			WORKER_URL: workerUrl ?? "",
		} as Record<string, string>,
		enableInternet: true,
	};
}

export class RunnerContainer extends Container {
	// Idle deadline. Extended while GitHub reports the runner busy, so long
	// jobs are never cut short; see onActivityExpired(). Kept generous
	// deliberately: warm caches (tmpfs + HOME) persist for the container's
	// lifetime, so a runner that stays up between pushes starts jobs hot.
	// Trade-off: idle containers bill memory while up.
	sleepAfter = "2h";

	override async onActivityExpired(): Promise<void> {
		const name = this.runnerName();
		let busy: boolean;
		try {
			busy = await isRunnerBusy(name);
		} catch (e) {
			// Fail open: a transient GitHub error must not kill a possibly-busy runner.
			console.error(`${name}: busy check failed, keeping alive`, e);
			this.renewActivityTimeout();
			return;
		}
		if (busy) {
			console.log(`${name}: busy, renewing`);
			this.renewActivityTimeout();
			return;
		}
		console.log(`${name}: idle past sleep deadline, stopping container`);
		await this.stop(); // SIGTERM; entrypoint trap deregisters cleanly
	}

	override onStop(params: { exitCode?: number; reason?: string }): void | Promise<void> {
		return this.ctx.storage.put("status", { status: `stopped:${params.exitCode ?? ""}` });
	}

	async getStatus(): Promise<{ status: string }> {
		return (await this.ctx.storage.get<{ status: string }>("status")) ?? { status: "stopped" };
	}

	/** Platform truth about the container process, independent of bookkeeping. */
	async isUp(): Promise<boolean> {
		const state = await this.getState().catch(() => null);
		return state?.status === "running" || this.ctx.container?.running === true;
	}

	/** Debug: SIGTERM the running container. */
	async stopContainer(): Promise<void> {
		await this.stop();
	}

	private runnerName(): string {
		return `cf-${this.ctx.id.name ?? "runner"}`;
	}
}

// --- GitHub helpers (Worker side, for busy checks) ---

let moduleEnv: Env | null = null;
function getEnv(): Env {
	moduleEnv ??= env as Env;
	return moduleEnv;
}

/** Busy check for ONE runner, server-side filtered by name.
 *
 *  The naive variant fetched page 1 of the org runner list unfiltered — with
 *  hundreds of other ephemeral runners in the org, this runner's busy flag is
 *  almost never on page 1, so the idle-sleep path saw "nothing busy" and
 *  SIGTERMed containers mid-job ("lost communication" failures). */
async function isRunnerBusy(name: string): Promise<boolean> {
	const e = getEnv();
	const res = await fetch(
		`https://api.github.com/orgs/${e.GH_ORG}/actions/runners?name=${encodeURIComponent(name)}&per_page=10`,
		{ headers: { Authorization: `Bearer ${e.GH_PAT}`, Accept: "application/vnd.github+json" } },
	);
	if (!res.ok) throw new Error(`runners API ${res.status}: ${await res.text()}`);
	const body = (await res.json()) as { runners: { name: string; busy: boolean }[] };
	return body.runners.some((r) => r.busy);
}

// --- HTTP surface ---

type WorkflowJobPayload = {
	action?: string;
	workflow_job?: { id: number; name: string };
	repository?: { full_name: string };
};

export default {
	async fetch(request, env: Env, ctx: ExecutionContext): Promise<Response> {
		moduleEnv ??= env;
		const url = new URL(request.url);
		const origin = url.origin;
		if (request.method === "GET" && url.pathname === "/health") return health(env);
		if (request.method === "POST" && url.pathname === "/webhook") return handleWebhook(request, env, ctx, origin);
		if (request.method === "POST" && url.pathname === "/wake") return handleWake(request, env, ctx, origin);
		if (request.method === "POST" && url.pathname === "/debug") return handleDebug(request, env, ctx);
		if (url.pathname.startsWith("/cache/")) return handleCache(request, env);
		if (request.method === "POST" && url.pathname === "/debug/log") {
			const auth = request.headers.get("authorization") ?? "";
			if (!timingSafeEqual(auth, `Bearer ${env.WEBHOOK_SECRET}`)) return new Response(null, { status: 401 });
			console.log(await request.text());
			return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function health(env: Env): Promise<Response> {
	const runners = await Promise.all(
		RUNNER_IDS.map(async (id) => {
			try {
				const s = await getStub(env, id).getStatus();
				return { id, status: s.status };
			} catch {
				return { id, status: "stopped" };
			}
		}),
	);
	return Response.json({ runners });
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Fleet-shared build cache: containers GET warm cache tarballs at boot and PUT
// fresh snapshots after jobs. Auth is the webhook secret (containers already
// hold it); the R2 binding means no S3 credentials anywhere. Last-writer-wins
// per key — build caches are self-healing, so a stale overwrite is harmless.
async function handleCache(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("authorization") ?? "";
	if (!timingSafeEqual(auth, `Bearer ${env.WEBHOOK_SECRET}`)) return new Response(null, { status: 401 });
	const key = decodeURIComponent(new URL(request.url).pathname.slice("/cache/".length));
	if (!key || key.includes("..")) return Response.json({ error: "bad key" }, { status: 400 });
	if (request.method === "GET") {
		const obj = await env.CACHE.get(key);
		if (!obj) return new Response(null, { status: 404 });
		return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
	}
	if (request.method === "PUT") {
		await env.CACHE.put(key, request.body);
		return new Response(null, { status: 204 });
	}
	return Response.json({ error: "method" }, { status: 405 });
}

async function verifySignature(body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> {
	if (!header?.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, body);
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return timingSafeEqual(header.slice("sha256=".length), hex);
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
	const raw = await request.arrayBuffer();
	if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET))) {
		return Response.json({ error: "invalid signature" }, { status: 401 });
	}
	const event = request.headers.get("x-github-event");
	if (event !== "workflow_job") return Response.json({ ignored: event ?? null });
	const payload = JSON.parse(new TextDecoder().decode(raw)) as WorkflowJobPayload;
	if (payload.action !== "queued") return Response.json({ ignored: `workflow_job.${payload.action}` });
	const woken = await wakeStopped(env, ctx, null, origin);
	console.log(`workflow_job ${payload.workflow_job?.id} queued (${payload.repository?.full_name}); woke ${woken.join(",") || "none"}`);
	return Response.json({ action: payload.action, woken });
}

// Ops endpoint: `curl -X POST -H "Authorization: Bearer $WEBHOOK_SECRET" .../wake`
async function handleWake(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
	const auth = request.headers.get("authorization") ?? "";
	if (!timingSafeEqual(auth, `Bearer ${env.WEBHOOK_SECRET}`)) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const woken = await wakeStopped(env, ctx, new URL(request.url).searchParams.get("only"), origin);
	return Response.json({ woken }, { status: woken.length > 0 ? 202 : 200 });
}

function getStub(env: Env, id: RunnerId): DurableObjectStub<RunnerContainer> {
	return env.RUNNER_CONTAINER.getByName(id);
}

// Debug probes: start runner-N with a `sh -c` entrypoint whose exit code encodes
// the answer — visible via /health as status "stopped:0" (pass) / "stopped:1" (fail).
async function handleDebug(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const auth = request.headers.get("authorization") ?? "";
	if (!timingSafeEqual(auth, `Bearer ${env.WEBHOOK_SECRET}`)) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const probe = new URL(request.url).searchParams.get("probe") ?? "pat";
	if (probe === "stop") {
		const target = getStub(env, (new URL(request.url).searchParams.get("id") ?? "runner-0") as RunnerId);
		await target.stopContainer();
		return Response.json({ stopped: true });
	}
	const only = new URL(request.url).searchParams.get("only");
	const script =
		probe === "pat"
			? 'test -n "$GH_PAT"'
			: probe === "config"
				? 'test -x /home/runner/config.sh'
				: probe === "dns"
					? 'o=$(echo resolv=$(tr \n ";" < /etc/resolv.conf); echo getent=$(getent hosts github.com | head -1); echo zen4=$(curl -4 -s -m 8 https://api.github.com/zen); echo zen=$(curl -s -m 8 https://api.github.com/zen); echo v6route=$(ip -6 route | head -3)); curl -s -m 5 -X POST -H "Authorization: Bearer $WEBHOOK_SECRET" --data "$o" "$WORKER_URL/debug/log" >/dev/null; exit 0'
						: probe === "fuse"
					? 'o=$(echo fuse=$(ls -l /dev/fuse 2>&1); echo fusermount=$(which fusermount3 fusermount 2>&1 | head -1); echo s3fs=$(which s3fs mount.s3fs 2>&1 | head -1)); curl -s -m 5 -X POST -H "Authorization: Bearer $WEBHOOK_SECRET" --data "$o" "$WORKER_URL/debug/log" >/dev/null; exit 0'
					: probe === "userns"
						? 'o=$(echo clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>&1); echo maxns=$(cat /proc/sys/user/max_user_namespaces 2>&1); echo tun=$(ls -l /dev/net/tun 2>&1); echo unshare=$(unshare -Ur echo USERNS-OK 2>&1)); curl -s -m 5 -X POST -H "Authorization: Bearer $WEBHOOK_SECRET" --data "$o" "$WORKER_URL/debug/log" >/dev/null; exit 0'
						: 'echo unknown-probe; exit 1';
	const stub = getStub(env, (new URL(request.url).searchParams.get("id") ?? "runner-0") as RunnerId);
	const up = await stub.isUp().catch(() => false);
	if (up) return Response.json({ error: "runner busy; wake-stopped it first" }, { status: 409 });
	ctx.waitUntil(
		stub
			.start({ ...runnerEnv(env, "runner-0", new URL(request.url).origin), entrypoint: ["/bin/sh", "-c", script] })
			.catch((e) => console.error("debug start failed", e)),
	);
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 500));
		const s = await stub.getStatus().catch(() => ({ status: "?" }));
		if (s.status !== "running") return Response.json({ probe, exit: s.status });
	}
	return Response.json({ probe, status: "still-running after 20s" });
}

// Start every instance that isn't running. The SDK's start() is a no-op when
// the container is already up, so always call it — bookkeeping state can go
// stale (e.g. a rollout-started env-less boot that exited), and an isUp()
// precheck would strand queued jobs on a dead container.
//
// Self-heal: a container that is "up" per the SDK but has no GitHub runner
// registration is a zombie (stale state after a platform kill); force-stop it
// so the subsequent start boots fresh. Without this, zombie state survives
// wake cycles indefinitely and the runner never comes back.
async function wakeStopped(env: Env, ctx: ExecutionContext, only?: string | null, origin = ""): Promise<string[]> {
	const woken: string[] = [];
	for (const id of RUNNER_IDS) {
		if (only && id !== only) continue;
		const stub = getStub(env, id);
		ctx.waitUntil(
			(async () => {
				const name = `cf-${id}`;
				const up = await stub.isUp().catch(() => false);
				if (up) {
					const present = await runnerExists(name).catch(() => true);
					if (present) {
						console.log(`${id}: up and registered, leaving alone`);
						return;
					}
					console.log(`${id}: up but unregistered — force reset`);
					await stub.stopContainer().catch(() => {});
					await new Promise((r) => setTimeout(r, 3000));
				}
				await stub.start(runnerEnv(env, id, origin));
				console.log(`${id}: started`);
			})().catch((e) => console.error(`${id}: wake failed`, e)),
		);
		woken.push(id);
	}
	return woken;
}

/** Does an ONLINE GitHub runner with this exact name exist in the org?
 *  Offline ghosts (killed container that never deregistered) don't count —
 *  treating them as present would leave zombie containers unhealed. */
async function runnerExists(name: string): Promise<boolean> {
	const e = getEnv();
	const res = await fetch(
		`https://api.github.com/orgs/${e.GH_ORG}/actions/runners?name=${encodeURIComponent(name)}&per_page=10`,
		{ headers: { Authorization: `Bearer ${e.GH_PAT}`, Accept: "application/vnd.github+json" } },
	);
	if (!res.ok) throw new Error(`runners API ${res.status}: ${await res.text()}`);
	const body = (await res.json()) as { runners: { name: string; status: string }[] };
	return body.runners.some((r) => r.name === name && r.status === "online");
}

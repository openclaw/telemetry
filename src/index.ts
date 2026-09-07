import { keepKnownNames, loadKnownNames, normalizeVersion } from "./allowlist.js";
import { buildDataPoint } from "./analytics.js";
import type { Env } from "./env.js";
import { readFeatureStats } from "./feature-stats.js";
import { parseClientIdentity } from "./payload.js";
import { renderHomePage } from "./page.js";
import { queryPublicStats } from "./stats.js";

const UPSTREAM_VERSION_URL = "https://registry.npmjs.org/openclaw/latest";
const UPSTREAM_TIMEOUT_MS = 5_000;
/**
 * Clients ask at most once a day, so a short edge cache is enough to keep npm
 * out of the hot path while never serving a stale release for long.
 */
const VERSION_CACHE_SECONDS = 300;
/**
 * JSON Cache-Control is not a default edge hit, so store the same 600s TTL.
 */
const STATS_CACHE_SECONDS = 600;
const STATS_CACHE_KEY = "https://telemetry.openclaw.ai/api/stats?cache=reports-v2";

/**
 * Operator-visible note attached to update checks. Keep empty in normal
 * operation; set it only to flag a release worth acting on immediately.
 */
const RELEASE_NOTE = "";

type LatestVersion = { version: string; note?: string };

function jsonResponse(body: unknown, status = 200, cacheSeconds = 0): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
			"access-control-allow-origin": "*",
		},
	});
}

async function fetchLatestVersion(): Promise<LatestVersion | undefined> {
	const cache = caches.default;
	const cacheKey = new Request(UPSTREAM_VERSION_URL, { method: "GET" });
	const cached = await cache.match(cacheKey);
	if (cached) {
		const body = (await cached.json()) as { version?: unknown };
		if (typeof body.version === "string") return { version: body.version };
	}

	const upstream = await fetch(UPSTREAM_VERSION_URL, {
		headers: { accept: "application/json", "user-agent": "openclaw-telemetry-worker" },
		signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	}).catch(() => undefined);
	if (!upstream?.ok) return undefined;

	const body = (await upstream.json().catch(() => undefined)) as { version?: unknown } | undefined;
	if (typeof body?.version !== "string" || !body.version.trim()) return undefined;

	const version = body.version.trim();
	await cache.put(
		cacheKey,
		new Response(JSON.stringify({ version }), {
			headers: {
				"content-type": "application/json",
				"cache-control": `public, max-age=${VERSION_CACHE_SECONDS}`,
			},
		}),
	);
	return { version };
}

async function withinRateLimit(request: Request, env: Env, prefix = ""): Promise<boolean> {
	const limiter = env.RATE_LIMIT;
	if (!limiter) return true;
	const key = prefix + (request.headers.get("cf-connecting-ip") ?? "unknown");
	const outcome = await limiter.limit({ key }).catch(() => undefined);
	return outcome?.success !== false;
}

/**
 * Per-IP limit on how many requests may be *recorded*. A real install reports
 * once a day, so this only bites on floods. The client IP is used for the
 * decision and never stored.
 */
async function mayRecord(request: Request, env: Env): Promise<boolean> {
	return withinRateLimit(request, env);
}

async function handlePublicStats(request: Request, env: Env): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(STATS_CACHE_KEY, { method: "GET" });
	// Cache availability must not decide whether a successful SQL result is served.
	const cached = await cache.match(cacheKey).catch(() => undefined);
	if (cached) {
		const ageHeader = cached.headers.get("age") ?? "";
		const age = /^\d+$/u.test(ageHeader) ? Number(ageHeader) : NaN;
		if (age < STATS_CACHE_SECONDS) {
			// Cache policy can widen max-age. Restore our bound without resetting Age.
			const response = new Response(cached.body, cached);
			response.headers.set("cache-control", `public, max-age=${STATS_CACHE_SECONDS}`);
			return response;
		}
		// A tee's cancellation can wait for another reader; do not delay the miss.
		void cached.body?.cancel().catch(() => {});
	}

	// Keep public reads independent of the existing, unprefixed recording counter.
	if (!(await withinRateLimit(request, env, "stats:"))) {
		return jsonResponse({ error: "rate_limited" }, 429);
	}

	const stats = await queryPublicStats(env);
	if (!stats) return jsonResponse({ error: "stats_unavailable" }, 503);

	const response = jsonResponse(stats, 200, STATS_CACHE_SECONDS);
	await cache.put(cacheKey, response.clone()).catch(() => {});
	return response;
}

async function recordRequest(request: Request, env: Env): Promise<void> {
	// Over-limit callers still get their answer below; they just stop counting.
	if (!(await mayRecord(request, env))) return;

	const identity = parseClientIdentity(request.headers.get("user-agent"));
	const features = await readFeatureStats(request);
	const known = features ? await loadKnownNames() : undefined;
	const validated = features
		? {
				...features,
				channels: keepKnownNames(features.channels, known),
				providerFamilies: keepKnownNames(features.providerFamilies, known),
				plugins: keepKnownNames(features.plugins, known),
			}
		: undefined;

	try {
		env.TELEMETRY.writeDataPoint(
			buildDataPoint({ ...identity, version: normalizeVersion(identity.version) }, validated),
		);
	} catch {
		// Intentionally ignored: an analytics failure is not a client failure.
	}
}

async function handleLatestVersion(request: Request, env: Env): Promise<Response> {
	await recordRequest(request, env);

	const latest = await fetchLatestVersion();
	if (!latest) return jsonResponse({ error: "version_unavailable" }, 503);
	return jsonResponse(RELEASE_NOTE ? { ...latest, note: RELEASE_NOTE } : latest, 200, VERSION_CACHE_SECONDS);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/latest-version") {
			if (request.method !== "GET" && request.method !== "POST") {
				return jsonResponse({ error: "method_not_allowed" }, 405);
			}
			return handleLatestVersion(request, env);
		}

		if (url.pathname === "/api/stats") {
			return handlePublicStats(request, env);
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(renderHomePage(), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
			});
		}

		return jsonResponse({ error: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;

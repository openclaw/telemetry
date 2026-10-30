import { normalizeVersion } from "./allowlist.js";
import { buildDataPoint } from "./analytics.js";
import type { Env } from "./env.js";
import { readCappedBody } from "./feature-stats.js";
import { INSTALLATION_COUNT_HEADER, INSTALLATION_COUNT_USER_AGENT, parseInstallationCount, pruneInstallationCounts, recordInstallationCount } from "./installation-count.js";
import { parseRequestGeography } from "./geography.js";
import { parseClientIdentity, parseFeatureStats } from "./payload.js";
import type { FeatureStats } from "./payload.js";
import { buildUpdateResultPoint, isUpdateResultCandidate, MAX_UPDATE_RESULT_BYTES, parseUpdateResult, UPDATE_RESULT_USER_AGENT } from "./update-result.js";
import { renderHomePage } from "./page.js";

const UPSTREAM_VERSION_URL = "https://registry.npmjs.org/openclaw/latest";
const UPSTREAM_TIMEOUT_MS = 5_000;
/**
 * Clients ask at most once a day, so a short edge cache is enough to keep npm
 * out of the hot path while never serving a stale release for long.
 */
const VERSION_CACHE_SECONDS = 300;
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
	try {
		const cached = await cache.match(cacheKey);
		if (cached) {
			const version = readVersion(await cached.json());
			if (version) return { version };
		}
	} catch {
		// Unreadable or malformed cache entries are misses, not failed update checks.
	}

	const upstream = await fetch(UPSTREAM_VERSION_URL, {
		headers: { accept: "application/json", "user-agent": "openclaw-telemetry-worker" },
		signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	}).catch(() => undefined);
	if (!upstream?.ok) return undefined;

	const version = readVersion(await upstream.json().catch(() => undefined));
	if (!version) return undefined;

	try {
		await cache.put(
			cacheKey,
			new Response(JSON.stringify({ version }), {
				headers: {
					"content-type": "application/json",
					"cache-control": `public, max-age=${VERSION_CACHE_SECONDS}`,
				},
			}),
		);
	} catch {
		// A cache write failure must not discard a valid upstream answer.
	}
	return { version };
}

function readVersion(body: unknown): string | undefined {
	if (
		typeof body !== "object" ||
		body === null ||
		!("version" in body) ||
		typeof body.version !== "string"
	)
		return undefined;
	return body.version.trim() || undefined;
}

/** Per-IP limit on recording; over-limit callers still receive update answers. */
async function mayRecord(request: Request, env: Env): Promise<boolean> {
	const limiter = env.RATE_LIMIT;
	if (!limiter) return true;
	const key = request.headers.get("cf-connecting-ip") ?? "unknown";
	const outcome = await limiter.limit({ key }).catch(() => undefined);
	return outcome?.success !== false;
}

function recordRequest(request: Request, env: Env, features: FeatureStats | undefined): void {
	const identity = parseClientIdentity(request.headers.get("user-agent"));

	try {
		env.TELEMETRY.writeDataPoint(
			buildDataPoint(
				{ ...identity, version: normalizeVersion(identity.version) },
				features,
				parseRequestGeography(request.cf),
			),
		);
	} catch {
		// Intentionally ignored: an analytics failure is not a client failure.
	}
}

async function handleLatestVersion(request: Request, env: Env): Promise<Response> {
	// Check recording quota exactly once, before reading any upload. Exhausted
	// callers must still get a version answer even if their body never finishes.
	if (!(await mayRecord(request, env))) return latestVersionResponse(
		Boolean(env.INSTALLATION_COUNTS) && request.method === "GET" &&
		request.headers.get("user-agent") !== UPDATE_RESULT_USER_AGENT,
	);

	let parsed: unknown;
	if (request.method === "POST") {
		// The fixed UA keeps even malformed/oversized outcome uploads off the
		// legacy identity/geography path. JSON discriminators also work without it.
		const outcomeAgent = request.headers.get("user-agent") === UPDATE_RESULT_USER_AGENT;
		const body = await readCappedBody(request, outcomeAgent ? MAX_UPDATE_RESULT_BYTES : undefined);
		const raw = body?.text;
		try { parsed = raw ? JSON.parse(raw) : undefined; } catch { /* Never log request bodies. */ }
		if (outcomeAgent || isUpdateResultCandidate(parsed)) {
			const result = body && body.byteLength <= MAX_UPDATE_RESULT_BYTES
				? parseUpdateResult(parsed) : undefined;
			if (!result) return jsonResponse({ error: "invalid_update_result" }, 400);
			if (!env.UPDATE_RESULTS) return jsonResponse({ error: "update_results_unavailable" }, 503);
			try { env.UPDATE_RESULTS.writeDataPoint(buildUpdateResultPoint(result)); }
			catch { return jsonResponse({ error: "update_results_unavailable" }, 503); }
			return latestVersionResponse();
		}
	}
	const features = parseFeatureStats(parsed);
	recordRequest(request, env, features);
	// A successful ordinary update answer can advertise counting support. Never
	// infer capability from an outcome, an invalid feature upload or an error.
	return latestVersionResponse(Boolean(env.INSTALLATION_COUNTS) &&
		(request.method === "GET" || Boolean(features)) &&
		request.headers.get("user-agent") !== UPDATE_RESULT_USER_AGENT);
}

async function latestVersionResponse(advertiseInstallationCount = false): Promise<Response> {
	const latest = await fetchLatestVersion();
	if (!latest) return jsonResponse({ error: "version_unavailable" }, 503);
	const response = jsonResponse(RELEASE_NOTE ? { ...latest, note: RELEASE_NOTE } : latest,
		200, advertiseInstallationCount ? 0 : VERSION_CACHE_SECONDS);
	if (advertiseInstallationCount) {
		// Capture the authoritative day once, after the version lookup. The npm
		// cache still works, but this day-bearing response must never be cached.
		const day = Math.floor(Date.now() / 86_400_000);
		response.headers.set(INSTALLATION_COUNT_HEADER, `1;${day}`);
	}
	return response;
}

function installationCountResponse(status: number): Response {
	return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

/** Validate provider-trusted HTTP framing synchronously; never read a stream. */
function hasEmptyInstallationCountBody(request: Request): boolean {
	if (request.headers.has("transfer-encoding")) return false;
	const length = request.headers.get("content-length");
	// Real workerd exposes a non-null stream even for a Node fetch POST with
	// Content-Length: 0. Trust that physical HTTP framing, not stream EOF.
	return length === "0" || (length === null && request.body === null);
}

async function handleInstallationCount(request: Request, env: Env): Promise<Response> {
	const now = Date.now();
	const count = parseInstallationCount(request.headers.get(INSTALLATION_COUNT_HEADER), now);
	if (request.method !== "POST" || !count ||
		request.headers.get("user-agent") !== INSTALLATION_COUNT_USER_AGENT) return installationCountResponse(400);
	// Count requests never fall through to legacy analytics or a version lookup,
	// even when malformed, quota-exhausted or unavailable. IP stays a limiter key.
	if (!hasEmptyInstallationCountBody(request)) return installationCountResponse(400);
	if (!(await mayRecord(request, env))) return installationCountResponse(204);
	if (!env.INSTALLATION_COUNTS || request.headers.get("dnt") === "1") return installationCountResponse(204);
	// The existing limiter await can cross midnight. Validate again at the
	// write boundary and use that clock for retention pruning.
	const recordedAt = Date.now();
	if (!parseInstallationCount(request.headers.get(INSTALLATION_COUNT_HEADER), recordedAt)) return installationCountResponse(400);
	try {
		await recordInstallationCount(env.INSTALLATION_COUNTS, count, recordedAt);
		return installationCountResponse(204);
	} catch {
		// Delivery can be ambiguous: no retry here or in the client, even on 503.
		return installationCountResponse(503);
	}
}

export default {
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await pruneInstallationCounts(env.INSTALLATION_COUNTS);
	},
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/latest-version") {
			// Header presence, not validity, selects the isolated count-only path.
			// The fixed count UA also fails closed when its header is missing.
			if (request.headers.has(INSTALLATION_COUNT_HEADER) ||
				request.headers.get("user-agent") === INSTALLATION_COUNT_USER_AGENT) {
				return handleInstallationCount(request, env);
			}
			// Capability only: no body, geography, recording quota, analytics or npm.
			// Presence is not a delivery/readiness probe; never write a sample point.
			if (request.method === "HEAD") {
				return new Response(null, {
					status: env.UPDATE_RESULTS ? 204 : 503,
					headers: env.UPDATE_RESULTS
						? { "OpenClaw-Update-Results": "2", "Cache-Control": "no-store" }
						: { "Cache-Control": "no-store" },
				});
			}
			if (request.method !== "GET" && request.method !== "POST") {
				return jsonResponse({ error: "method_not_allowed" }, 405);
			}
			return handleLatestVersion(request, env);
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(renderHomePage(), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
			});
		}

		return jsonResponse({ error: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;

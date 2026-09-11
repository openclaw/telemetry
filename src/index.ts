import { keepKnownNames, loadKnownNames, normalizeVersion } from "./allowlist.js";
import { buildDataPoint } from "./analytics.js";
import type { Env } from "./env.js";
import { readFeatureStats } from "./feature-stats.js";
import { parseRequestGeography } from "./geography.js";
import { parseClientIdentity } from "./payload.js";
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
			buildDataPoint(
				{ ...identity, version: normalizeVersion(identity.version) },
				validated,
				parseRequestGeography(request.cf),
			),
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

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(renderHomePage(), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
			});
		}

		return jsonResponse({ error: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;

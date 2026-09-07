/**
 * Independent server-side validation of the names a client reports.
 *
 * The client only sends publicly known ids, but this endpoint is unauthenticated:
 * anyone can POST anything. Because the aggregates are rendered on a public page,
 * an unvalidated name is user-generated content on our own site. So the server
 * accepts only names retained from immutable public OpenClaw metadata.
 *
 * Runtime catalog changes cannot admit names without retained public history.
 */

import { PUBLIC_NAMES, PUBLIC_VOCABULARY_CACHE_REVISION } from "./public-vocabulary.js";

const CATALOG_CACHE_SECONDS = 21_600;
const CATALOG_CACHE_KEY = `https://telemetry.openclaw.ai/internal/known-names-v2/${PUBLIC_VOCABULARY_CACHE_REVISION}`;

/** OpenClaw releases are `YYYY.M.PATCH` with an optional prerelease suffix. */
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:-[A-Za-z0-9.]{1,32})?$/u;

const UNKNOWN = "unknown";

/**
 * The cache namespace follows vocabulary content so deployments never reuse an
 * older or moving-catalog allowlist. Only a complete retained vocabulary is used.
 */
export async function loadKnownNames(): Promise<Set<string> | undefined> {
	const cache = caches.default;
	const cacheKey = new Request(CATALOG_CACHE_KEY);
	const cached = await cache.match(cacheKey);
	if (cached) {
		const body: unknown = await cached.json().catch(() => undefined);
		if (Array.isArray(body) && body.length === PUBLIC_NAMES.length &&
			body.every((name, index) => name === PUBLIC_NAMES[index])) return new Set(body);
	}

	const names = new Set<string>(PUBLIC_NAMES);
	await cache.put(
		cacheKey,
		new Response(JSON.stringify([...names]), {
			headers: {
				"content-type": "application/json",
				"cache-control": `public, max-age=${CATALOG_CACHE_SECONDS}`,
			},
		}),
	);
	return names;
}

export function keepKnownNames(values: string[], known: Set<string> | undefined): string[] {
	if (!known) return [];
	return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => known.has(value)))].sort();
}

/** Version strings render on the public stats page, so reject invented shapes. */
export function normalizeVersion(version: string): string {
	return VERSION_PATTERN.test(version) ? version : UNKNOWN;
}

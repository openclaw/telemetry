/**
 * Parsing and validation for everything a client may send us.
 *
 * The contract with the OpenClaw client is deliberately tiny: a User-Agent
 * string (always) and an optional feature-stats body (only when the operator
 * opted in). Anything we cannot parse is dropped rather than stored, so a
 * malformed or hostile request can never widen what this service records.
 */

export type ClientIdentity = {
	version: string;
	platform: string;
	arch: string;
	runtime: string;
	surface: string;
};

export type FeatureStats = {
	channels: string[];
	providerFamilies: string[];
	plugins: string[];
	pluginsEnabled: number;
	sessionsLast24h: number;
};

/** `openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)` */
const USER_AGENT_PATTERN =
	/^openclaw\/(?<version>[^\s(]+)\s+\((?<platform>[^;)]+);\s*(?<runtime>[^;)]+);\s*(?<arch>[^;)]+)(?:;\s*(?<surface>[^;)]+))?\)/u;

const UNKNOWN = "unknown";

/** Bounded so a hostile client cannot inflate what we store per data point. */
const MAX_FIELD_LENGTH = 64;
// Bound matching work before the regex; five stored fields fit within this limit.
const MAX_USER_AGENT_LENGTH = 512;
const MAX_LIST_ITEMS = 32;
const MAX_COUNT = 1_000_000;

function sanitizeField(value: string | undefined): string {
	if (!value) return UNKNOWN;
	const trimmed = value.trim().slice(0, MAX_FIELD_LENGTH);
	// Keep the recorded vocabulary boring: identifiers, dots, dashes, slashes.
	const cleaned = trimmed.replace(/[^A-Za-z0-9._/-]/gu, "");
	return cleaned || UNKNOWN;
}

export function parseClientIdentity(userAgent: string | null): ClientIdentity {
	const match =
		userAgent && userAgent.length <= MAX_USER_AGENT_LENGTH
			? userAgent.match(USER_AGENT_PATTERN)
			: null;
	const groups = match?.groups;
	return {
		version: sanitizeField(groups?.version),
		platform: sanitizeField(groups?.platform),
		arch: sanitizeField(groups?.arch),
		runtime: sanitizeField(groups?.runtime),
		surface: sanitizeField(groups?.surface),
	};
}

function sanitizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const items = value.filter(
		(entry): entry is string =>
			typeof entry === "string" &&
			entry.length > 0 &&
			entry.length <= MAX_FIELD_LENGTH &&
			!/[^A-Za-z0-9._/-]/u.test(entry) &&
			entry !== UNKNOWN,
	);
	// Sorted + de-duplicated so identical installs produce identical rows.
	return [...new Set(items)].sort().slice(0, MAX_LIST_ITEMS);
}

function sanitizeCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.min(Math.floor(value), MAX_COUNT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Projects an untrusted body down to the documented fields. Unknown keys
 * are dropped on the floor: if a future client sends more, this service keeps
 * storing only what its README promises until it is deliberately updated.
 */
export function parseFeatureStats(body: unknown): FeatureStats | undefined {
	if (!isRecord(body)) return undefined;
	if (body.schema !== 1) return undefined;
	const features = isRecord(body.features) ? body.features : undefined;
	if (!features) return undefined;
	return {
		channels: sanitizeList(features.channels),
		providerFamilies: sanitizeList(features.providerFamilies),
		plugins: sanitizeList(features.plugins),
		pluginsEnabled: sanitizeCount(features.pluginsEnabled),
		sessionsLast24h: sanitizeCount(features.sessionsLast24h),
	};
}

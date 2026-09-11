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

import { PUBLIC_NAMES } from "./public-vocabulary.js";

/** OpenClaw releases are `YYYY.M.PATCH` with an optional prerelease suffix. */
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:-[A-Za-z0-9.]{1,32})?$/u;

const UNKNOWN = "unknown";

/** No external services or shared mutable state are needed for compiled names. */
export async function loadKnownNames(): Promise<Set<string>> {
	return new Set(PUBLIC_NAMES);
}

export function keepKnownNames(values: string[], known: Set<string> | undefined): string[] {
	if (!known) return [];
	return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => known.has(value)))].sort();
}

/** Keep recorded version strings within the public release format. */
export function normalizeVersion(version: string): string {
	return VERSION_PATTERN.test(version) ? version : UNKNOWN;
}

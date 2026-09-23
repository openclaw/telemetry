/**
 * Independent server-side validation of the names a client reports.
 *
 * The client only sends publicly known ids, but this endpoint is unauthenticated:
 * anyone can POST anything. Only names retained from immutable public OpenClaw
 * metadata may enter analytics; private names must never be recorded.
 *
 * Runtime catalog changes cannot admit names without retained public history.
 */

import { PUBLIC_NAMES } from "./public-vocabulary.js";

/** OpenClaw releases are `YYYY.M.PATCH` with an optional prerelease suffix. */
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:-[A-Za-z0-9.]{1,32})?$/u;

const UNKNOWN = "unknown";
const knownNames = new Set<string>(PUBLIC_NAMES);

export function keepKnownNames(values: string[]): string[] {
	return [...new Set(values.map((value) => value.toLowerCase()).filter((value) => knownNames.has(value)))].sort();
}

/** Keep recorded version strings within the public release format. */
export function normalizeVersion(version: string): string {
	return VERSION_PATTERN.test(version) ? version : UNKNOWN;
}

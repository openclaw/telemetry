import type { DataPoint } from "./analytics.js";

export const MAX_UPDATE_RESULT_BYTES = 4_096;
export const UPDATE_RESULT_USER_AGENT = "openclaw-update-result/1";
const PUBLIC_VERSION = /^202[0-9]\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]{0,5})(?:-[1-9][0-9]{0,2})?(?:-beta\.[1-9][0-9]{0,2})?$/;

// Every value is a bounded public label, never an arbitrary diagnostic string.
const LABELS = {
	outcome: ["succeeded", "failed", "rolled-back"],
	platform: ["linux", "darwin", "win32", "freebsd", "openbsd", "unknown"],
	arch: ["x64", "arm64", "arm", "ia32", "unknown"],
	installMethod: ["git-checkout", "npm-global", "pnpm-global", "bun-global", "managed-service", "unknown"],
	channel: ["stable", "beta", "dev", "extended-stable", "unknown"],
	duration: ["under-10s", "under-1m", "under-5m", "under-30m", "over-30m", "unknown"],
	postCheck: ["passed", "failed", "unknown"],
	failedStage: ["requested", "staging", "validating", "repairing", "activating", "restarting", "verifying", "unknown", "none"],
	errorCategory: ["permission", "network", "timeout", "storage", "other", "none"],
	errorCode: ["EACCES", "EPERM", "ENOSPC", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "unknown", "none"],
	rollback: ["not-needed", "not-attempted", "succeeded", "failed", "unknown"],
	recovery: ["safe", "unsafe", "unknown"],
} as const;
const VERSIONS = ["fromVersion", "targetVersion", "resultingVersion", "runningVersion"] as const;
type VersionField = typeof VERSIONS[number];
export type UpdateResult = {
	schema: 2;
	event: "update_result";
} & { [K in keyof typeof LABELS]: typeof LABELS[K][number] } & Record<VersionField, string>;
const KEYS = new Set(["schema", "event", ...VERSIONS, ...Object.keys(LABELS)]);

export function isUpdateResultCandidate(value: unknown): boolean {
	return typeof value === "object" && value !== null &&
		(("schema" in value && value.schema === 2) || ("event" in value && value.event === "update_result"));
}

export function parseUpdateResult(value: unknown): UpdateResult | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== KEYS.size || Object.keys(record).some((key) => !KEYS.has(key))) return undefined;
	if (record.schema !== 2 || record.event !== "update_result") return undefined;
	for (const key of VERSIONS) {
		const version = record[key];
		if (typeof version !== "string" || (version !== "unknown" && PUBLIC_VERSION.exec(version)?.[0] !== version)) return undefined;
	}
	for (const [key, labels] of Object.entries(LABELS)) {
		if (typeof record[key] !== "string" || !(labels as readonly string[]).includes(record[key])) return undefined;
	}
	if (record.outcome === "succeeded" &&
		(record.failedStage !== "none" || record.errorCategory !== "none" || record.errorCode !== "none")) return undefined;
	return record as UpdateResult;
}

/** Dedicated dataset contract: no request metadata, IDs, geography, or raw errors. */
export function buildUpdateResultPoint(result: UpdateResult): DataPoint {
	return {
		indexes: [result.targetVersion],
		blobs: [
			result.event, result.outcome, result.fromVersion, result.targetVersion,
			result.resultingVersion, result.runningVersion, result.platform, result.arch,
			result.installMethod, result.channel, result.duration, result.postCheck,
			result.failedStage, result.errorCategory, result.errorCode, result.rollback, result.recovery,
		],
		doubles: [result.schema],
	};
}

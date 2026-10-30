/** Aggregate-only histogram: never receives request metadata or an identifier. */
export const INSTALLATION_COUNT_HEADER = "OpenClaw-Installation-Count";
export const INSTALLATION_COUNT_USER_AGENT = "openclaw-installation-count/1";
export const INSTALLATION_COUNT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const HEADER_PATTERN = /^1;(0|[1-9][0-9]{0,7});([1-9]|[12][0-9]|3[01])$/;
export type InstallationCount = { day: number; gap: number };

export function parseInstallationCount(value: string | null, now = Date.now()): InstallationCount | undefined {
	// Bound work first. Comma-joined duplicate headers, whitespace, extra fields,
	// leading zeroes, and trailing line terminators are not protocol values.
	if (!value || value.length > 13) return undefined;
	const match = HEADER_PATTERN.exec(value);
	if (!match || match[0] !== value) return undefined;
	const day = Number(match[1]);
	const today = Math.floor(now / DAY_MS);
	if (day !== today && day !== today - 1) return undefined;
	return { day, gap: Number(match[2]) };
}

export async function pruneInstallationCounts(db: D1Database | undefined, now = Date.now()): Promise<void> {
	if (!db) return;
	// Scheduled cleanup failures must fail the scheduled invocation so operators
	// can detect broken expiry. This handler is never on the update request path.
	await db.prepare("DELETE FROM installation_counts WHERE day < ?")
		.bind(Math.floor(now / DAY_MS) - INSTALLATION_COUNT_RETENTION_DAYS + 1).run();
}

export async function recordInstallationCount(db: D1Database, count: InstallationCount, now = Date.now()): Promise<void> {
	// D1 batch is transactional. UPSERT increments inside SQLite, not via a
	// racy read/modify/write, and there is never a request-level row.
	await db.batch([
		db.prepare("DELETE FROM installation_counts WHERE day < ?")
			.bind(Math.floor(now / DAY_MS) - INSTALLATION_COUNT_RETENTION_DAYS + 1),
		db.prepare(
			"INSERT INTO installation_counts (day, gap, reports) VALUES (?, ?, 1) " +
			"ON CONFLICT (day, gap) DO UPDATE SET reports = reports + 1",
		).bind(count.day, count.gap),
	]);
}

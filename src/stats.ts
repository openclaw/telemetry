import type { Env } from "./env.js";
import { PUBLIC_NAMES } from "./public-vocabulary.js";

type FeatureMetadata = {
	featureReports: number;
	latestFeatureEventAt: string | null;
};
type ReportCount = { reports: number; installs: number };
type CohortCount = { pings: number; featureReports: number };

/** Weighted reports, not unique installations or feature invocations. */
export type PublicStats = {
	generatedAt: string;
	windowDays: number;
	windowStart: string;
	windowEnd: string;
	summary: FeatureMetadata & { totalPings: number; latestEventAt: string | null };
	featureMetadata: {
		channels: FeatureMetadata;
		providerFamilies: FeatureMetadata;
		plugins: FeatureMetadata;
	};
	versions: Array<{ version: string } & CohortCount>;
	platforms: Array<{ platform: string } & CohortCount>;
	channels: Array<{ channel: string } & ReportCount>;
	providerFamilies: Array<{ provider: string } & ReportCount>;
	plugins: Array<{ plugin: string } & ReportCount>;
	architectures: Array<{ architecture: string } & CohortCount>;
};

const WINDOW_DAYS = 7;
const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const QUERY_TIMEOUT_MS = 10_000;
const MAX_QUERY_BYTES = 9500;
const EMPTY_TIMESTAMP = "1970-01-01 00:00:00";
const ARCHITECTURES = ["arm64", "x64", "arm", "other", "unknown"];
type SqlRow = Record<string, unknown>;

function record(value: unknown): value is SqlRow {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
	const parsed = typeof value === "number" ? value :
		typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid aggregate count");
	return parsed;
}

function aggregate(rows: SqlRow[]): SqlRow {
	if (rows.length !== 1 || !rows[0]) throw new Error("Missing aggregate row");
	return rows[0];
}

function watermark(value: unknown, reports: number, start: string, end: string): string | null {
	if (reports === 0 && value === EMPTY_TIMESTAMP) return null;
	if (reports === 0 || typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u.test(value)) {
		throw new Error("Invalid aggregate watermark");
	}
	const iso = value.replace(" ", "T") + ".000Z";
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || iso < start || iso >= end) {
		throw new Error("Aggregate watermark outside window");
	}
	return iso;
}

function bounded(sql: string): string {
	if (new TextEncoder().encode(sql).length > MAX_QUERY_BYTES) throw new Error("Stats query exceeds byte budget");
	return sql;
}

function featureQuery(blob: "blob6" | "blob7" | "blob8", where: string): string {
	// One statement owns every count and its checksum. Sampling may differ between statements.
	const columns = PUBLIC_NAMES.map((name, index) =>
		`sumIf(w,position(',${name},' IN b)>0) AS n${index}`);
	return bounded(`SELECT ${columns.join(",")},sum(w) AS featureReports,` +
		"sum(w*if(b=',,',0,length(b)-1)) AS tokenUnits,max(t) AS latestFeatureEventAt " +
		`FROM(SELECT format(',{},',${blob}) AS b,_sample_interval AS w,timestamp AS t ` +
		`FROM openclaw_telemetry WHERE ${where} AND double1=1)`);
}

async function runQuery(env: Env, sql: string): Promise<SqlRow[]> {
	const response = await fetch(`${SQL_ENDPOINT}/${env.ACCOUNT_ID}/analytics_engine/sql`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`,
			"content-type": "text/plain",
		},
		body: sql,
		signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error("Stats query unavailable");
	const body: unknown = await response.json();
	if (!record(body) || !Array.isArray(body.data) || !body.data.every(record) ||
		body.rows !== body.data.length || !Array.isArray(body.meta) ||
		!body.meta.every((column) => record(column) && typeof column.name === "string" && typeof column.type === "string")) {
		throw new Error("Invalid stats query envelope");
	}
	return body.data;
}

function featureResult(rows: SqlRow[], start: string, end: string) {
	const row = aggregate(rows);
	const featureReports = count(row.featureReports);
	const tokenUnits = count(row.tokenUnits);
	const latestFeatureEventAt = watermark(row.latestFeatureEventAt, featureReports, start, end);
	let recognizedUnits = 0;
	const ranked: Array<{ name: string; reports: number; installs: number }> = [];
	for (const [index, name] of PUBLIC_NAMES.entries()) {
		const reports = count(row[`n${index}`]);
		if (reports > featureReports) throw new Error("Invalid category report count");
		recognizedUnits = count(recognizedUnits + count((name.length + 1) * reports));
		if (reports > 0) ranked.push({ name, reports, installs: reports });
	}
	// Unknown, repeated, mixed-case, or malformed tokens leave unmatched units.
	if (recognizedUnits !== tokenUnits) throw new Error("Incomplete public vocabulary coverage");
	ranked.sort((a, b) => b.reports - a.reports || a.name.localeCompare(b.name));
	return { metadata: { featureReports, latestFeatureEventAt }, ranked };
}

function grouped(rows: SqlRow[], key: "version" | "platform" | "architecture"): Array<{ name: string } & CohortCount> {
	if (rows.length > (key === "architecture" ? ARCHITECTURES.length : 25)) throw new Error("Invalid grouped result");
	const seen = new Set<string>();
	return rows.map((row) => {
		const name = row[key];
		if (typeof name !== "string" || !name || seen.has(name) ||
			(key === "architecture" && !ARCHITECTURES.includes(name))) throw new Error("Invalid group label");
		seen.add(name);
		const pings = count(row.pings);
		const featureReports = count(row.featureReports);
		if (featureReports > pings) throw new Error("Invalid cohort report count");
		return { name, pings, featureReports };
	});
}

export async function queryPublicStats(env: Env): Promise<PublicStats | undefined> {
	if (!env.ACCOUNT_ID || !env.ANALYTICS_READ_TOKEN) return undefined;
	try {
		// Public ASCII identifiers make SQL literals safe and byte-length checks exact.
		if (new Set(PUBLIC_NAMES).size !== PUBLIC_NAMES.length ||
			PUBLIC_NAMES.some((name) => !/^[a-z0-9][a-z0-9._-]*$/u.test(name))) {
			throw new Error("Invalid public vocabulary");
		}
		const end = new Date(Math.floor(Date.now() / 1000) * 1000);
		const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);
		const windowStart = start.toISOString();
		const windowEnd = end.toISOString();
		const where = `timestamp>=toDateTime('${windowStart.slice(0, 19).replace("T", " ")}') ` +
			`AND timestamp<toDateTime('${windowEnd.slice(0, 19).replace("T", " ")}')`;
		const sql = [
			"SELECT sum(_sample_interval) AS totalPings,sumIf(_sample_interval,double1=1) AS featureReports," +
				"max(timestamp) AS latestEventAt," +
				`max(if(double1=1,timestamp,toDateTime('${EMPTY_TIMESTAMP}'))) AS latestFeatureEventAt ` +
				`FROM openclaw_telemetry WHERE ${where}`,
			"SELECT blob1 AS version,sum(_sample_interval) AS pings,sumIf(_sample_interval,double1=1) AS featureReports " +
				`FROM openclaw_telemetry WHERE ${where} GROUP BY version ORDER BY pings DESC LIMIT 25`,
			"SELECT blob2 AS platform,sum(_sample_interval) AS pings,sumIf(_sample_interval,double1=1) AS featureReports " +
				`FROM openclaw_telemetry WHERE ${where} GROUP BY platform ORDER BY pings DESC LIMIT 25`,
			featureQuery("blob6", where),
			featureQuery("blob7", where),
			featureQuery("blob8", where),
			// A sixth row is an overflow sentinel, never a silently truncated architecture breakdown.
			"SELECT if(blob3='arm64','arm64',if(blob3='x64','x64',if(blob3='arm','arm',if(blob3='','unknown',if(blob3='unknown','unknown','other'))))) AS architecture," +
				"sum(_sample_interval) AS pings,sumIf(_sample_interval,double1=1) AS featureReports " +
				`FROM openclaw_telemetry WHERE ${where} GROUP BY architecture ORDER BY pings DESC LIMIT 6`,
		].map(bounded);
		const [summaryRows, versionRows, platformRows, channelRows, providerRows, pluginRows, architectureRows] =
			await Promise.all(sql.map((query) => runQuery(env, query)));
		if (!summaryRows || !versionRows || !platformRows || !channelRows || !providerRows || !pluginRows || !architectureRows) return undefined;
		const summary = aggregate(summaryRows);
		const totalPings = count(summary.totalPings);
		const featureReports = count(summary.featureReports);
		const channels = featureResult(channelRows, windowStart, windowEnd);
		const providers = featureResult(providerRows, windowStart, windowEnd);
		const plugins = featureResult(pluginRows, windowStart, windowEnd);
		return {
			generatedAt: new Date().toISOString(),
			windowDays: WINDOW_DAYS,
			windowStart,
			windowEnd,
			summary: {
				totalPings,
				featureReports,
				latestEventAt: watermark(summary.latestEventAt, totalPings, windowStart, windowEnd),
				latestFeatureEventAt: watermark(summary.latestFeatureEventAt, featureReports, windowStart, windowEnd),
			},
			featureMetadata: { channels: channels.metadata, providerFamilies: providers.metadata, plugins: plugins.metadata },
			versions: grouped(versionRows, "version").map(({ name, ...counts }) => ({ version: name, ...counts })),
			platforms: grouped(platformRows, "platform").map(({ name, ...counts }) => ({ platform: name, ...counts })),
			channels: channels.ranked.map(({ name, ...counts }) => ({ channel: name, ...counts })),
			providerFamilies: providers.ranked.map(({ name, ...counts }) => ({ provider: name, ...counts })),
			plugins: plugins.ranked.map(({ name, ...counts }) => ({ plugin: name, ...counts })),
			architectures: grouped(architectureRows, "architecture").map(({ name, ...counts }) => ({ architecture: name, ...counts })),
		};
	} catch {
		return undefined;
	}
}

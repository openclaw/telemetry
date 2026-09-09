export type StatsEvent = {
	version: string;
	platform: string;
	architecture: string;
	channels: string;
	providers: string;
	plugins: string;
	weight: number;
	feature: boolean;
	timestamp: string;
};

export const SAMPLE_EVENTS: StatsEvent[] = [{
	version: "2026.8.2",
	platform: "darwin",
	architecture: "arm64",
	channels: "telegram",
	providers: "anthropic",
	plugins: "codex",
	weight: 4,
	feature: true,
	timestamp: "2026-09-06 12:00:00",
}];

export function envelope(data: Record<string, unknown>[], columns = Object.keys(data[0] ?? {})) {
	return { meta: columns.map((name) => ({ name, type: "String" })), data, rows: data.length };
}

/** Controlled SQL transport: aggregate synthetic rows, never call a live service. */
export function fixtureRows(sql: string, events: StatsEvent[] = [{
	...SAMPLE_EVENTS[0]!,
	timestamp: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace("T", " "),
}]): Record<string, unknown>[] {
	const features = events.filter((event) => event.feature);
	const sum = (rows: StatsEvent[]) => rows.reduce((total, row) => total + row.weight, 0);
	const latest = (rows: StatsEvent[]) =>
		rows.map((row) => row.timestamp).sort().at(-1) ?? "1970-01-01 00:00:00";
	if (sql.includes("AS totalPings")) {
		return [{
			totalPings: String(sum(events)),
			featureReports: String(sum(features)),
			latestEventAt: latest(events),
			latestFeatureEventAt: latest(features),
		}];
	}
	const column = sql.includes("AS version") ? "version" :
		sql.includes("AS platform") ? "platform" : sql.includes("AS architecture") ? "architecture" : undefined;
	if (column) {
		const totals = new Map<string, { pings: number; featureReports: number }>();
		for (const event of events) {
			let name = event[column];
			if (column === "architecture") {
				if (!name || name === "unknown") name = "unknown";
				else if (!["arm64", "x64", "arm"].includes(name)) name = "other";
			}
			const group = totals.get(name) ?? { pings: 0, featureReports: 0 };
			group.pings += event.weight;
			if (event.feature) group.featureReports += event.weight;
			totals.set(name, group);
		}
		return [...totals].sort((a, b) => b[1].pings - a[1].pings).slice(0, column === "architecture" ? 6 : 25)
			.map(([name, counts]) => ({
				[column]: name, pings: String(counts.pings), featureReports: String(counts.featureReports),
			}));
	}
	if (sql.includes("GROUP BY channels, providers, plugins")) {
		const groups = new Map<string, { channels: string; providers: string; plugins: string; pings: number }>();
		for (const event of features) {
			const key = JSON.stringify([event.channels, event.providers, event.plugins]);
			const group = groups.get(key) ?? { channels: event.channels, providers: event.providers, plugins: event.plugins, pings: 0 };
			group.pings += event.weight;
			groups.set(key, group);
		}
		return [...groups.values()].slice(0, 1000);
	}
	const field = sql.includes("blob6") ? "channels" : sql.includes("blob7") ? "providers" : "plugins";
	const row: Record<string, unknown> = {
		featureReports: String(sum(features)),
		tokenUnits: String(features.reduce((total, event) =>
			total + event.weight * (event[field] ? event[field].length + 1 : 0), 0)),
		latestFeatureEventAt: latest(features),
	};
	for (const match of sql.matchAll(/position\(',([^']+),' IN b\)>0\) AS (n\d+)/gu)) {
		const [, name, alias] = match;
		if (name && alias) row[alias] = String(sum(features.filter((event) => event[field].split(",").includes(name))));
	}
	return [row];
}

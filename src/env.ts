export type RateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
	TELEMETRY: AnalyticsEngineDataset;
	/** Per-IP limits with separate recording and stats-miss counters. */
	RATE_LIMIT?: RateLimiter;
	/** Cloudflare account id, used only by the public /api/stats aggregation query. */
	ACCOUNT_ID?: string;
	/** Read-only Analytics Engine token for /api/stats. Absent = stats unavailable. */
	ANALYTICS_READ_TOKEN?: string;
};

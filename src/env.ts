export type RateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
	TELEMETRY: AnalyticsEngineDataset;
	/** Separate, identifier-free outcome dataset; never fall back to TELEMETRY. */
	UPDATE_RESULTS?: AnalyticsEngineDataset;
	/** Optional aggregate-only D1 histogram; deliberately absent in production. */
	INSTALLATION_COUNTS?: D1Database;
	/** Per-IP limit on recorded update checks. */
	RATE_LIMIT?: RateLimiter;
};

export type RateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
	TELEMETRY: AnalyticsEngineDataset;
	/** Separate, identifier-free outcome dataset; never fall back to TELEMETRY. */
	UPDATE_RESULTS?: AnalyticsEngineDataset;
	/** Per-IP limit on recorded update checks. */
	RATE_LIMIT?: RateLimiter;
};

export type RateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
	TELEMETRY: AnalyticsEngineDataset;
	/** Per-IP limit on recorded update checks. */
	RATE_LIMIT?: RateLimiter;
};

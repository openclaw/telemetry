import type { RequestGeography } from "./geography.js";
import type { ClientIdentity, FeatureStats } from "./payload.js";

/**
 * Shape of one Analytics Engine row. Column order is a storage contract: the
 * SQL API addresses these positionally (`blob1`, `double2`, ...), so existing
 * columns may never be reordered or repurposed — only appended to.
 */
export type DataPoint = {
	indexes: [string];
	blobs: string[];
	doubles: number[];
};

const LIST_SEPARATOR = ",";

export function buildDataPoint(
	identity: ClientIdentity,
	features: FeatureStats | undefined,
	geography: RequestGeography,
): DataPoint {
	return {
		// Sampling key. Version keeps per-release counts intact under load.
		indexes: [identity.version],
		blobs: [
			identity.version,
			identity.platform,
			identity.arch,
			identity.runtime,
			identity.surface,
			features?.channels.join(LIST_SEPARATOR) ?? "",
			features?.providerFamilies.join(LIST_SEPARATOR) ?? "",
			features?.plugins.join(LIST_SEPARATOR) ?? "",
			geography.country,
			geography.regionCode,
			geography.city,
			geography.timezone,
		],
		doubles: [
			features ? 1 : 0,
			features?.pluginsEnabled ?? 0,
			features?.sessionsLast24h ?? 0,
		],
	};
}

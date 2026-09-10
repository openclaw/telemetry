export type RequestGeography = {
	country: string;
	regionCode: string;
	city: string;
	timezone: string;
};

const encoder = new TextEncoder();
const MAX_CITY_BYTES = 128;
const MAX_TIMEZONE_BYTES = 64;
// Reject controls, invisible formatting, line separators, and unpaired surrogates.
const INVALID_CITY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/u;

function parseCity(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > MAX_CITY_BYTES ||
		INVALID_CITY_CHARACTERS.test(value)
	)
		return "";
	const city = value.trim().normalize("NFC");
	return encoder.encode(city).byteLength <= MAX_CITY_BYTES ? city : "";
}

function parseTimezone(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > MAX_TIMEZONE_BYTES ||
		!TIMEZONE_PATTERN.test(value)
	)
		return "";
	try {
		// Syntax excludes numeric offsets even on runtimes whose Intl accepts them.
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return value;
	} catch {
		return "";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the incoming Worker's cf metadata supplies geography, never headers or a body. */
export function parseRequestGeography(cf: unknown): RequestGeography {
	const metadata = isRecord(cf) ? cf : {};
	const country =
		typeof metadata.country === "string" && /^[A-Za-z]{2}$/u.test(metadata.country)
			? metadata.country.toUpperCase()
			: "";
	const knownCountry = country === "XX" ? "" : country;
	return {
		country: knownCountry,
		// ISO 3166-2 subdivision components are meaningful only within a country.
		regionCode:
			knownCountry &&
			typeof metadata.regionCode === "string" &&
			/^[A-Z0-9]{1,3}$/u.test(metadata.regionCode)
				? metadata.regionCode
				: "",
		city: parseCity(metadata.city),
		timezone: parseTimezone(metadata.timezone),
	};
}

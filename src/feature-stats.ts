import { parseFeatureStats } from "./payload.js";

/** Body cap: the documented payload is well under 1 KB. */
export const MAX_BODY_BYTES = 16_384;

function rejectDeclaredLength(request: Request, maxBytes: number): boolean {
	const header = request.headers.get("content-length");
	if (header === null) return false;
	if (!/^[0-9]+$/.test(header)) return true;
	const declared = Number(header);
	return !Number.isSafeInteger(declared) || declared > maxBytes;
}

/** Count stream bytes so a missing Content-Length cannot allocate the whole body. */
export async function readCappedBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<{ text: string; byteLength: number } | undefined> {
	if (rejectDeclaredLength(request, maxBytes)) return undefined;

	const body = request.body;
	if (!body) return undefined;

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	}

	if (total === 0) return undefined;
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), byteLength: total };
	} catch {
		return undefined;
	}
}

export async function readFeatureStats(request: Request) {
	if (request.method !== "POST") return undefined;
	const raw = (await readCappedBody(request))?.text;
	if (!raw) return undefined;
	const parsed = ((): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	})();
	return parseFeatureStats(parsed);
}

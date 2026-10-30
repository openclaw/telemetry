import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { INSTALLATION_COUNT_HEADER, INSTALLATION_COUNT_USER_AGENT, parseInstallationCount } from "../src/installation-count.js";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const day = 20_000;
const now = day * 86_400_000;
it("ordinary update never touches optional stalled D1 and advertises one authoritative day", async () => {
	vi.stubGlobal("caches", { default: { match: async () => Response.json({ version: "2026.10.28" }) } });
	const batch = vi.fn(() => new Promise(() => {}));
	const db = { batch } as unknown as D1Database;
	const env: Env = { TELEMETRY: { writeDataPoint() {} }, INSTALLATION_COUNTS: db };
	const request = new Request("https://telemetry.example/api/latest-version");
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const response = await worker.fetch(request, env);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ version: "2026.10.28" });
	expect(response.headers.get(INSTALLATION_COUNT_HEADER)).toBe("1;20000");
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(clock).toHaveBeenCalledTimes(1);
	expect(batch).not.toHaveBeenCalled();
});
it("captures the post-lookup server day once when npm lookup crosses midnight", async () => {
	let finishLookup!: () => void;
	let started!: () => void;
	const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
	const lookupGate = new Promise<void>((resolve) => { finishLookup = resolve; });
	vi.stubGlobal("caches", { default: {
		match: async () => { started(); await lookupGate; return undefined; },
		put: async () => undefined,
	} });
	vi.stubGlobal("fetch", async () => Response.json({ version: "2026.10.28" }));
	const env: Env = { TELEMETRY: { writeDataPoint() {} }, INSTALLATION_COUNTS: {} as D1Database };
	const request = new Request("https://telemetry.example/api/latest-version");
	const clock = vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000 - 1);
	const pending = worker.fetch(request, env);
	await lookupStarted;
	expect(clock).not.toHaveBeenCalled();
	clock.mockReturnValue(now + 86_400_000);
	finishLookup();
	const response = await pending;
	expect(response.headers.get(INSTALLATION_COUNT_HEADER)).toBe("1;20001");
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(clock).toHaveBeenCalledTimes(1);
});

it("count write failure is one attempt even if a commit preceded the lost acknowledgement", async () => {
	const prepare = vi.fn(() => ({ bind() { return this; } }));
	const batch = vi.fn().mockRejectedValue(new Error("synthetic lost acknowledgement"));
	const env: Env = { TELEMETRY: { writeDataPoint: vi.fn() }, INSTALLATION_COUNTS: { prepare, batch } as unknown as D1Database };
	const request = new Request("https://telemetry.example/api/latest-version", { method: "POST", headers: { [INSTALLATION_COUNT_HEADER]: "1;20000;31", "user-agent": INSTALLATION_COUNT_USER_AGENT } });
	vi.spyOn(Date, "now").mockReturnValue(now);
	const response = await worker.fetch(request, env);
	expect(response.status).toBe(503);
	expect(await response.text()).toBe("");
	expect(batch).toHaveBeenCalledTimes(1);
	expect(env.TELEMETRY.writeDataPoint).not.toHaveBeenCalled();
});

it.each([undefined, "1", "00", "invalid"])("rejects stalled/present bodies without obtaining a reader (length %s)", async (length) => {
	const headers = new Headers({ [INSTALLATION_COUNT_HEADER]: "1;20000;31", "user-agent": INSTALLATION_COUNT_USER_AGENT });
	if (length !== undefined) headers.set("content-length", length);
	const request = new Request("https://telemetry.example/api/latest-version", { method: "POST", headers, body: new ReadableStream({}), duplex: "half" } as RequestInit);
	const getReader = vi.spyOn(request.body!, "getReader").mockImplementation(() => { throw new Error("must not read body"); });
	const prepare = vi.fn();
	const env: Env = { TELEMETRY: { writeDataPoint: vi.fn() }, INSTALLATION_COUNTS: { prepare } as unknown as D1Database };
	vi.spyOn(Date, "now").mockReturnValue(now);
	expect((await worker.fetch(request, env)).status).toBe(400);
	expect(getReader).not.toHaveBeenCalled();
	expect(prepare).not.toHaveBeenCalled();
	expect(env.TELEMETRY.writeDataPoint).not.toHaveBeenCalled();
});

it("revalidates the server-day window after the asynchronous quota gate", async () => {
	const prepare = vi.fn();
	const env: Env = { TELEMETRY: { writeDataPoint: vi.fn() }, INSTALLATION_COUNTS: { prepare } as unknown as D1Database };
	const request = new Request("https://telemetry.example/api/latest-version", { method: "POST", headers: { [INSTALLATION_COUNT_HEADER]: "1;20000;31", "user-agent": INSTALLATION_COUNT_USER_AGENT } });
	vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 2 * 86_400_000);
	const response = await worker.fetch(request, env);
	expect(response.status).toBe(400);
	expect(prepare).not.toHaveBeenCalled();
	expect(env.TELEMETRY.writeDataPoint).not.toHaveBeenCalled();
});

describe("installation count header", () => {
	it.each([1, 7, 30, 31])("accepts bounded gap %i on today and yesterday", (gap) => {
		for (const d of [day, day - 1]) expect(parseInstallationCount(`1;${d};${gap}`, now)).toEqual({ day: d, gap });
	});
	it.each([
		null, "", "1;20000;0", "1;20000;32", "1;20000;-1", "1;20000;1.0", "1;20000;01",
		"1;20000;1e1", "1;020000;1", "2;20000;1", "1;20001;1", "1;19998;1", "1;-1;1",
		"1;20000;1;id", "1;20000;1, 1;20000;1", "1;20000;1\n", " 1;20000;1", "1;20000;1 ",
		"1;20000;١", "1;20000;+1", "1;" + "9".repeat(100_000) + ";1",
	])("ignores malformed or out-of-window header %#", (value) => {
		expect(parseInstallationCount(value, now)).toBeUndefined();
	});
});

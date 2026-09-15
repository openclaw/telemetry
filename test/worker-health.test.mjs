import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerHealth } from "../scripts/lib/worker-health.mjs";

const CLI = fileURLToPath(new URL("../scripts/worker-health.mjs", import.meta.url));
const NOW = Date.parse("2026-09-09T08:37:00Z");
const START = "2026-09-08T07:00:00.000Z";
const END = "2026-09-09T07:00:00.000Z";
const ACCOUNT = "a".repeat(32);
const TOKEN = "synthetic-not-a-credential";
const PRIVATE = "synthetic-upstream-detail";
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalConnect = net.Socket.prototype.connect;
const servers = [];
const sockets = new Set();
const ports = new Set();
const timers = [];
const clients = [];
const calls = [];

function fixture() {
	return {
		data: {
			viewer: {
				accounts: [
					{
						workersInvocationsAdaptive: Array.from({ length: 24 }, (_, index) => ({
							dimensions: {
								datetimeHour: new Date(Date.parse(START) + index * 3_600_000)
									.toISOString()
									.replace(".000Z", "Z"),
							},
							sum: { requests: index === 0 ? 0 : 100 + index, errors: index % 3 },
							avg: { sampleInterval: 8 },
						})),
					},
				],
			},
		},
	};
}

function rows(value) {
	return value.data.viewer.accounts[0].workersInvocationsAdaptive;
}

function later(fn, delay) {
	timers.push(setTimeout(fn, delay));
}

async function listen(server) {
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	ports.add(server.address().port);
	return server;
}

function capture(url, options) {
	calls.push({ url: String(url), options });
	expect(String(url)).toBe("https://api.cloudflare.com/client/v4/graphql");
	expect(options.method).toBe("POST");
	expect(options.agent).toBe(false);
}

function routeTo(server, options = {}) {
	vi.mocked(https.request).mockImplementation((url, requestOptions, callback) => {
		capture(url, requestOptions);
		const request = originalHttpRequest(
			{
				...requestOptions,
				hostname: options.lookup ? "fixture.invalid" : "127.0.0.1",
				port: server.address().port,
				path: "/client/v4/graphql",
				...options,
			},
			callback,
		);
		// Substitute only the TLS boundary; HTTP I/O, streaming, and cancellation remain real.
		request.once("socket", (socket) => {
			socket.once("connect", () => socket.emit("secureConnect"));
		});
		clients.push(request);
		return request;
	});
}

async function serve(value, status = 200) {
	const received = [];
	const server = await listen(
		http.createServer((request, response) => {
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => {
				received.push({
					body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
					headers: request.headers,
				});
				response.writeHead(status, {
					"Content-Type": "application/json",
					...(status >= 300 && status < 400
						? { Location: "https://example.invalid/redirect" }
						: {}),
				});
				response.end(typeof value === "string" ? value : JSON.stringify(value));
			});
		}),
	);
	routeTo(server);
	return received;
}

beforeEach(() => {
	vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const forbidden = () => {
		throw new Error("Unexpected outbound network");
	};
	vi.stubGlobal("fetch", forbidden);
	vi.spyOn(http, "request").mockImplementation(forbidden);
	vi.spyOn(http, "get").mockImplementation(forbidden);
	vi.spyOn(https, "request").mockImplementation(forbidden);
	vi.spyOn(https, "get").mockImplementation(forbidden);
	vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (...args) {
		const options = Array.isArray(args[0]) ? args[0][0] : args[0];
		if (
			!ports.has(Number(options?.port)) ||
			!(
				options.host === "127.0.0.1" ||
				(options.host === "fixture.invalid" && typeof options.lookup === "function")
			)
		) {
			return forbidden();
		}
		return originalConnect.apply(this, args);
	});
});

afterEach(async () => {
	for (const timer of timers.splice(0)) {
		clearTimeout(timer);
	}
	for (const socket of sockets) {
		socket.destroy();
	}
	await Promise.all(
		servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
	);
	sockets.clear();
	ports.clear();
	clients.length = 0;
	calls.length = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("Worker health operation and projection", () => {
	it("freezes one lagged UTC window and requests only the approved hourly aggregates", async () => {
		const value = fixture();
		value.data.viewer.accounts[0].accountTag = PRIVATE;
		rows(value)[1].dimensions.hostname = PRIVATE;
		const received = await serve(value);
		const pending = runWorkerHealth();
		vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
		const result = await pending;
		expect(calls).toHaveLength(1);
		expect(received).toHaveLength(1);
		expect(received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(received[0].body.variables).toEqual({
			accountTag: ACCOUNT,
			start: START,
			end: END,
		});
		expect(received[0].body.query.replace(/\s/g, "")).toBe(
			'queryWorkerHealth($accountTag:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:24filter:{scriptName:"openclaw-telemetry",datetime_geq:$start,datetime_lt:$end}orderBy:[datetimeHour_ASC]){dimensions{datetimeHour}sum{requestserrors}avg{sampleInterval}}}}}',
		);
		expect(result.status).toBe("available");
		expect(result.worker).toBe("openclaw-telemetry");
		expect(result.window).toEqual({ startInclusive: START, endExclusive: END });
		expect(result.hours).toHaveLength(24);
		expect(result.hours[0]).toEqual({
			hour: START,
			requestsEstimate: 0,
			errorsEstimate: 0,
			sampleInterval: 8,
		});
		expect(result.hours[1]).toEqual({
			hour: "2026-09-08T08:00:00.000Z",
			requestsEstimate: 101,
			errorsEstimate: 1,
			sampleInterval: 8,
		});
		expect(result.hours[23].hour).toBe("2026-09-09T06:00:00.000Z");
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
		expect(JSON.stringify(result)).not.toContain(ACCOUNT);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(clients[0].closed).toBe(true);
	});

	it("keeps valid metrics when sampling metadata is unavailable and never reweights sums", async () => {
		const value = fixture();
		delete rows(value)[0].avg;
		rows(value)[1].avg = null;
		rows(value)[2].avg = {};
		rows(value)[3].avg = { sampleInterval: null };
		rows(value)[4].avg = { sampleInterval: 1.5 };
		rows(value)[5].avg = { sampleInterval: 128 };
		await serve(value);
		const result = await runWorkerHealth();
		expect(result.status).toBe("available");
		expect(result.hours.slice(0, 4).map((row) => row.sampleInterval)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(result.hours[4].requestsEstimate).toBe(104);
		expect(result.hours[4].sampleInterval).toBe(1.5);
		expect(result.hours[5].requestsEstimate).toBe(105);
		expect(result.hours[5].sampleInterval).toBe(128);
	});

	it.each([
		["empty hours", (value) => rows(value).splice(0), "incomplete_hours"],
		["missing hour", (value) => rows(value).splice(3, 1), "incomplete_hours"],
		["extra row", (value) => rows(value).push(rows(value)[0]), "invalid_response"],
		["duplicate hour", (value) => (rows(value)[1] = rows(value)[0]), "invalid_hours"],
		[
			"exclusive end",
			(value) => (rows(value)[23].dimensions.datetimeHour = END),
			"invalid_hours",
		],
		[
			"before window",
			(value) => (rows(value)[0].dimensions.datetimeHour = "2026-09-08T06:00:00Z"),
			"invalid_hours",
		],
		[
			"non-hour",
			(value) => (rows(value)[0].dimensions.datetimeHour = "2026-09-08T07:01:00Z"),
			"invalid_hours",
		],
		[
			"non-UTC",
			(value) => (rows(value)[0].dimensions.datetimeHour = "2026-09-08T15:00:00+08:00"),
			"invalid_hours",
		],
		["out of order", (value) => rows(value).reverse(), "invalid_hours"],
		["negative count", (value) => (rows(value)[0].sum.requests = -1), "invalid_response"],
		["fractional count", (value) => (rows(value)[0].sum.errors = 0.5), "invalid_response"],
		[
			"unsafe count",
			(value) => (rows(value)[0].sum.requests = Number.MAX_SAFE_INTEGER + 1),
			"invalid_response",
		],
		["missing count", (value) => delete rows(value)[0].sum.errors, "invalid_response"],
		["string count", (value) => (rows(value)[0].sum.requests = "0"), "invalid_response"],
		["missing sum", (value) => delete rows(value)[0].sum, "invalid_response"],
		[
			"bad sampling value",
			(value) => (rows(value)[0].avg.sampleInterval = -1),
			"invalid_response",
		],
		["bad sampling object", (value) => (rows(value)[0].avg = []), "invalid_response"],
		["null account", (value) => (value.data.viewer.accounts[0] = null), "invalid_response"],
		[
			"multiple accounts",
			(value) => value.data.viewer.accounts.push(value.data.viewer.accounts[0]),
			"invalid_response",
		],
		["partial data", (value) => (value.data = null), "invalid_response"],
		["partial GraphQL error", (value) => (value.errors = [{ message: PRIVATE }]), "graphql_error"],
		["malformed errors", (value) => (value.errors = PRIVATE), "invalid_response"],
	])("fails closed for %s", async (_name, mutate, reason) => {
		const value = fixture();
		mutate(value);
		await serve(value);
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason });
		expect(calls).toHaveLength(1);
	});

	it.each([{ errors: null }, { errors: [] }])(
		"accepts empty GraphQL error metadata: $errors",
		async ({ errors }) => {
			await serve({ ...fixture(), errors });
			expect((await runWorkerHealth()).status).toBe("available");
		},
	);

	it.each([
		["CLOUDFLARE_API_TOKEN", undefined],
		["CLOUDFLARE_API_TOKEN", "bad\nheader"],
		["CLOUDFLARE_ACCOUNT_ID", ""],
		["CLOUDFLARE_ACCOUNT_ID", "not-an-account"],
	])("rejects invalid %s before dispatch", async (name, value) => {
		vi.stubEnv(name, value);
		expect(await runWorkerHealth()).toEqual({
			status: "unavailable",
			reason: "invalid_environment",
		});
		expect(https.request).not.toHaveBeenCalled();
	});
});

describe("Worker health Node transport", () => {
	it.each([
		[302, { httpStatus: 302 }],
		[307, { httpStatus: 307 }],
		[401, { httpStatus: 401 }],
		[403, { httpStatus: 403 }],
		[429, { httpStatus: 429 }],
		[500, { httpStatus: 500 }],
		[503, { httpStatus: 503 }],
		[599, { httpStatus: 599 }],
		[600, {}],
	])("does not follow or retry HTTP %i", async (status, detail) => {
		await serve({ errors: [{ message: PRIVATE }] }, status);
		expect(await runWorkerHealth()).toEqual({
			status: "unavailable",
			reason: "http_error",
			...detail,
		});
		expect(calls).toHaveLength(1);
		expect(clients[0].closed).toBe(true);
	});

	it("accepts exactly 64 KiB, including JSON whitespace", async () => {
		const json = JSON.stringify(fixture());
		await serve(json + " ".repeat(65_536 - Buffer.byteLength(json)));
		expect((await runWorkerHealth()).status).toBe("available");
	});

	it("stops an oversized streamed body in bytes without waiting for its end", async () => {
		let responseEnded = false;
		const server = await listen(
			http.createServer((_request, response) => {
				response.on("finish", () => (responseEnded = true));
				response.write(" ".repeat(65_535));
				response.write(Buffer.from([0xc3, 0xa9]));
			}),
		);
		routeTo(server);
		expect(await runWorkerHealth()).toEqual({
			status: "unavailable",
			reason: "response_too_large",
		});
		expect(responseEnded).toBe(false);
		expect(clients[0].closed).toBe(true);
	});

	it.each(["not JSON", '{"data":', "[]"])("rejects malformed JSON: %s", async (value) => {
		await serve(value);
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "invalid_response" });
	});

	it("rejects invalid UTF-8 even inside an unselected field", async () => {
		const json = JSON.stringify({ ...fixture(), extensions: "marker" });
		const server = await listen(
			http.createServer((_request, response) => {
				response.end(Buffer.from(json.replace("marker", "\xff"), "latin1"));
			}),
		);
		routeTo(server);
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "invalid_response" });
	});

	it("rejects incomplete HTTP bodies without emitting their contents", async () => {
		const server = await listen(
			http.createServer((_request, response) => {
				response.writeHead(200, { "Content-Length": 1000 });
				response.write(PRIVATE);
				later(() => response.destroy(), 10);
			}),
		);
		routeTo(server);
		expect(await runWorkerHealth()).toEqual({
			status: "unavailable",
			reason: "response_incomplete",
		});
		expect(clients[0].closed).toBe(true);
	});

	it("redacts unexpected network errors and makes no retry", async () => {
		vi.mocked(https.request).mockImplementation(() => {
			throw new Error(`${PRIVATE} ${TOKEN} ${ACCOUNT}`);
		});
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "network_error" });
		expect(https.request).toHaveBeenCalledTimes(1);
	});

	it("records timeout before aborting headers received after the deadline", async () => {
		const clock = performance.now.bind(performance);
		let offset = 0;
		let received = false;
		const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock() + offset);
		const server = await listen(
			http.createServer((_request, response) => {
				received = true;
				offset = 10_001;
				response.writeHead(200);
				response.flushHeaders();
			}),
		);
		routeTo(server);
		let result;
		try {
			result = await runWorkerHealth();
		} finally {
			monotonic.mockRestore();
		}
		expect(received).toBe(true);
		expect(result).toEqual({ status: "unavailable", reason: "request_timeout" });
		expect(clients[0].closed).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("expires pending connection setup and cannot dispatch after a late lookup", async () => {
		let lookup;
		let requests = 0;
		const server = await listen(http.createServer(() => requests++));
		routeTo(server, {
			lookup: (_host, _options, callback) => {
				lookup = callback;
			},
		});
		const started = performance.now();
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "request_timeout" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
		expect(performance.now() - started).toBeLessThan(12_000);
		expect(clients[0].closed).toBe(true);
		expect(lookup).toBeTypeOf("function");
		lookup(null, [{ address: "127.0.0.1", family: 4 }]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(requests).toBe(0);
		expect(calls).toHaveLength(1);
	}, 15_000);

	it("bounds a real TLS handshake that never receives a server response", async () => {
		const server = await listen(net.createServer((socket) => socket.resume()));
		vi.mocked(https.request).mockImplementation((url, options, callback) => {
			capture(url, options);
			const request = originalHttpsRequest(
				`https://127.0.0.1:${server.address().port}/client/v4/graphql`,
				options,
				callback,
			);
			clients.push(request);
			return request;
		});
		const started = performance.now();
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "request_timeout" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
		expect(performance.now() - started).toBeLessThan(12_000);
		expect(clients[0].closed).toBe(true);
		expect(calls).toHaveLength(1);
	}, 15_000);

	it("shares one real deadline across delayed headers and a continuously streaming body", async () => {
		let writes = 0;
		const server = await listen(
			http.createServer((_request, response) => {
				function write() {
					writes++;
					response.write(" ");
					later(write, 200);
				}
				later(write, 4000);
			}),
		);
		routeTo(server);
		const started = performance.now();
		expect(await runWorkerHealth()).toEqual({ status: "unavailable", reason: "request_timeout" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
		expect(performance.now() - started).toBeLessThan(12_000);
		expect(writes).toBeGreaterThan(5);
		expect(clients[0].closed).toBe(true);
		expect(calls).toHaveLength(1);
	}, 15_000);
});

describe("Worker health CLI", () => {
	it.each([{ args: [] }, { args: ["--endpoint", "https://example.invalid"] }])(
		"emits one safe JSON failure with args $args",
		({ args }) => {
			const child = spawnSync(process.execPath, [CLI, ...args], {
				env: {},
				encoding: "utf8",
				timeout: 2000,
			});
			expect(child.status).toBe(1);
			expect(child.stderr).toBe("");
			expect(JSON.parse(child.stdout)).toEqual({
				status: "unavailable",
				reason: args.length === 0 ? "invalid_environment" : "invalid_arguments",
			});
			expect(child.stdout.trim().split("\n")).toHaveLength(1);
		},
	);

	it("does not expose upstream GraphQL errors through its stdout or stderr", async () => {
		await serve({ ...fixture(), errors: [{ message: `${PRIVATE} ${TOKEN} ${ACCOUNT}` }] });
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const argv = process.argv;
		const exitCode = process.exitCode;
		try {
			process.argv = [process.execPath, CLI];
			vi.resetModules();
			await import("../scripts/worker-health.mjs");
			expect(process.exitCode).toBe(1);
			expect(stdout).toHaveBeenCalledExactlyOnceWith(
				'{"status":"unavailable","reason":"graphql_error"}',
			);
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			process.argv = argv;
			process.exitCode = exitCode;
		}
	});
});

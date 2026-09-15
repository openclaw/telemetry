import https from "node:https";
import { performance } from "node:perf_hooks";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const WORKER = "openclaw-telemetry";
const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const QUERY = `query WorkerHealth($accountTag: string!, $start: Time!, $end: Time!) {
	viewer {
		accounts(filter: {accountTag: $accountTag}) {
			workersInvocationsAdaptive(
				limit: 24
				filter: {scriptName: "openclaw-telemetry", datetime_geq: $start, datetime_lt: $end}
				orderBy: [datetimeHour_ASC]
			) {
				dimensions { datetimeHour }
				sum { requests errors }
				avg { sampleInterval }
			}
		}
	}
}`;

class Unavailable extends Error {
	constructor(reason, httpStatus) {
		super(reason);
		if (
			reason === "http_error" &&
			Number.isInteger(httpStatus) &&
			httpStatus >= 100 &&
			httpStatus <= 599
		) {
			this.httpStatus = httpStatus;
		}
	}
}

function requireValue(condition, reason = "invalid_response") {
	if (!condition) {
		throw new Unavailable(reason);
	}
}

function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentials() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	requireValue(
		typeof token === "string" &&
			token.length > 0 &&
			token.length <= 8192 &&
			/^[\x21-\x7e]+$/.test(token) &&
			typeof account === "string" &&
			/^[a-fA-F0-9]{32}$/.test(account),
		"invalid_environment",
	);
	return { token, account };
}

function requestMetrics(body, token) {
	const deadline = performance.now() + DEADLINE_MS;
	return new Promise((resolve, reject) => {
		let request;
		let response;
		let requestClosed = false;
		let finished = false;
		let size = 0;
		const chunks = [];
		const expired = () => performance.now() >= deadline;
		const timer = setTimeout(() => fail("request_timeout"), DEADLINE_MS);

		function finish(error, bytes) {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			const settle = () => (error ? reject(error) : resolve(bytes));
			response?.destroy();
			if (request && !requestClosed) {
				request.once("close", settle);
				request.destroy();
			} else {
				settle();
			}
		}

		function fail(reason, httpStatus) {
			finish(new Unavailable(reason, httpStatus));
		}

		try {
			request = https.request(
				ENDPOINT,
				{
					method: "POST",
					agent: false,
					maxHeaderSize: 16 * 1024,
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"Content-Length": body.length,
						Accept: "application/json",
						"Accept-Encoding": "identity",
					},
				},
				(incoming) => {
					response = incoming;
					response.on("error", () => fail("response_incomplete"));
					response.on("aborted", () => fail("response_incomplete"));
					if (finished || expired()) {
						// Destruction can synchronously emit "aborted"; record the timeout first.
						fail("request_timeout");
						response.destroy();
						return;
					}
					if (response.statusCode !== 200) {
						fail("http_error", response.statusCode);
						return;
					}
					if (
						response.headers["content-encoding"] &&
						response.headers["content-encoding"] !== "identity"
					) {
						fail("invalid_response");
						return;
					}
					response.on("data", (chunk) => {
						if (finished) {
							return;
						}
						if (expired()) {
							fail("request_timeout");
							return;
						}
						size += chunk.length;
						if (size > MAX_BYTES) {
							fail("response_too_large");
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						if (expired()) {
							fail("request_timeout");
						} else if (!response.complete) {
							fail("response_incomplete");
						} else {
							finish(null, Buffer.concat(chunks, size));
						}
					});
				},
			);
			request.on("error", () => fail(expired() ? "request_timeout" : "network_error"));
			request.once("close", () => {
				requestClosed = true;
				if (!finished) {
					fail("response_incomplete");
				}
			});
			// No pooled socket: send only after this request's TLS handshake and deadline check.
			request.once("socket", (socket) => {
				socket.once("secureConnect", () => {
					if (finished) {
						return;
					}
					if (expired()) {
						fail("request_timeout");
						return;
					}
					request.end(body);
				});
			});
		} catch {
			fail("network_error");
		}
	});
}

function projectResponse(bytes, start, end) {
	let result;
	try {
		result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Unavailable("invalid_response");
	}
	requireValue(object(result));
	if (result.errors != null) {
		requireValue(Array.isArray(result.errors));
		requireValue(result.errors.length === 0, "graphql_error");
	}
	const accounts = result.data?.viewer?.accounts;
	requireValue(Array.isArray(accounts) && accounts.length === 1);
	const rows = accounts[0]?.workersInvocationsAdaptive;
	requireValue(Array.isArray(rows) && rows.length <= 24);
	requireValue(rows.length === 24, "incomplete_hours");
	const hours = rows.map((row, index) => {
		const hour = new Date(start + index * HOUR_MS).toISOString();
		const receivedHour = row?.dimensions?.datetimeHour;
		requireValue(
			receivedHour === hour || receivedHour === hour.replace(".000Z", "Z"),
			"invalid_hours",
		);
		const sum = row?.sum;
		requireValue(
			object(sum) &&
				Number.isSafeInteger(sum.requests) &&
				sum.requests >= 0 &&
				Number.isSafeInteger(sum.errors) &&
				sum.errors >= 0,
		);
		requireValue(row.avg == null || object(row.avg));
		const sampleInterval = row.avg?.sampleInterval ?? null;
		requireValue(
			sampleInterval === null ||
				(typeof sampleInterval === "number" &&
					Number.isFinite(sampleInterval) &&
					sampleInterval >= 0),
		);
		return {
			hour,
			requestsEstimate: sum.requests,
			errorsEstimate: sum.errors,
			sampleInterval,
		};
	});
	return {
		status: "available",
		worker: WORKER,
		window: {
			startInclusive: new Date(start).toISOString(),
			endExclusive: new Date(end).toISOString(),
		},
		hours,
	};
}

export async function runWorkerHealth() {
	try {
		const { token, account } = credentials();
		const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		const start = end - 24 * HOUR_MS;
		const body = Buffer.from(
			JSON.stringify({
				query: QUERY,
				variables: {
					accountTag: account,
					start: new Date(start).toISOString(),
					end: new Date(end).toISOString(),
				},
			}),
		);
		const bytes = await requestMetrics(body, token);
		return projectResponse(bytes, start, end);
	} catch (error) {
		return {
			status: "unavailable",
			reason: error instanceof Unavailable ? error.message : "request_failed",
			...(error instanceof Unavailable && error.httpStatus !== undefined
				? { httpStatus: error.httpStatus }
				: {}),
		};
	}
}

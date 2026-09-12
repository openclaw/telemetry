import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { Agent } from "node:https";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { runTelemetryAggregateCapture } from "./telemetry-aggregate-capture.mjs";

const DAY = 86_400_000;
const TIMEOUT = 45_000;
const MAX_ARCHIVE = 14 * 1024 * 1024;
const CONTRACT = "telemetry-r2-daily-aggregate-v1";
const FILES = {
	"bundle-plan.json": 16_384,
	"ae/capture-plan.json": 16_384,
	"ae/q2/query.sql": 9500,
	"ae/q2/attempt.json": 16_384,
	"ae/q2/response.json": 4 * 1024 * 1024,
	"ae/q2/receipt.json": 65_536,
	"http/settings-request.json": 16_384,
	"http/settings-response.json": 256 * 1024,
	"http/settings-receipt.json": 16_384,
	"http/country-request.json": 16_384,
	"http/country-response.json": 2 * 1024 * 1024,
	"http/country-receipt.json": 16_384,
	"http/country.json": 2 * 1024 * 1024,
	"ae-daily/daily.json": 32_768,
	"ae-daily/daily.csv": 32_768,
	"ae-daily/manifest.json": 65_536,
	"manifest.json": 65_536,
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (time) => new Date(time).toISOString();
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keyFor = (day) => `v1/${day}/aggregate.json`;
const ruleId = (day) => `telemetry-v1-${day}`;

class BackupError extends Error {
	constructor(code, scope = "day") {
		super(code);
		this.code = code;
		this.scope = scope;
	}
}
function requireValue(condition, code, scope) {
	if (!condition) throw new BackupError(code, scope);
}
function fields(value, names, code = "archive_schema") {
	requireValue(
		object(value) &&
			Object.keys(value).length === names.length &&
			names.every((name) => Object.hasOwn(value, name)),
		code,
	);
}
function decode(bytes) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new BackupError("invalid_json");
	}
}
function dayTime(day) {
	requireValue(typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day), "invalid_day");
	const time = Date.parse(`${day}T00:00:00.000Z`);
	requireValue(Number.isFinite(time) && time >= 0 && iso(time).slice(0, 10) === day, "invalid_day");
	return time;
}
function expiry(day) {
	const date = new Date(dayTime(day));
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 3;
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const value = iso(Date.UTC(year, month, Math.min(date.getUTCDate(), last)));
	requireValue(!value.startsWith("+"), "invalid_day");
	return value;
}
function unexpired(day, now = Date.now()) {
	requireValue(dayTime(day) + DAY <= now, "day_not_closed");
	requireValue(now < Date.parse(expiry(day)), "source_day_expired");
}
function closedDays(now) {
	requireValue(Number.isFinite(now) && now >= 7 * DAY, "invalid_clock", "global");
	const midnight = Math.floor(now / DAY) * DAY;
	return Array.from({ length: 7 }, (_, index) => iso(midnight - (7 - index) * DAY).slice(0, 10));
}
function lifecycleRule(day) {
	return {
		id: ruleId(day),
		enabled: true,
		conditions: { prefix: `v1/${day}/` },
		deleteObjectsTransition: { condition: { type: "Date", date: expiry(day) } },
	};
}
function lifecyclePlan(anchor, previous) {
	const start = dayTime(anchor);
	fields(previous, ["rules"], "invalid_lifecycle_plan");
	requireValue(Array.isArray(previous.rules) && previous.rules.length <= 1000, "lifecycle_limit");
	const rules = new Map();
	const ids = new Set();
	let multipart;
	for (const rule of previous.rules) {
		requireValue(
			typeof rule?.id === "string" && /^[\x20-\x7e]{1,255}$/u.test(rule.id),
			"lifecycle_rule_conflict",
		);
		requireValue(!ids.has(rule.id), "duplicate_lifecycle_rule");
		ids.add(rule.id);
		if (rule.conditions?.prefix === "") {
			requireValue(
				!multipart &&
					!rule.id.startsWith("telemetry-v1-") &&
					isDeepStrictEqual(rule, {
						id: rule.id,
						enabled: true,
						conditions: { prefix: "" },
						abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
					}),
				"lifecycle_rule_conflict",
			);
			multipart = rule;
			continue;
		}
		const match = /^v1\/(\d{4}-\d{2}-\d{2})\/$/u.exec(rule?.conditions?.prefix);
		requireValue(
			match && isDeepStrictEqual(rule, lifecycleRule(match[1])),
			"lifecycle_rule_conflict",
		);
		requireValue(!rules.has(match[1]), "duplicate_lifecycle_rule");
		rules.set(match[1], rule);
	}
	requireValue(multipart, "multipart_default_readback_required");
	// Never drop older rules: their objects may still await provider deletion.
	for (let offset = -7; offset < 365; offset++) {
		const day = iso(start + offset * DAY).slice(0, 10);
		rules.set(day, lifecycleRule(day));
	}
	requireValue(rules.size + 1 <= 1000, "lifecycle_limit");
	return {
		rules: [
			multipart,
			...[...rules].sort(([a], [b]) => a.localeCompare(b)).map(([, rule]) => rule),
		],
	};
}
function directory(path) {
	requireValue(
		typeof path === "string" &&
			path.length > 0 &&
			path.length <= 4096 &&
			!path.includes("\0") &&
			!path.includes("\\") &&
			!path.split("/").includes(".."),
		"unsafe_path",
		"global",
	);
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
		current = join(current, part);
		const info = lstatSync(current);
		requireValue(info.isDirectory() && !info.isSymbolicLink(), "unsafe_directory", "global");
	}
	return absolute;
}
function privateMode(info, mode) {
	requireValue(
		(info.mode & 0o777) === mode &&
			(typeof process.getuid !== "function" || info.uid === process.getuid()),
		"private_ownership_required",
		"global",
	);
}
function privateRead(path, maximum) {
	directory(dirname(path));
	const before = lstatSync(path);
	requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "unsafe_file");
	privateMode(before, 0o600);
	requireValue(before.size <= maximum, "file_size");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		requireValue(
			opened.dev === before.dev &&
				opened.ino === before.ino &&
				opened.size === before.size &&
				opened.isFile() &&
				opened.nlink === 1,
			"file_changed",
		);
		privateMode(opened, 0o600);
		const bytes = Buffer.alloc(opened.size + 1);
		let used = 0;
		for (;;) {
			const count = readSync(fd, bytes, used, bytes.length - used, used);
			if (!count) break;
			used += count;
			requireValue(used <= opened.size, "file_changed");
		}
		const after = fstatSync(fd);
		requireValue(
			used === opened.size &&
				after.size === opened.size &&
				after.mtimeMs === opened.mtimeMs &&
				after.ctimeMs === opened.ctimeMs,
			"file_changed",
		);
		return bytes.subarray(0, used);
	} finally {
		closeSync(fd);
	}
}
function privateWrite(path, bytes) {
	directory(dirname(path));
	privateMode(lstatSync(dirname(path)), 0o700);
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		privateMode(fstatSync(fd), 0o600);
		writeFileSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}
function claim(path) {
	requireValue(
		typeof path === "string" &&
			path.length > 0 &&
			path.length <= 4096 &&
			!path.includes("\0") &&
			!path.includes("\\") &&
			!path.split("/").includes(".."),
		"work_directory_required",
		"global",
	);
	const root = join(directory(dirname(path)), parse(path).base);
	requireValue(root === resolve(path) && parse(path).base !== "", "unsafe_path", "global");
	mkdirSync(root, { mode: 0o700 });
	const identity = lstatSync(root);
	privateMode(identity, 0o700);
	return {
		root,
		guard() {
			directory(root);
			const current = lstatSync(root);
			privateMode(current, 0o700);
			requireValue(
				current.dev === identity.dev && current.ino === identity.ino,
				"directory_changed",
				"global",
			);
		},
	};
}
function scratch(work, day) {
	work.guard();
	const root = mkdtempSync(join(work.root, `${day}-`));
	const identity = lstatSync(root);
	privateMode(identity, 0o700);
	return {
		root,
		remove() {
			work.guard();
			directory(root);
			const current = lstatSync(root);
			requireValue(
				current.dev === identity.dev && current.ino === identity.ino,
				"directory_changed",
				"global",
			);
			rmSync(root, { recursive: true });
		},
	};
}
function readbackTime(value) {
	const match =
		typeof value === "string" &&
		/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/u.exec(value);
	requireValue(match, "invalid_lifecycle_horizon", "global");
	const time = Date.parse(`${match[1]}.000Z`);
	requireValue(
		Number.isFinite(time) && time >= 0 && iso(time).slice(0, 19) === match[1],
		"invalid_lifecycle_horizon",
		"global",
	);
	return BigInt(time) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function configFrom(config, configFile, now) {
	if (configFile) config = decode(privateRead(configFile, 8192));
	else if (config === undefined) {
		const value = process.env.TELEMETRY_BACKUP_CONFIG;
		requireValue(
			typeof value === "string" && Buffer.byteLength(value) <= 8192,
			"config_required",
			"global",
		);
		config = decode(Buffer.from(value));
	}
	fields(
		config,
		["schemaVersion", "accountId", "zoneId", "r2AccountId", "bucket", "lifecycle"],
		"invalid_config",
	);
	requireValue(config.schemaVersion === 1, "invalid_config", "global");
	for (const name of ["accountId", "zoneId", "r2AccountId"])
		requireValue(
			typeof config[name] === "string" && /^[a-f0-9]{32}$/u.test(config[name]),
			"invalid_identity",
			"global",
		);
	requireValue(
		typeof config.bucket === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(config.bucket),
		"invalid_bucket",
		"global",
	);
	fields(config.lifecycle, ["firstDay", "lastDay", "verifiedAt"], "invalid_lifecycle_horizon");
	const first = dayTime(config.lifecycle.firstDay);
	const last = dayTime(config.lifecycle.lastDay);
	const verified = readbackTime(config.lifecycle.verifiedAt);
	requireValue(
		last >= first && (last - first) / DAY < 1000 && verified <= BigInt(now) * 1000n,
		"invalid_lifecycle_horizon",
		"global",
	);
	return config;
}
function identities(config) {
	return {
		sourceIdentity: {
			aeAccountSha256: hash(config.accountId),
			httpZoneSha256: hash(config.zoneId),
		},
		storageIdentity: {
			r2AccountSha256: hash(config.r2AccountId),
			bucketSha256: hash(config.bucket),
		},
	};
}
function writeGate(config, day) {
	requireValue(
		day >= config.lifecycle.firstDay && day <= config.lifecycle.lastDay,
		"outside_verified_lifecycle_horizon",
		"global",
	);
	unexpired(day);
}
function credentials(role) {
	const prefix = `TELEMETRY_BACKUP_R2_${role}`;
	const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`];
	const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`];
	requireValue(
		typeof accessKeyId === "string" &&
			/^[A-Za-z0-9_-]{1,128}$/u.test(accessKeyId) &&
			typeof secretAccessKey === "string" &&
			/^[\x21-\x7e]{1,4096}$/u.test(secretAccessKey),
		"explicit_r2_credentials_required",
		"global",
	);
	return { accessKeyId, secretAccessKey };
}
function captureCredentials() {
	const ae = process.env.TELEMETRY_AE_READ_TOKEN;
	const http = process.env.TELEMETRY_HTTP_READ_TOKEN;
	requireValue(
		typeof ae === "string" &&
			typeof http === "string" &&
			ae !== http &&
			/^[\x21-\x7e]{1,4096}$/u.test(ae) &&
			/^[\x21-\x7e]{1,4096}$/u.test(http),
		"explicit_capture_credentials_required",
		"global",
	);
}
async function verifyCapture(config, day, output) {
	try {
		await runTelemetryAggregateCapture({
			day,
			output,
			accountId: config.accountId,
			zoneId: config.zoneId,
			verify: true,
		});
	} catch {
		throw new BackupError("offline_capture_verification_failed");
	}
}
async function encodeArchive(config, day, output) {
	await verifyCapture(config, day, output);
	const files = Object.entries(FILES).map(([path, maximum]) => {
		const bytes = privateRead(join(output, path), maximum);
		return { path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
	});
	const bytes = Buffer.from(
		json({
			schemaVersion: 1,
			contract: CONTRACT,
			day,
			expiresAt: expiry(day),
			...identities(config),
			files,
		}),
	);
	requireValue(bytes.length <= MAX_ARCHIVE, "archive_size");
	return bytes;
}
async function extractArchive(bytes, digest, config, day, output) {
	unexpired(day);
	requireValue(bytes.length <= MAX_ARCHIVE && hash(bytes) === digest, "archive_hash");
	const archive = decode(bytes);
	fields(archive, [
		"schemaVersion",
		"contract",
		"day",
		"expiresAt",
		"sourceIdentity",
		"storageIdentity",
		"files",
	]);
	requireValue(
		archive.schemaVersion === 1 &&
			archive.contract === CONTRACT &&
			archive.day === day &&
			archive.expiresAt === expiry(day) &&
			isDeepStrictEqual(archive.sourceIdentity, identities(config).sourceIdentity) &&
			isDeepStrictEqual(archive.storageIdentity, identities(config).storageIdentity) &&
			json(archive) === bytes.toString("utf8"),
		"archive_identity_or_contract",
	);
	const names = Object.keys(FILES);
	requireValue(
		Array.isArray(archive.files) && archive.files.length === names.length,
		"archive_files",
	);
	const decoded = archive.files.map((file, index) => {
		fields(file, ["path", "bytes", "sha256", "base64"]);
		requireValue(
			file.path === names[index] &&
				Number.isSafeInteger(file.bytes) &&
				file.bytes >= 0 &&
				file.bytes <= FILES[file.path] &&
				typeof file.sha256 === "string" &&
				/^[a-f0-9]{64}$/u.test(file.sha256) &&
				typeof file.base64 === "string" &&
				file.base64.length === 4 * Math.ceil(file.bytes / 3),
			"archive_file_bounds",
		);
		const content = Buffer.from(file.base64, "base64");
		requireValue(
			content.length === file.bytes &&
				content.toString("base64") === file.base64 &&
				hash(content) === file.sha256,
			"archive_file_hash",
		);
		return content;
	});
	const bundle = claim(output);
	for (const path of ["ae", "ae/q2", "http", "ae-daily"]) {
		bundle.guard();
		mkdirSync(join(bundle.root, path), { mode: 0o700 });
	}
	for (let index = 0; index < names.length; index++) {
		bundle.guard();
		privateWrite(join(bundle.root, names[index]), decoded[index]);
	}
	await verifyCapture(config, day, bundle.root);
	bundle.guard();
	unexpired(day);
}
async function collect(body, maximum, expected) {
	const chunks = [];
	let used = 0;
	try {
		requireValue(body && typeof body[Symbol.asyncIterator] === "function", "r2_body_missing");
		for await (const chunk of body) {
			requireValue(chunk instanceof Uint8Array && used + chunk.length <= maximum, "r2_body_size");
			used += chunk.length;
			chunks.push(chunk);
		}
		requireValue(expected === undefined || used === expected, "r2_body_truncated");
		return Buffer.concat(chunks, used);
	} finally {
		body?.destroy?.();
	}
}
async function storeFor(config, role) {
	const auth = credentials(role);
	const sdk = await import("@aws-sdk/client-s3");
	const client = new sdk.S3Client({
		endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
		region: "auto",
		credentials: auth,
		forcePathStyle: true,
		followRegionRedirects: false,
		defaultsMode: "standard",
		useArnRegion: false,
		useDualstackEndpoint: false,
		useFipsEndpoint: false,
		disableS3ExpressSessionAuth: true,
		authSchemePreference: ["aws.auth#sigv4"],
		sigv4aSigningRegionSet: [],
		userAgentAppId: "telemetry-backup",
		maxAttempts: 1,
		retryMode: "standard",
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		requestHandler: {
			connectionTimeout: 5000,
			requestTimeout: TIMEOUT,
			throwOnRequestTimeout: true,
			httpsAgent: new Agent({ keepAlive: true, maxSockets: 1 }),
		},
		logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
	});
	let activeBody;
	client.middlewareStack.add(
		(next) => async (args) => {
			args.request.headers["accept-encoding"] = "identity";
			return next(args);
		},
		{ step: "build", name: "telemetryIdentityEncoding" },
	);
	// Runs immediately after transport, before the SDK can parse an upstream error body.
	client.middlewareStack.add(
		(next, context) => async (args) => {
			const result = await next(args);
			const response = result.response;
			activeBody = response.body;
			const status = response.statusCode;
			const command = context.commandName;
			if (status !== 200) {
				response.body?.destroy?.();
				if (status === 401 || status === 403) throw new BackupError("r2_auth_failed", "global");
				if (command === "HeadBucketCommand" || (command === "PutObjectCommand" && status === 404))
					throw new BackupError("r2_bucket_failed", "global");
				if (command === "HeadObjectCommand" && status === 404)
					throw new BackupError("object_missing");
				if (command === "PutObjectCommand" && status === 412)
					throw new BackupError("conditional_put_conflict");
				if (status >= 300 && status < 400) throw new BackupError("r2_redirect_rejected", "global");
				throw new BackupError(
					command === "PutObjectCommand" ? "put_unconfirmed" : "r2_request_failed",
				);
			}
			const encoding = response.headers["content-encoding"];
			requireValue(!encoding || encoding === "identity", "r2_encoding");
			const get = command === "GetObjectCommand";
			const length = response.headers["content-length"];
			if (get)
				requireValue(
					typeof length === "string" && /^\d{1,8}$/u.test(length) && Number(length) <= MAX_ARCHIVE,
					"r2_body_size",
				);
			const bytes = await collect(
				response.body,
				get ? MAX_ARCHIVE : 65_536,
				get ? Number(length) : undefined,
			);
			response.body = Readable.from([bytes]);
			return result;
		},
		{ step: "deserialize", priority: "low", name: "telemetryBoundedResponse" },
	);
	return {
		async request(command, input = {}) {
			const controller = new AbortController();
			let timer;
			try {
				return await Promise.race([
					(async () => {
						const result = await client.send(
							new sdk[`${command}Command`]({ Bucket: config.bucket, ...input }),
							{ abortSignal: controller.signal },
						);
						if (command === "GetObject") {
							result.bytes = await collect(result.Body, MAX_ARCHIVE, result.ContentLength);
							delete result.Body;
						}
						return result;
					})(),
					new Promise((_, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							activeBody?.destroy?.();
							reject(new BackupError(command === "PutObject" ? "put_unconfirmed" : "r2_timeout"));
						}, TIMEOUT);
					}),
				]);
			} catch (error) {
				if (error instanceof BackupError) throw error;
				throw new BackupError(
					command === "PutObject" ? "put_unconfirmed" : "r2_request_failed",
					command === "HeadBucket" ? "global" : "day",
				);
			} finally {
				clearTimeout(timer);
				controller.abort();
				activeBody?.destroy?.();
				activeBody = undefined;
			}
		},
		close() {
			client.destroy();
		},
	};
}
function nativeExpiration(head, day) {
	const expected = `expiry-date="${new Date(expiry(day)).toUTCString()}", rule-id="${ruleId(day)}"`;
	requireValue(head.Expiration === expected, "native_expiration_mismatch", "global");
}
function objectMetadata(head, day) {
	nativeExpiration(head, day);
	fields(head.Metadata, ["sha256", "source-day", "expires-at", "contract"], "object_metadata");
	requireValue(
		head.Metadata["source-day"] === day &&
			head.Metadata["expires-at"] === expiry(day) &&
			head.Metadata.contract === CONTRACT &&
			/^[a-f0-9]{64}$/u.test(head.Metadata.sha256) &&
			Number.isSafeInteger(head.ContentLength) &&
			head.ContentLength > 0 &&
			head.ContentLength <= MAX_ARCHIVE &&
			typeof head.ETag === "string" &&
			/^[\x21-\x7e]{1,256}$/u.test(head.ETag),
		"object_metadata",
	);
}
async function remoteBundle(store, config, day, output) {
	let head;
	try {
		head = await store.request("HeadObject", { Key: keyFor(day) });
	} catch (error) {
		if (error instanceof BackupError && error.code === "object_missing") return false;
		throw error;
	}
	objectMetadata(head, day);
	unexpired(day);
	const response = await store.request("GetObject", { Key: keyFor(day), IfMatch: head.ETag });
	nativeExpiration(response, day);
	requireValue(
		response.ContentLength === head.ContentLength &&
			isDeepStrictEqual(response.Metadata, head.Metadata) &&
			response.ETag === head.ETag,
		"object_changed",
	);
	await extractArchive(response.bytes, head.Metadata.sha256, config, day, output);
	return true;
}
function failure(error) {
	return {
		status: "failed",
		reason: error instanceof BackupError ? error.code : "operation_failed",
	};
}
function cleanupReceipt(work, config, day) {
	work.guard();
	privateWrite(
		join(work.root, "cleanup-required.json"),
		json({
			status: "cleanup_required",
			reason: "native_expiration_mismatch",
			r2AccountId: config.r2AccountId,
			bucket: config.bucket,
			key: keyFor(day),
			sourceDay: day,
			expectedExpiresAt: expiry(day),
			action:
				"Stop uploads. An operator must inspect and clean up this exact object; do not purge unknown objects.",
		}),
	);
}

/** Default is a side-effect-free plan. Execution reconciles exactly seven closed UTC days. */
export async function runTelemetryBackup({ execute = false, config, configFile, workDir } = {}) {
	let work;
	let store;
	const days = [];
	try {
		const now = Date.now();
		const selected = closedDays(now);
		requireValue(typeof execute === "boolean", "invalid_mode", "global");
		if (!execute)
			return { status: "planned", days: selected.map((day) => ({ day, status: "planned" })) };
		config = configFrom(config, configFile, now);
		work = claim(workDir);
		store = await storeFor(config, "WRITE");
		await store.request("HeadBucket");
		for (const day of selected) {
			const stage = scratch(work, day);
			try {
				if (await remoteBundle(store, config, day, join(stage.root, "remote"))) {
					days.push({ day, status: "verified" });
					continue;
				}
				writeGate(config, day);
				captureCredentials();
				try {
					await runTelemetryAggregateCapture({
						day,
						output: join(stage.root, "capture"),
						accountId: config.accountId,
						zoneId: config.zoneId,
						execute: true,
					});
				} catch (error) {
					const authFailure =
						/^(?:HTTP settings|HTTP country|AE hourly) request failed \(HTTP (?:401|403)\)/u.test(
							error?.message,
						);
					throw new BackupError(
						authFailure ? "capture_auth_failed" : "capture_failed",
						authFailure ? "global" : "day",
					);
				}
				const bytes = await encodeArchive(config, day, join(stage.root, "capture"));
				writeGate(config, day);
				let reconciled = false;
				try {
					await store.request("PutObject", {
						Key: keyFor(day),
						Body: bytes,
						ContentLength: bytes.length,
						ContentType: "application/json",
						CacheControl: "private, no-store",
						IfNoneMatch: "*",
						Metadata: {
							sha256: hash(bytes),
							"source-day": day,
							"expires-at": expiry(day),
							contract: CONTRACT,
						},
					});
				} catch (error) {
					if (
						!(error instanceof BackupError) ||
						!["put_unconfirmed", "conditional_put_conflict"].includes(error.code)
					)
						throw error;
					reconciled = true;
				}
				// A valid concurrent winner is authoritative, not a reason to overwrite or recapture.
				requireValue(
					await remoteBundle(store, config, day, join(stage.root, "confirmed")),
					"put_not_confirmed",
				);
				days.push({ day, status: reconciled ? "reconciled" : "uploaded" });
			} catch (error) {
				days.push({ day, ...failure(error) });
				if (error instanceof BackupError && error.code === "native_expiration_mismatch")
					cleanupReceipt(work, config, day);
				if (!(error instanceof BackupError) || error.scope === "global") break;
			} finally {
				stage.remove();
			}
		}
		const result = {
			status:
				days.length === 7 && days.every((day) => day.status !== "failed") ? "complete" : "failed",
			days,
		};
		work.guard();
		privateWrite(join(work.root, "receipt.json"), json(result));
		return result;
	} catch (error) {
		return { ...failure(error), days };
	} finally {
		store?.close();
	}
}

/** Uses only independently supplied read credentials; never invokes capture execution. */
export async function runTelemetryRestore({ day, config, configFile, output } = {}) {
	let work;
	let stage;
	let store;
	try {
		unexpired(day);
		config = configFrom(config, configFile, Date.now());
		work = claim(output);
		stage = scratch(work, day);
		store = await storeFor(config, "READ");
		await store.request("HeadBucket");
		requireValue(
			await remoteBundle(store, config, day, join(stage.root, "bundle")),
			"object_missing",
		);
		work.guard();
		unexpired(day);
		renameSync(join(stage.root, "bundle"), join(work.root, "bundle"));
		const result = { status: "restored", day };
		privateWrite(join(work.root, "receipt.json"), json(result));
		return result;
	} catch (error) {
		if (
			work &&
			config &&
			error instanceof BackupError &&
			error.code === "native_expiration_mismatch"
		)
			cleanupReceipt(work, config, day);
		return failure(error);
	} finally {
		store?.close();
		stage?.remove();
	}
}

/** Writes only a proposed native lifecycle configuration, never contacts an admin API. */
export async function runTelemetryLifecyclePlan({ anchor, previousFile, output } = {}) {
	try {
		requireValue(
			typeof previousFile === "string" && previousFile.length > 0,
			"lifecycle_readback_required",
		);
		const previous = decode(privateRead(previousFile, 512 * 1024));
		const plan = lifecyclePlan(anchor, previous);
		requireValue(typeof output === "string" && output.length > 0, "plan_output_required");
		privateWrite(output, json(plan));
		return { status: "planned" };
	} catch (error) {
		return failure(error);
	}
}

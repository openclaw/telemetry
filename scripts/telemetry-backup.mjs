import { parseArgs } from "node:util";
import {
	runTelemetryBackup,
	runTelemetryLifecyclePlan,
	runTelemetryRestore,
} from "./lib/telemetry-backup.mjs";

try {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			execute: { type: "boolean", default: false },
			config: { type: "string" },
			"work-dir": { type: "string" },
			day: { type: "string" },
			output: { type: "string" },
			anchor: { type: "string" },
			previous: { type: "string" },
		},
	});
	const mode = positionals[0] ?? "backup";
	if (positionals.length > 1 || !["backup", "restore", "lifecycle-plan"].includes(mode))
		throw new Error("invalid mode");
	if (mode !== "backup" && values.execute) throw new Error("invalid mode");
	if (mode === "backup" && (values.day || values.output || values.anchor || values.previous))
		throw new Error("invalid options");
	if (mode === "restore" && (values["work-dir"] || values.anchor || values.previous))
		throw new Error("invalid options");
	if (mode === "lifecycle-plan" && (values.config || values["work-dir"] || values.day))
		throw new Error("invalid options");
	let result;
	if (mode === "backup") {
		result = await runTelemetryBackup({
			execute: values.execute,
			configFile: values.config,
			workDir: values["work-dir"],
		});
	} else if (mode === "restore") {
		result = await runTelemetryRestore({
			day: values.day,
			configFile: values.config,
			output: values.output,
		});
	} else {
		result = await runTelemetryLifecyclePlan({
			anchor: values.anchor,
			previousFile: values.previous,
			output: values.output,
		});
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.status === "failed") process.exitCode = 1;
} catch {
	process.stderr.write('{"status":"failed","reason":"invalid_arguments_or_operation"}\n');
	process.exitCode = 1;
}

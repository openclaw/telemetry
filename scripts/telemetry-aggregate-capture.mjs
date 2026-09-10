import { parseArgs } from "node:util";
import { runTelemetryAggregateCapture } from "./lib/telemetry-aggregate-capture.mjs";

const usage =
	"Usage: npm run telemetry:capture -- --day YYYY-MM-DD [--execute | --verify] [--output <directory> --account-id <id> --zone-id <id>]";

try {
	const { values } = parseArgs({
		options: {
			day: { type: "string" },
			output: { type: "string" },
			"account-id": { type: "string" },
			"zone-id": { type: "string" },
			execute: { type: "boolean", default: false },
			verify: { type: "boolean", default: false },
		},
	});
	if (!values.day) throw new Error(usage);
	console.log(
		JSON.stringify(
			await runTelemetryAggregateCapture({
				day: values.day,
				output: values.output,
				accountId: values["account-id"],
				zoneId: values["zone-id"],
				execute: values.execute,
				verify: values.verify,
			}),
		),
	);
} catch (error) {
	console.error(error?.code?.startsWith("ERR_PARSE_ARGS") ? usage : error.message);
	process.exitCode = 1;
}

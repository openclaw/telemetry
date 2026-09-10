import { parseArgs } from "node:util";
import { runTelemetryHistory } from "./lib/telemetry-history.mjs";

const usage =
	"Usage: npm run telemetry:history -- --archive <directory> --query <id> --plan-sha256 <sha256> --receipt-sha256 <sha256> --output <directory>";

try {
	const { values } = parseArgs({
		options: Object.fromEntries(
			["archive", "query", "plan-sha256", "receipt-sha256", "output"].map((key) => [
				key,
				{ type: "string" },
			]),
		),
	});
	if (Object.values(values).length !== 5) throw new Error(usage);
	console.log(
		JSON.stringify(
			runTelemetryHistory({
				archive: values.archive,
				query: values.query,
				planSha256: values["plan-sha256"],
				receiptSha256: values["receipt-sha256"],
				output: values.output,
			}),
		),
	);
} catch (error) {
	console.error(error?.code?.startsWith("ERR_PARSE_ARGS") ? usage : error.message);
	process.exitCode = 1;
}

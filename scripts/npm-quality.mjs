import { parseArgs } from "node:util";
import { runNpmQuality } from "./lib/npm-quality.mjs";

const usage = "Usage: npm run npm:quality -- --manifest <manifest.json> --output <new-directory>";

try {
	const { values } = parseArgs({
		options: { manifest: { type: "string" }, output: { type: "string" } },
	});
	if (!values.manifest || !values.output) throw new Error(usage);
	const { summary } = runNpmQuality({ manifest: values.manifest, output: values.output });
	console.log(JSON.stringify({ status: "written", ...summary }));
} catch (error) {
	console.error(error?.code?.startsWith("ERR_PARSE_ARGS") ? usage : error.message);
	process.exitCode = 1;
}

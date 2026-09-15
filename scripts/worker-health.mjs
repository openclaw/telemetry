import { runWorkerHealth } from "./lib/worker-health.mjs";

const result =
	process.argv.length === 2
		? await runWorkerHealth()
		: { status: "unavailable", reason: "invalid_arguments" };

console.log(JSON.stringify(result));
if (result.status !== "available") {
	process.exitCode = 1;
}

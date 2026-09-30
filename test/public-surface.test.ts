import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["/api/stats", "/api/stats?cache=reports-v2"])(
	"does not serve aggregates from %s, even with a warm cache",
	async (path) => {
		const match = vi.fn(async () => Response.json({ totalPings: 123 }, { headers: { age: "0" } }));
		const upstream = vi.fn<typeof fetch>();
		const writeDataPoint = vi.fn();
		vi.stubGlobal("caches", { default: { match } });
		vi.stubGlobal("fetch", upstream);
		const response = await worker.fetch(new Request(`https://telemetry.example${path}`), {
			TELEMETRY: { writeDataPoint },
		});
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toEqual({ error: "not_found" });
		expect(match).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
		expect(writeDataPoint).not.toHaveBeenCalled();
	},
);

it.each(["/", "/index.html"])("serves privacy information without a dashboard at %s", async (path) => {
	const response = await worker.fetch(new Request(`https://telemetry.example${path}`), {
		TELEMETRY: { writeDataPoint() {} },
	});
	expect(response.status).toBe(200);
	const html = await response.text();
	expect(html).toContain("How to turn it off");
	expect(html).toContain("Approximate location");
	expect(html).toContain("outcomes <strong>on by default</strong>");
	expect(html).toContain("<code>DO_NOT_TRACK</code> controls feature statistics, not update outcomes");
	expect(html).toContain("Nix mode suppress outcomes");
	expect(html).toContain(
		"a truthy <code>CI</code> always suppresses outcomes, even when a replacement <code>OPENCLAW_TELEMETRY_ENDPOINT</code> is configured",
	);
	expect(html).toContain(
		"The replacement-endpoint exception applies only to daily update checks and optional feature statistics, not update outcomes",
	);
	expect(html).not.toContain("suppresses them unless a replacement");
	expect(html).not.toContain("suppresses both tiers unless a replacement");
	expect(html).toContain("before releasing the default-on client");
	expect(html).not.toContain("/api/stats");
	expect(html).not.toContain("Loading aggregates");
	expect(html).not.toContain("<script>");
});

/**
 * The public face of this service. It exists so that "here is exactly what we
 * collect" is something a visitor can read in ten seconds, and so the numbers
 * we collect are given back to the community that sent them.
 */
export function renderHomePage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw telemetry</title>
<style>
:root { color-scheme: light dark; --bg: #fbfaf9; --fg: #1c1a17; --muted: #6b645c; --line: #e2ddd7; --accent: #b4530a; }
@media (prefers-color-scheme: dark) { :root { --bg: #17150f; --fg: #ece7e1; --muted: #9c948a; --line: #322d26; --accent: #f0913f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
h1 { font-size: 1.75rem; margin: 0 0 .35rem; letter-spacing: 0; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
p, li { color: var(--fg); }
.lede { color: var(--muted); margin: 0 0 2rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; background: color-mix(in oklab, var(--fg) 8%, transparent); padding: .1em .35em; border-radius: 4px; }
pre { background: color-mix(in oklab, var(--fg) 6%, transparent); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td code { overflow-wrap: anywhere; }
a { color: var(--accent); }
.never li { margin: .2rem 0; }
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .9rem; }
.stats-grid table { table-layout: fixed; }
.stats-grid th:first-child, .stats-grid td:first-child { width: 65%; overflow-wrap: anywhere; }
.stats-grid th:last-child, .stats-grid td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.stats-grid { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.stats-grid h3 { font-size: 1rem; margin-bottom: .4rem; }
.stats-grid p { font-size: .85rem; overflow-wrap: anywhere; }
.stats-grid .cohort { grid-column: 1 / -1; }
.cohort th:first-child, .cohort td:first-child { width: 38%; }
.cohort th:not(:first-child), .cohort td:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.cohort-share { display: block; color: var(--muted); font-size: .85rem; }
[hidden] { display: none !important; }
.muted { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>OpenClaw telemetry</h1>
<p class="lede">This service answers the daily update check that OpenClaw installs make and provides anonymous usage aggregates. Everything it does is in <a href="https://github.com/openclaw/telemetry">this repository</a>.</p>

<h2>What an install sends</h2>
<p>With automatic update checks enabled, a successful version check is reused for 24 hours. The request carries a User-Agent:</p>
<pre><code>openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)</code></pre>
<p>Anonymous feature statistics are off by default. Operators can enable them during interactive setup, with <code>openclaw telemetry on</code>, or with <code>telemetry.enabled: true</code>. When enabled, the same request carries a small body of feature facts:</p>
<pre><code>{
  "schema": 1,
  "version": "2026.8.2",
  "platform": "darwin-arm64",
  "node": "26.0.1",
  "surface": "gateway",
  "features": {
    "channels": ["telegram", "discord"],
    "providerFamilies": ["anthropic", "openai"],
    "plugins": ["codex", "diagnostics-otel"],
    "pluginsEnabled": 7,
    "sessionsLast24h": 14
  }
}</code></pre>
<p>Interactive setup defaults to <strong>No thanks</strong>; guided Quick Start skips the question. Scripted installs do not opt in automatically. The enabled setting controls inclusion, not whether a prompt was answered.</p>
<p>Channels and providers describe configuration; plugins describe enabled inventory, not invocations. <code>sessionsLast24h</code> counts retained session-creation events timestamped in the preceding 24 hours, not active sessions or messages. Missing or unreadable local state produces zero.</p>

<h2>Approximate location</h2>
<p>Cloudflare provides approximate location information, such as country and city, plus region code and timezone. No raw IP addresses or precise location coordinates are stored in our analytics.</p>
<p>Recorded update-only requests also include these fields when feature statistics are off or <code>DO_NOT_TRACK</code> is set. Missing or invalid fields are left empty. Records are retained for three months; the public aggregates below do not expose location information.</p>

<h2>What we exclude from Analytics Engine</h2>
<ul class="never">
<li>Message content, prompts, model output, file contents, or file paths</li>
<li>Credentials, tokens, or secret references</li>
<li>IP addresses, hostnames, usernames, or account identifiers</li>
<li>Any install ID or device ID</li>
<li>Coordinates, postal codes, or physical-device hardware details</li>
</ul>
<p>Reports contain no user, account, install, or device identifier. Cloudflare processes connection IP addresses, and the Worker uses them transiently for rate limiting without storing them in Analytics Engine. Worker logs are disabled; Cloudflare's separate infrastructure processing is outside those settings.</p>

<h2>How to turn it off</h2>
<table>
<tr><th>Command or setting</th><th>Effect</th></tr>
<tr><td><code>openclaw telemetry off</code></td><td>Stops the feature-stats body. Update checks continue.</td></tr>
<tr><td><code>DO_NOT_TRACK=1</code></td><td>Same, enforced from the environment.</td></tr>
<tr><td><code>update.checkOnStart: false</code></td><td>Stops both tiers of automatic update requests. Explicit updates and other configured services are separate.</td></tr>
</table>
<p><code>OPENCLAW_NO_AUTO_UPDATE=1</code> also prevents automatic update requests. A truthy <code>CI</code> suppresses both tiers unless a replacement <code>OPENCLAW_TELEMETRY_ENDPOINT</code> is explicitly configured.</p>
<p><code>openclaw telemetry show</code> displays policy and a CLI-built payload preview, not the exact next Gateway payload or server-derived location information. Registry state and collection time can differ. If policy disables requests, it shows <code>Request: none</code>. Disabling requests does not erase previously recorded rows.</p>

<h2>What we learn</h2>
<p>Counts are weighted report estimates, not unique installations or users. Configuration and inventory do not measure feature use. Repeated reports can count again.</p>
<p class="muted" id="stats-status">Loading aggregates…</p>
<div id="stats-summary" hidden>
  <p id="stats-window"></p>
  <p id="stats-totals"></p>
  <p class="muted" id="stats-watermarks"></p>
  <p class="muted" id="stats-generated"></p>
</div>
<div class="stats-grid" id="stats" hidden>
  <div class="cohort"><h3>Versions</h3><p class="muted">Up to 10 rows from a top-25 ranking by reports. This is a truncated breakdown.</p><table><thead><tr><th>Version</th><th>Reports</th><th>With features</th></tr></thead><tbody id="versions"></tbody></table></div>
  <div class="cohort"><h3>Platforms</h3><p class="muted">Up to 10 rows from a top-25 ranking by reports. This is a truncated breakdown.</p><table><thead><tr><th>Platform</th><th>Reports</th><th>With features</th></tr></thead><tbody id="platforms"></tbody></table></div>
  <div class="cohort"><h3>Reported process architecture</h3><p class="muted">Architecture of the reporting process, not physical device hardware. Unrecognized values are grouped as other; missing values as unknown.</p><table><thead><tr><th>Architecture</th><th>Reports</th><th>With features</th></tr></thead><tbody id="architectures"></tbody></table></div>
  <div><h3>Configured channels</h3><p class="muted" id="channels-meta"></p><table><thead><tr><th>Channel</th><th>Reports</th></tr></thead><tbody id="channels"></tbody></table></div>
  <div><h3>Configured providers</h3><p class="muted" id="providers-meta"></p><table><thead><tr><th>Provider</th><th>Reports</th></tr></thead><tbody id="providers"></tbody></table></div>
  <div><h3>Plugin inventory</h3><p class="muted" id="plugins-meta"></p><table><thead><tr><th>Plugin</th><th>Reports</th></tr></thead><tbody id="plugins"></tbody></table></div>
</div>
<p class="muted">Feature percentages use only the feature reports and reports in the same row and query. They are not opt-in rates. Queries can use different samples; row totals need not match the summary or other tables. An unavailable percentage is not zero.</p>
<p class="muted">Top ten entries per feature table. Category queries can use different samples, so their report bases and latest event times may differ. New public-name acceptance improves coverage; it does not by itself prove increased adoption.</p>

<footer>
Run by the OpenClaw Foundation. Source: <a href="https://github.com/openclaw/telemetry">github.com/openclaw/telemetry</a> ·
Docs: <a href="https://docs.openclaw.ai/gateway/telemetry">docs.openclaw.ai/gateway/telemetry</a>
</footer>
</main>
<script>
(async () => {
  const status = document.getElementById("stats-status");
  try {
    const response = await fetch("/api/stats", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    const fill = (id, rows, cohort = false) => {
      const tbody = document.getElementById(id);
      tbody.innerHTML = "";
      if (!rows?.length) {
        const tr = document.createElement("tr");
        const empty = document.createElement("td");
        empty.colSpan = cohort ? 3 : 2;
        empty.textContent = rows ? "No reports." : "Unavailable.";
        tr.append(empty);
        tbody.append(tr);
      }
      for (const [label, count, features] of (rows ?? []).slice(0, 10)) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = label;
        const value = document.createElement("td");
        value.textContent = count.toLocaleString();
        tr.append(name, value);
        if (cohort) {
          const featureValue = document.createElement("td");
          if (Number.isSafeInteger(features) && features >= 0 && features <= count) {
            featureValue.textContent = features.toLocaleString();
            const share = document.createElement("span");
            share.className = "cohort-share";
            share.textContent = count > 0
              ? (features / count).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })
              : "Unavailable";
            featureValue.append(share);
          } else {
            featureValue.textContent = "Unavailable";
          }
          tr.append(featureValue);
        }
        tbody.append(tr);
      }
    };
    fill("versions", data.versions.map((row) => [row.version, row.pings, row.featureReports]), true);
    fill("platforms", data.platforms.map((row) => [row.platform, row.pings, row.featureReports]), true);
    fill("architectures", data.architectures?.map((row) => [row.architecture, row.pings, row.featureReports]), true);
    fill("channels", data.channels.map((row) => [row.channel, row.reports]));
    fill("providers", data.providerFamilies.map((row) => [row.provider, row.reports]));
    fill("plugins", data.plugins.map((row) => [row.plugin, row.reports]));
    const date = (value) => value === null ? "none in this window" : new Date(value).toUTCString();
    for (const [id, key] of [["channels", "channels"], ["providers", "providerFamilies"], ["plugins", "plugins"]]) {
      const metadata = data.featureMetadata[key];
      document.getElementById(id + "-meta").textContent =
        metadata.featureReports.toLocaleString() + " feature reports in this category sample. Latest event: " + date(metadata.latestFeatureEventAt) + ".";
    }
    status.textContent = data.summary.totalPings === 0 ? "No update reports in this window." : "Seven-day report estimates.";
    document.getElementById("stats-window").textContent =
      "Window: " + date(data.windowStart) + " (inclusive) to " + date(data.windowEnd) + " (exclusive).";
    document.getElementById("stats-totals").textContent =
      data.summary.totalPings.toLocaleString() + " update reports; " + data.summary.featureReports.toLocaleString() + " with feature statistics in the summary sample.";
    document.getElementById("stats-watermarks").textContent =
      "Latest recorded event: " + date(data.summary.latestEventAt) + ". Latest feature event: " + date(data.summary.latestFeatureEventAt) + ".";
    document.getElementById("stats-generated").textContent =
      "Response generated: " + date(data.generatedAt) + ". Cached for up to ten minutes; generation time is not the latest event time.";
    document.getElementById("stats-summary").hidden = false;
    document.getElementById("stats").hidden = false;
  } catch {
    status.textContent = "Aggregates are not available right now.";
  }
})();
</script>
</body>
</html>`;
}

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
h1 { font-size: 1.75rem; margin: 0 0 .35rem; letter-spacing: -0.01em; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
p, li { color: var(--fg); }
.lede { color: var(--muted); margin: 0 0 2rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; background: color-mix(in oklab, var(--fg) 8%, transparent); padding: .1em .35em; border-radius: 4px; }
pre { background: color-mix(in oklab, var(--fg) 6%, transparent); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
a { color: var(--accent); }
.never li { margin: .2rem 0; }
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .9rem; }
#stats-body td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.stats-grid { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.muted { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>OpenClaw telemetry</h1>
<p class="lede">This service answers the daily update check that OpenClaw installs make, and records anonymous aggregates from it. Everything it does is in <a href="https://github.com/openclaw/telemetry">this repository</a>.</p>

<h2>What an install sends</h2>
<p>Once every 24 hours an install asks this service for the latest OpenClaw version. That request carries a User-Agent:</p>
<pre><code>openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)</code></pre>
<p>If — and only if — the operator answered <em>yes</em> to “Help make OpenClaw better?” during setup, the same request carries a small body of feature facts:</p>
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
<p>That question defaults to <strong>no</strong>, and installs that were never asked interactively — Docker, CI, scripted setups — never send it.</p>

<h2>What we exclude from Analytics Engine</h2>
<ul class="never">
<li>Message content, prompts, model output, file contents, or file paths</li>
<li>Credentials, tokens, or secret references</li>
<li>IP addresses, hostnames, usernames, or account identifiers</li>
<li>Any install ID or device ID</li>
</ul>
<p>The Worker reads the client IP transiently for Cloudflare's rate limiter, but does not write it to Analytics Engine. Worker observability, logs, and invocation logs are disabled in the deployment configuration.</p>
<p>Cloudflare handles TLS and network requests and sees client IP addresses. Its separate infrastructure-level processing is not described or controlled by these Worker logging settings.</p>

<h2>How to turn it off</h2>
<table>
<tr><th>Command or setting</th><th>Effect</th></tr>
<tr><td><code>openclaw telemetry off</code></td><td>Stops the feature-stats body. Update checks continue.</td></tr>
<tr><td><code>DO_NOT_TRACK=1</code></td><td>Same, enforced from the environment.</td></tr>
<tr><td><code>update.checkOnStart: false</code></td><td>Stops all of it. No update check, no telemetry, nothing leaves the machine.</td></tr>
</table>
<p>Run <code>openclaw telemetry show</code> to print the exact request your install would make right now.</p>

<h2>What we learn</h2>
<p class="muted" id="stats-status">Loading aggregates…</p>
<div class="stats-grid" id="stats" hidden>
  <div><h3>Versions</h3><table><tbody id="versions"></tbody></table></div>
  <div><h3>Platforms</h3><table><tbody id="platforms"></tbody></table></div>
  <div><h3>Channels</h3><table><tbody id="channels"></tbody></table></div>
  <div><h3>Providers</h3><table><tbody id="providers"></tbody></table></div>
  <div><h3>Plugins</h3><table><tbody id="plugins"></tbody></table></div>
</div>

<footer>
Run by the OpenClaw Foundation. Source: <a href="https://github.com/openclaw/telemetry">github.com/openclaw/telemetry</a> ·
Docs: <a href="https://docs.openclaw.ai/gateway/telemetry">docs.openclaw.ai/gateway/telemetry</a>
</footer>
</main>
<script>
(async () => {
  const status = document.getElementById("stats-status");
  try {
    const response = await fetch("/api/stats");
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    const fill = (id, rows) => {
      const tbody = document.getElementById(id);
      tbody.innerHTML = "";
      for (const [label, count] of rows.slice(0, 10)) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = label;
        const value = document.createElement("td");
        value.textContent = count.toLocaleString();
        tr.append(name, value);
        tbody.append(tr);
      }
    };
    fill("versions", data.versions.map((row) => [row.version, row.pings]));
    fill("platforms", data.platforms.map((row) => [row.platform, row.pings]));
    fill("channels", data.channels.map((row) => [row.channel, row.installs]));
    fill("providers", data.providerFamilies.map((row) => [row.provider, row.installs]));
    fill("plugins", data.plugins.map((row) => [row.plugin, row.installs]));
    status.textContent = "Last " + data.windowDays + " days, updated " + new Date(data.generatedAt).toUTCString() + ".";
    document.getElementById("stats").hidden = false;
  } catch {
    status.textContent = "Aggregates are not available right now.";
  }
})();
</script>
</body>
</html>`;
}

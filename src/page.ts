/** Explains collection and opt-out controls without exposing usage aggregates. */
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
</style>
</head>
<body>
<main>
<h1>OpenClaw telemetry</h1>
<p class="lede">This service answers the daily update check that OpenClaw installs make. Everything it does is in <a href="https://github.com/openclaw/telemetry">this repository</a>.</p>

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
<p>Cloudflare provides approximate location: country, region code, city, and timezone. We store no raw IP addresses or precise coordinates in analytics.</p>
<p>Recorded update checks include these fields even when anonymous feature statistics are off or <code>DO_NOT_TRACK</code> is set. Missing or invalid fields stay empty. Records are retained for three months.</p>

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
<tr><td><code>openclaw telemetry off</code></td><td>Stops anonymous feature statistics. Update checks continue.</td></tr>
<tr><td><code>DO_NOT_TRACK=1</code></td><td>Same, enforced from the environment.</td></tr>
<tr><td><code>update.checkOnStart: false</code></td><td>Stops both tiers of automatic update requests. Explicit updates and other configured services are separate.</td></tr>
</table>
<p><code>OPENCLAW_NO_AUTO_UPDATE=1</code> also prevents automatic update requests. A truthy <code>CI</code> suppresses both tiers unless a replacement <code>OPENCLAW_TELEMETRY_ENDPOINT</code> is explicitly configured.</p>
<p><code>openclaw telemetry show</code> displays policy and a CLI-built payload preview, not the exact next Gateway payload or server-derived location information. Registry state and collection time can differ. If policy disables requests, it shows <code>Request: none</code>. Disabling requests does not erase previously recorded rows.</p>

<footer>
Run by the OpenClaw Foundation. Source: <a href="https://github.com/openclaw/telemetry">github.com/openclaw/telemetry</a> ·
Docs: <a href="https://docs.openclaw.ai/gateway/telemetry">docs.openclaw.ai/gateway/telemetry</a>
</footer>
</main>
</body>
</html>`;
}

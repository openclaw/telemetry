# OpenClaw telemetry

The Cloudflare Worker behind [telemetry.openclaw.ai](https://telemetry.openclaw.ai). It answers the
daily update check that OpenClaw installs make, and records anonymous aggregates from those requests.

This repository is public because that is the whole point: you should not have to take our word for
what the server keeps. It is about 300 lines, and [`src/payload.ts`](src/payload.ts) is the only
place where anything a client sends becomes something we store.

## What it does

| Route | Purpose |
| --- | --- |
| `GET \| POST /api/latest-version` | Returns `{ version, note? }`. `version` is the latest published OpenClaw release (looked up from the npm registry and cached at the edge for 5 minutes). `note` is an optional short message shown in the operator's terminal, used only when a release is worth acting on immediately. |
| `GET /api/stats` | Public aggregates over the last 7 days. |
| `GET /` | Human-readable page: what is collected, how to turn it off, and the current aggregates. |

## What an install sends

Every OpenClaw install that has update checks enabled asks this service for the latest version at
most once every 24 hours. That request carries a User-Agent and nothing else:

```
openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)
```

If the operator answered **yes** to "Help make OpenClaw better?" during setup — a question that
defaults to **no** — the same request carries a small JSON body:

```json
{
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
}
```

Installs that were never asked interactively — Docker, CI, scripted setups — never send the body.
The server limits feature-statistics bodies to 16 KiB while reading the upload. Oversized or
malformed bodies are discarded, and the request still receives its version answer.

## What is stored

One Analytics Engine row per request, with these columns and no others:

| Column | Value |
| --- | --- |
| `index1`, `blob1` | OpenClaw version |
| `blob2` | Platform (`darwin`, `linux`, `win32`) |
| `blob3` | Architecture (`arm64`, `x64`) |
| `blob4` | Runtime (`node/v26.0.1`, `bun/1.2.0`) |
| `blob5` | Surface (`gateway`, `cli`) |
| `blob6` | Opted-in channel ids, comma-joined |
| `blob7` | Opted-in provider families, comma-joined |
| `blob8` | Opted-in plugin ids, comma-joined |
| `double1` | `1` if the request included feature stats, else `0` |
| `double2` | Total enabled plugin count, including plugins not named above |
| `double3` | Sessions in the last 24 hours |

Unknown keys in a request body are dropped rather than stored, so a future client cannot silently
widen what this service keeps. Values are length-bounded and character-filtered before they are
written.

Only **publicly known** plugin, channel, and provider ids are ever named. The client reports names
only for plugins bundled with OpenClaw or published in its official catalog, and this server
independently re-checks every name against those same published catalogs. Privately developed
plugins are counted in `double2` but never named, because a private plugin id would identify the
organization running it.

## Abuse resistance

This endpoint is unauthenticated, and no client-side identifier would change that — an attacker who
can forge a million pings can forge a million UUIDs just as cheaply. The defenses are therefore at
the edge and in validation:

- **Per-IP rate limiting** on what gets *recorded*. A real install reports once a day, so the limit
  only bites on floods. Over-limit callers still receive their version answer; they simply stop
  counting, so a busy NAT never loses update checks. The IP is used for the decision and never
  stored.
- **Vocabulary allowlisting.** Every reported name is checked against the published OpenClaw
  catalogs, and versions must match the real release format. Invented values become `unknown`
  rather than appearing on the public page. If the catalogs cannot be fetched, names are dropped
  and only counts are recorded — this fails closed rather than publishing unverified text.
- **Plausibility.** Raw rows are retained, so a skew attempt appears as a discontinuity in a
  dimension and can be discounted after the fact.

An attacker willing to distribute traffic can still inflate counts for things that genuinely exist.
That is inherent to unauthenticated census data, and acceptable: these numbers inform which features
get attention, not billing or security decisions.

## What is never stored

- Message content, prompts, model output, file contents, or file paths
- Credentials, tokens, or secret references
- IP addresses, hostnames, usernames, or account identifiers
- Any install ID or device ID

There is deliberately no identifier of any kind, which means **daily pings are unlinkable**: we
cannot tell whether two reports came from the same machine, and therefore cannot build retention
curves or per-install histories. That is a real analytical cost, accepted on purpose.

Cloudflare terminates the TLS connection and therefore sees client IPs, as any host would. This
Worker never reads, forwards, or records them, and request logging is not enabled on it.

## Turning it off

| Command or setting | Effect |
| --- | --- |
| `openclaw telemetry off` | Stops the feature-stats body. Update checks continue. |
| `DO_NOT_TRACK=1` | Same, enforced from the environment. |
| `update.checkOnStart: false` | Stops everything: no update check, no telemetry, no requests. |

`openclaw telemetry show` prints the exact request an install would make right now. Client-side
documentation lives at [docs.openclaw.ai/gateway/telemetry](https://docs.openclaw.ai/gateway/telemetry).

## Development

```bash
npm ci
npm run check     # typecheck + tests
npm run dev       # local worker at http://localhost:8787
npm run deploy    # requires Cloudflare credentials for the OpenClaw account
```

Pull requests run the typecheck, tests, and a Wrangler dry-run build using the committed lockfile.
Deploys run from GitHub Actions on pushes to `main` (see
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)), using the `CLOUDFLARE_API_TOKEN`
repository secret.

`/api/stats` additionally needs two Worker secrets — `ACCOUNT_ID` and a read-only
`ANALYTICS_READ_TOKEN` for the Analytics Engine SQL API. Without them the aggregates endpoint
returns `503` and everything else keeps working.

## License

MIT © OpenClaw Foundation

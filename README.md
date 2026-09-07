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
independently checks every name against a checked-in vocabulary generated from immutable public
packaging metadata, provider declarations, and official catalogs. Public vocabulary history is
retained when names disappear from current catalogs. Privately developed
plugins are counted in `double2` but never named, because a private plugin id would identify the
organization running it.

## Abuse resistance

This endpoint is unauthenticated, and no client-side identifier would change that — an attacker who
can forge a million pings can forge a million UUIDs just as cheaply. The defenses are therefore at
the edge and in validation:

- **Per-IP rate limiting** on what gets *recorded*. A real install reports once a day, so the limit
  only bites on floods. Over-limit callers still receive their version answer; they simply stop
  counting, so a busy NAT never loses update checks. The Worker reads the IP transiently for
  this decision and does not write it to Analytics Engine.
- **Vocabulary allowlisting.** Every reported name is checked against the retained public
  vocabulary. Accepted names are lowercased, deduplicated, and sorted; unknown names are dropped.
  Versions must match the release format or become `unknown`. Runtime catalog changes and
  network outages cannot widen the vocabulary or erase its history.
- **Public stats caching.** Aggregate responses are cached for ten minutes. Cache misses have a
  separate per-IP limit of 20 requests per minute using the same binding; they do not consume
  recording capacity, and cache hits consume neither counter. Denied misses return `429`
  without querying Analytics Engine. Cache failures do not prevent successful SQL responses.
- **Plausibility.** Raw rows are retained, so a skew attempt appears as a discontinuity in a
  dimension and can be discounted after the fact.

An attacker willing to distribute traffic can still inflate counts for things that genuinely exist.
That is inherent to unauthenticated census data, and acceptable: these numbers inform which features
get attention, not billing or security decisions.

## What is excluded from Analytics Engine

- Message content, prompts, model output, file contents, or file paths
- Credentials, tokens, or secret references
- IP addresses, hostnames, usernames, or account identifiers
- Any install ID or device ID

These Analytics Engine rows contain no install or device identifier, so the service does not
maintain per-install histories or retention curves.

Cloudflare handles TLS and network requests and sees client IP addresses. The Worker reads
`cf-connecting-ip` transiently and passes it to Cloudflare's rate-limiting binding; it does not
write that IP to Analytics Engine. Worker observability, logs, and invocation logs are explicitly
disabled in [`wrangler.jsonc`](wrangler.jsonc). These settings do not describe or control
Cloudflare's separate infrastructure-level processing.

## Turning it off

| Command or setting | Effect |
| --- | --- |
| `openclaw telemetry off` | Stops the feature-stats body. Update checks continue. |
| `DO_NOT_TRACK=1` | Same, enforced from the environment. |
| `update.checkOnStart: false` | Stops everything: no update check, no telemetry, no requests. |

`openclaw telemetry show` prints the exact request an install would make right now. Client-side
documentation lives at [docs.openclaw.ai/gateway/telemetry](https://docs.openclaw.ai/gateway/telemetry).

## Development

Use Node.js 24 (the version used in CI) and npm.

```bash
npm ci
npm run check     # vocabulary consistency + typecheck + tests
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

### Updating public names

[`data/public-vocabulary.json`](data/public-vocabulary.json) records immutable OpenClaw revisions,
retained snapshots, and the public source of legacy aliases (`cli`, `claude`, `gemini`).
[`src/public-vocabulary.ts`](src/public-vocabulary.ts) exports the complete retained `PUBLIC_NAMES`
for ingestion and stats consumers. Neither file contains names learned from telemetry requests.

Before supporting a new OpenClaw release or catalog revision, use Node.js 24 and a trusted local
OpenClaw Git repository containing the candidate commit and its history:

```bash
npm run vocabulary:check -- --source <openclaw-repository> --revision <full-public-commit-sha>
npm run vocabulary:update -- --source <openclaw-repository> --revision <full-public-commit-sha>
npm run vocabulary:check -- --source <openclaw-repository>
npm run check
```

The first command fails when the candidate is not recorded. Review the generated diff, commit both
metadata and generated source, and deploy through the normal PR workflow. Do not edit the generated
names by hand. Plain `npm run vocabulary:check` runs offline in CI and detects metadata/output drift;
`--source` also reproduces every snapshot from immutable Git objects. It never changes the source
checkout, runs an install, or uses its uncommitted files.

The generator calls upstream `listBundledPluginPackArtifacts` with the default packaging environment,
then reads the selected plugin manifests, public provider overlays, and three official catalogs.
Packaging exclusions remain owned by OpenClaw. A changed upstream metadata contract fails generation
and needs review rather than silently falling back to a partial vocabulary.

The initial snapshot includes all catalog revisions on the public main history since commit
`844e781ca40952c98ee997b016e3cc5d2f12f9f3`, before name allowlisting began in August 2026.
Refreshes append snapshots; never remove older ones during routine updates. This retains removed or
renamed public entries for the entire seven-day stats window, including names admitted by the older
moving-catalog implementation. New public names remain rejected until reviewed metadata is deployed.
The internal allowlist cache namespace changes automatically with vocabulary content.

Historical rows may contain mixed-case names or case-distinct duplicates from older validation.
This repair canonicalizes new rows only; stats consumers must validate historical coverage and handle
those rows explicitly rather than assume the stored window is already canonical.

## License

MIT © OpenClaw Foundation

# OpenClaw telemetry

The Cloudflare Worker behind [telemetry.openclaw.ai](https://telemetry.openclaw.ai). It answers the
daily update check that OpenClaw installs make, and records anonymous aggregates from those requests.

This repository is public because that is the whole point: you should not have to take our word for
what the server keeps. [`src/payload.ts`](src/payload.ts) defines the Analytics Engine row
written from a validated request.

## What it does

| Route | Purpose |
| --- | --- |
| `GET \| POST /api/latest-version` | Returns `{ version, note? }`. `version` is the latest published OpenClaw release (looked up from the npm registry and cached at the edge for 5 minutes). `note` is an optional short message shown in the operator's terminal, used only when a release is worth acting on immediately. |
| `GET /api/stats` | Public aggregates over the last 7 days. |
| `GET /` | Human-readable page: what is collected, how to turn it off, and the current aggregates. |

## What an install sends

With automatic update checks enabled, OpenClaw reuses a successful version check for 24 hours.
Failed checks do not count as successful daily checks. The update-only request carries a User-Agent:

```
openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)
```

The five-minute version cache is optional: unreadable or invalid entries are treated as misses,
and cache write failures do not discard a valid npm response. Both sources must provide a nonempty
version string, which is trimmed before returning it. If npm is unavailable and there is no valid
cached version, the endpoint returns `503 version_unavailable`.

Feature statistics are **off by default**. Operators can enable them during interactive setup,
with `openclaw telemetry on`, or with `telemetry.enabled: true`. When enabled, the same request
carries a small JSON body:

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

Interactive setup defaults to **No thanks**; guided Quick Start skips that prompt. Scripted installs
do not opt in automatically. The enabled setting, not a recorded prompt response, controls inclusion.
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
| `blob6` | Configured, not explicitly disabled public channel IDs, comma-joined |
| `blob7` | Public provider IDs from configuration, auth profiles, and model references, comma-joined |
| `blob8` | Public plugin IDs from enabled inventory, comma-joined |
| `double1` | `1` if the request included feature stats, else `0` |
| `double2` | Total enabled plugin count, including plugins not named above |
| `double3` | Retained session-creation events timestamped within the preceding 24 hours |

The fields describe configuration and inventory, not plugin invocations, provider requests, or
channel activity. With an active plugin registry, inventory includes enabled, loaded plugins whose
code was imported and loaded bundle-format plugins; without it, collection uses configured manifest
enablement. The session count depends on creation events still retained in a bounded local store.
Missing or unreadable state produces zero; this is not active sessions, messages, or all sessions
that existed that day.

Unknown keys in a request body are dropped rather than stored, so a future client cannot silently
widen what this service keeps. User-Agents longer than 512 characters become an unknown identity
before parsing. Identity fields remain length-bounded and character-filtered. Feature IDs must be
complete identifiers of at most 64 characters; malformed or overlength IDs are dropped, never
repaired or truncated into another name.

Only **publicly known** plugin, channel, and provider ids are ever named. The client reports names
only for plugins bundled with OpenClaw, trusted official installs, or entries in its official catalog, and this server
independently checks every name against a checked-in vocabulary generated from immutable public
packaging metadata, provider declarations, and official catalogs. Public vocabulary history is
retained when names disappear from current catalogs. Privately developed
plugins can contribute to `double2` but are not named. Filtering and deduplication also affect named
counts, so the difference between total inventory and named plugins is not a reliable private-plugin count.

## Public aggregates

`GET /api/stats` reports weighted estimates over one fixed seven-day UTC interval:
`windowStart` is inclusive and `windowEnd` is exclusive. All statements use those same bounds.
`generatedAt` is the response-generation clock, not evidence that data arrived at that time.

- `summary.totalPings` and `summary.featureReports` come from their own summary query, not the
  top version/platform rows or feature marginals. `latestEventAt` and `latestFeatureEventAt`
  are that query's latest recorded event timestamps.
- `versions[].pings` and `platforms[].pings` retain their top-25 API semantics.
- `channels`, `providerFamilies`, and `plugins` retain their label fields and legacy `installs`
  counts. Each entry adds `reports`, equal to `installs`. Both mean weighted reports, not
  unique installations, users, or feature invocations.
- `featureMetadata` provides each category's own `featureReports` denominator and
  `latestFeatureEventAt`. Query-time sampling can produce different totals and watermarks
  between categories and the summary. These are independent estimates, not one database snapshot.
  Percentages must use only the matching category's denominator.

Each category runs one complete statement over the entire retained public vocabulary. A same-query
weighted token-length checksum verifies that no unknown, malformed, repeated, or mixed-case tokens
were silently omitted. Queries are limited to 9,500 UTF-8 bytes; vocabulary growth beyond this bound
fails tests and runtime requests rather than truncating names or splitting a category across samples.
Missing or malformed results, failed required queries, or incomplete coverage return `503`, not empty
success. Genuine empty aggregates have zero counts and null event watermarks.

Responses use a ten-minute server cache, retaining `Age` on hits. The page bypasses its browser cache
to avoid older response contracts but still reuses the Worker's server cache. It displays top-ten
tables of reports, category-local bases and watermarks, and the separate response-generation time.
Accepting additional public names increases coverage; it does not by itself establish increased adoption
or backfill reports whose names were previously rejected.

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
  Cache hits retain their age and the ten-minute freshness limit; older entries are treated
  as misses even if the cache retains them longer.
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
| `update.checkOnStart: false` | Stops both tiers of automatic update requests. Explicit update commands and other configured services are separate. |

`OPENCLAW_NO_AUTO_UPDATE=1` also prevents automatic update requests. A truthy `CI` suppresses both
tiers unless a replacement `OPENCLAW_TELEMETRY_ENDPOINT` is explicitly configured.

`openclaw telemetry show` displays policy and a CLI-built payload preview, not the exact next Gateway
payload: registry state, configuration, and collection time can differ. When policy suppresses requests,
it shows `Request: none` (`request: null` in JSON). Client-side
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
The vocabulary is compiled into the Worker. Loading it requires neither upstream requests nor
Cache API access, so old allowlist cache entries cannot be reused and cache outages cannot interrupt
name validation. Each caller receives a fresh set.

Historical rows may contain mixed-case names or case-distinct duplicates from older validation.
This repair canonicalizes new rows only; stats consumers must validate historical coverage and handle
those rows explicitly rather than assume the stored window is already canonical.

## License

MIT © OpenClaw Foundation

# OpenClaw telemetry

The Cloudflare Worker behind [telemetry.openclaw.ai](https://telemetry.openclaw.ai). It answers the
daily update check that OpenClaw installs make and provides anonymous usage aggregates.

This repository is public because that is the whole point: you should not have to take our word for
what the server keeps. [`src/analytics.ts`](src/analytics.ts) defines the Analytics Engine row
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

Anonymous feature statistics are **off by default**. Operators can enable them during interactive setup,
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
The server limits bodies containing anonymous feature statistics to 16 KiB while reading
the upload. Oversized or malformed bodies are discarded, and the request still receives its
version answer.

<a id="cloudflare-derived-request-geography"></a>

### Approximate location

Cloudflare provides approximate location: country, region code, city, and timezone.
We store no raw IP addresses or precise coordinates in analytics.

Recorded update checks include these fields even when anonymous feature statistics are off
or `DO_NOT_TRACK` is set. No additional client payload or prompt is needed.

The receiver uses only those four fields from
[`request.cf`](https://developers.cloudflare.com/workers/runtime-apis/request/), not from
client-supplied headers or bodies. [`src/geography.ts`](src/geography.ts) bounds and validates
each field; missing or invalid values are left empty without discarding valid fields.

## What is stored

Each recorded request contributes one Analytics Engine data point with these columns and no others:

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
| `blob9` | Approximate country |
| `blob10` | Country-scoped region code |
| `blob11` | Approximate city |
| `blob12` | Named timezone |
| `double1` | `1` if the request included anonymous feature statistics, else `0` |
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

The geography fields are co-located with the existing identity and feature columns in the same
Analytics Engine row and dataset, not stored separately. Analytics Engine retains data for
**three months** under its [published limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/).
The twelve blobs remain within the limits of twenty blobs, twenty doubles, one index,
and 16 KB of blob data per point. Existing column positions and the version sampling key are
unchanged. Public stats and homepage aggregates do not expose geography fields or breakdowns.

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
- `versions[].pings` and `platforms[].pings` retain their top-25 API semantics and ordering.
  Each row adds `featureReports` from the same SQL statement as its `pings`. These are
  truncated rankings, not complete version or platform distributions.
- `architectures` groups the already-stored **process architecture** into `arm64`, `x64`,
  `arm`, `other`, and `unknown` (including empty values), with `pings` and `featureReports`
  from that group's query. It does not identify physical device hardware. The query requests
  at most six rows so an unexpected extra bucket fails validation rather than being hidden.
- A cohort's feature share is its own `featureReports / pings`, unavailable when `pings` is
  zero. It is not an opt-in rate. Do not divide a row by the summary or another query's total:
  queries may use different samples. These fields add no new client collection.
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

The endpoint runs seven statements sharing the same UTC bounds, each within the 9,500-byte budget.
Duplicate groups, invalid architecture buckets, unsafe counts, or a row's feature count exceeding
its report count fail closed with `503`.

Responses use a ten-minute server cache, retaining `Age` on hits. The page bypasses its browser cache
to avoid older response contracts but still reuses the Worker's server cache. It displays top-ten
tables of reports, category-local bases and watermarks, and the separate response-generation time.
The architecture table shows every returned bucket. Cohort tables show feature counts and row-local
percentages; old cached payloads missing these additive fields display unavailable, not zero.
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
- Raw numeric UTC offsets, coordinates, postal codes, or physical-device hardware details

These Analytics Engine rows contain no direct user, account, install, or device identifier.
Reports are not unique installations or users, and the service does not maintain per-install
histories or retention curves.

Cloudflare processes connection IP addresses, and the Worker uses them transiently for rate
limiting without storing them in Analytics Engine. Worker observability, logs, and invocation
logs are disabled in [`wrangler.jsonc`](wrangler.jsonc). Cloudflare's separate infrastructure
processing is outside those settings.

## Turning it off

| Command or setting | Effect |
| --- | --- |
| `openclaw telemetry off` | Stops anonymous feature statistics. Update checks continue. |
| `DO_NOT_TRACK=1` | Same, enforced from the environment. |
| `update.checkOnStart: false` | Stops both tiers of automatic update requests. Explicit update commands and other configured services are separate. |

`OPENCLAW_NO_AUTO_UPDATE=1` also prevents automatic update requests. A truthy `CI` suppresses both
tiers unless a replacement `OPENCLAW_TELEMETRY_ENDPOINT` is explicitly configured.

Disabling requests stops future automatic reports; it does not erase previously recorded rows.
The same three-month Analytics Engine retention applies. The receiver does not run backups;
the optional operator workflow below has separate source-day expiry.

`openclaw telemetry show` displays policy and a CLI-built payload preview, not the exact next Gateway
payload: registry state, configuration, and collection time can differ. It cannot preview
server-derived location information. When policy suppresses requests,
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

## Offline historical export

`npm run telemetry:history` exports **one archived hourly Analytics Engine query** to
`daily.json`, `daily.csv`, and `manifest.json`. It does not contact Cloudflare or npm, need
credentials, change the Worker, restore raw events, merge overlapping captures, or create a
backup job. The optional daily R2 workflow is documented below. Existing `npm:quality` tooling
is unchanged.

The input directory must contain `capture-plan.json` and a selected query directory with
`query.sql`, `response.json`, `receipt.json`, and `attempt.json`. Select the plan and receipt
using SHA-256 digests from your trusted capture record:

```bash
npm run telemetry:history -- \
  --archive /private/archive/ae \
  --query q2 \
  --plan-sha256 "$PLAN_SHA256" \
  --receipt-sha256 "$RECEIPT_SHA256" \
  --output /private/exports/hourly-history
```

The output parent must already exist. Output must be outside the archive, with no symlinks or
path traversal. New directories are mode `0700`; files are `0600`. A rerun returns `unchanged`
only after verifying every existing artifact byte-for-byte. Conflicting, incomplete, or
non-private destinations fail without overwrite. Source files are never changed.

The v1 input contract is intentionally narrow:

- The selected plan entry contains `id`, `sql`, `sqlSha256`, `structuralMaxRows`, and `sqlLimit`.
  The SQL must match the hourly statement in
  [`scripts/lib/telemetry-history.mjs`](scripts/lib/telemetry-history.mjs), including its
  aliases, ordering, table, feature predicate, exclusive end, and `FORMAT JSON`. Only UTC
  bounds and the limit vary. Windows are bounded to 93 days at whole-second precision;
  `structuralMaxRows` is `ceil(window hours) + 1`, and `sqlLimit` is one greater.
- The plan supplies explicit UTC `windowStartInclusive`, `windowEndExclusive`, and
  `captureStartedAt`. Bounds may use `Z` or `+00:00`. SQL and result `DateTime` strings are UTC,
  never host-local. Capture, attempt, and receipt timestamps accept up to six fractional
  digits, are preserved verbatim in provenance, and must follow exact microsecond order.
  Query bounds remain whole-second instants.
- The receipt must certify a complete HTTP 200, unredacted, untruncated response without a
  reached limit. Raw response bytes must match its `wireBytesRead` and `wireSha256`; row counts
  and ordered column metadata must agree between receipt and response.
- The submitted SQL digest binds the **exact plan string**. The saved `query.sql` may equal
  that string or add **exactly one LF**. Both byte representations are recorded separately;
  arbitrary whitespace is not normalized.
- Rows contain `bucket`, `weightedReports`, `queryRows`, `featureReports`, `featureQueryRows`,
  `minSampleInterval`, `maxSampleInterval`, `latestEventAt`, and `latestFeatureAt`. Counts must
  be UInt64 decimal strings; sample intervals are positive UInt32 numbers. Duplicate,
  unordered, out-of-window, inconsistent, or malformed rows fail closed. Zero-feature
  watermarks use the query's epoch sentinel and are exported as null.

Input reads are bounded to 1 MiB for the plan, 64 KiB for the receipt, 16 KiB for the attempt,
9,500 bytes for SQL, and 4 MiB for the response, with at most 2,233 hourly rows. The manifest
records exact input/output hashes, the submitted/saved SQL relationship, event watermarks,
sampling ranges, coverage, and comparison totals. Pins establish operator-selected evidence
and internal consistency, not independent server authentication. Attempt metadata is hashed
in the output but not externally pinned. Arbitrary capture headers and paths are not copied.

### Reading the daily output

`weightedReports` and `featureReports` are sampled report estimates. `queryRows` and
`featureQueryRows` are query row counts, not a stored-row census. Feature counts use the same
query's sample; no cross-query percentage or opt-in rate is calculated. None of these values
counts unique installations or users. Counts and sums remain exact decimal strings in JSON;
CSV readers must preserve count columns as text rather than floating-point numbers.

Daily `coverage` is `partial_edge`, `missing_hours`, or `complete_closed`. `missingHours`
records absent hourly buckets even on partial edge days; `partialHours` records boundary
hours not fully queried. Observed partial sums are retained, but a day with no observed
hours has null counts, not zeros. Dates beyond the capture window are not generated.
Only `complete_closed` days are `comparisonEligible` and contribute to
`summary.completeClosedTotals`. This certifies UTC calendar coverage, not complete events.
Geography is unknown in this export, including rows collected before geography was recorded.

## Aggregate capture pilot

`npm run telemetry:capture` plans or captures **one explicit closed UTC day** of hourly
Analytics Engine report aggregates and a **separate** HTTP country query. It is an
operator-invoked pilot, not a scheduled or full backup. No version/plugin distributions,
finer geography, raw events, replay, uploads, storage bindings, or retention policy are added.
The existing historical exporter is unchanged.

The default is a dry run. It reads no credentials, makes no network requests, and creates
no files:

```bash
npm run telemetry:capture -- --day 2025-02-03
```

Choose and approve a private storage location and its access/retention policy before
performing an actual capture. There is no default output location. The output parent must
already exist; explicitly resolve symlinked parents to their real paths. Execution needs
separate operator-provided `TELEMETRY_AE_READ_TOKEN` and `TELEMETRY_HTTP_READ_TOKEN`
environment variables, plus explicit noncredential account and zone IDs:

```bash
npm run telemetry:capture -- --execute --day "$UTC_DAY" \
  --account-id "$ACCOUNT_ID" --zone-id "$ZONE_ID" \
  --output "$(realpath "$APPROVED_PARENT")/day-$UTC_DAY"
```

Provide an account-scoped Analytics Engine SQL read token and a separate zone-scoped
HTTP analytics read token. The tool never discovers credentials, opens an auth store,
refreshes OAuth, or provisions permissions. It posts only to the fixed Cloudflare
API endpoints, rejects redirects, and never retries automatically.

Current HTTP dataset settings are requested first. The dataset must be enabled and
advertise all required metric, dimension and filter fields, a full-day duration, a
10,000-row page, and sufficient field capacity. The requested day must fit the returned
`notOlderThan` lookback. Lookback is checked again immediately before the HTTP country
request, after AE finishes; expiry stops the request and leaves an incomplete bundle.
Each request has a 45-second deadline. Responses are bounded to 256 KiB for settings,
4 MiB for AE and 2 MiB for HTTP countries. Truncated/encoded bodies, GraphQL errors,
unsafe counts, duplicate groups, and reached row limits fail closed.
Unsupported/error payloads are rejected before their bodies or complete receipts enter
the bundle; failure diagnostics omit upstream text.

The AE statement is the historical exporter's audited hourly query, with a structural
maximum of 25 rows and SQL limit 26. It preserves the distinct submitted SQL and saved
SQL-plus-LF hashes, raw response bytes, plan, attempt, receipt, and their digest pins.
`count()` remains a query row count, not a stored-row census.

The HTTP query uses `httpRequestsAdaptiveGroups` with the exact host
`telemetry.openclaw.ai`, path `/api/latest-version`, `requestSource: eyeball`, and
half-open UTC day. It requests only country, `count`, and average `sampleInterval`.
All methods, statuses and bots within that scope remain included. HTTP `count` is
already estimated; the sampling interval is diagnostic, **not another multiplier**.
Country counts must be nonnegative safe JSON integers and are exported and summed as
exact decimal strings. Special, empty and null country labels remain distinct.
Absent countries and empty results are unknown, not zero.

### Bundle and offline verification

The private bundle contains `bundle-plan.json`, the `ae/` capture, unchanged exporter
outputs in `ae-daily/`, HTTP settings/query responses and receipts in `http/`, and
normalized `http/country.json`. Directories are `0700` and files `0600`. Both sources'
local prerequisites are validated before exclusively claiming the output directory,
which happens before the first request. A concurrent loser makes no request.

`manifest.json` is written last, only after both captures validate and offline
regeneration matches all derived outputs byte-for-byte. Completion means **query/wire
completeness**, not complete events or census coverage. Missing AE hours remain unknown
through the unchanged exporter; HTTP requests are never joined to AE reports or used
to infer geography for pre-geography AE rows.

```bash
npm run telemetry:capture -- --verify --day "$UTC_DAY" \
  --account-id "$ACCOUNT_ID" --zone-id "$ZONE_ID" \
  --output "$(realpath "$APPROVED_PARENT")/day-$UTC_DAY"
```

Verification needs no credentials or network. It binds the requested day, source
identities, exact queries, raw bytes, receipts and hashes, then reruns the unchanged
historical exporter in a private owned temporary directory outside the bundle.
All three regenerated AE files must match; only the verifier's scratch is removed.
Hashes establish internally consistent operator-selected evidence, not independent
server authentication.

An execute rerun checks an existing bundle **before** reading credentials or fetching
metadata, returning `unchanged` only after the same offline verification. It still works
after upstream retention expires. Partial, conflicting, extra, symlinked, hardlinked or
non-private files fail without overwrite, repair, resume or network access. Failed
captures retain their incomplete evidence; absence of a valid completion manifest
means the bundle is not complete. Review failures and choose a new explicit destination
only after resolving the cause.

This pilot changes neither Analytics Engine retention nor the receiver's collection
or runtime behavior.

## Daily R2 aggregate backups

`telemetry:backup` wraps the same capture and offline verifier. It stores hourly AE
report totals and independently scoped HTTP country estimates, not raw events,
version/plugin distributions, finer geography, or a full-dimensional/lossless backup.
Restoring extracts a verified private bundle; it never replays data into Analytics Engine.

The default is a side-effect-free plan for the seven most recent closed UTC days,
oldest first. The selected days are frozen once per invocation.

```bash
npm run telemetry:backup
npm run telemetry:backup -- backup --execute --config "$PRIVATE_CONFIG" \
  --work-dir "$(realpath "$PRIVATE_PARENT")/backup-run"
```

Execution requires a new private work directory and explicit configuration, either
`--config` pointing to an operator-owned `0600` JSON file or the
`TELEMETRY_BACKUP_CONFIG` environment variable. Resolve symlinked parent paths first.
Configuration has this shape; replace every placeholder with the reviewed target:

```json
{
  "schemaVersion": 1,
  "accountId": "<AE_ACCOUNT_ID>",
  "zoneId": "<HTTP_ZONE_ID>",
  "r2AccountId": "<R2_ACCOUNT_ID>",
  "bucket": "<PRIVATE_BUCKET>",
  "lifecycle": {
    "firstDay": "<FIRST_COVERED_UTC_DAY>",
    "lastDay": "<LAST_COVERED_UTC_DAY>",
    "verifiedAt": "<LIFECYCLE_READBACK_UTC_TIMESTAMP>"
  }
}
```

The lifecycle horizon is an operator attestation of provisioned, read-back rules
for that exact private bucket, not a request to provision them. Writes outside the
inclusive horizon fail. Account/zone IDs must be lowercase 32-character hexadecimal
strings. Dates are `YYYY-MM-DD`; `verifiedAt` is an explicit UTC timestamp with `Z`
or `+00:00` and up to six fractional digits, compared without losing sub-millisecond precision.

Backup execution reads only these explicitly supplied credentials:

- `TELEMETRY_BACKUP_R2_WRITE_ACCESS_KEY_ID` and
  `TELEMETRY_BACKUP_R2_WRITE_SECRET_ACCESS_KEY`: a dedicated, bucket-scoped object
  read/write credential, never an account-wide or lifecycle-admin credential.
- `TELEMETRY_AE_READ_TOKEN` and `TELEMETRY_HTTP_READ_TOKEN`: the separate capture
  read credentials, needed only when a remote day is missing.

There is no ambient AWS credential fallback, token discovery or refresh, admin API,
bucket provisioning, retrying PUT, or credential output. S3 uses the fixed account
endpoint, bounded requests and responses, no redirects, and one SDK attempt.
Automatic optional SDK checksums are disabled for R2 compatibility; whole-object
SHA-256, per-file hashes and offline verification are always required.

### Immutable objects and failures

Each object is `v1/YYYY-MM-DD/aggregate.json`. Its bounded, versioned envelope
contains only the capture bundle's fixed file inventory, byte-preserving base64,
per-file SHA-256, source/storage identity hashes, source day and expiry.

An existing object is downloaded and verified before any new capture. Valid remote
evidence is authoritative even after query retention expires. A conditional
`If-None-Match: *` PUT never replaces it. An ambiguous PUT result or concurrent
winner is reconciled by a bounded read and complete offline verification, not a
second PUT. Wrong days, identities, bytes or hashes fail without overwrite.

Malformed daily evidence or a per-day upstream failure does not starve newer days;
the invocation still exits nonzero if any selected day remains unresolved.
Authentication, bucket and native-retention failures stop further writes.
Public output contains only days, statuses and fixed reason codes, never aggregate
statistics, SDK/upstream error bodies, account IDs or credentials.

Work directories are `0700` and files `0600`. A local `receipt.json` records the
result. Missing or incorrect native expiration on either HEAD or GET stops uploads and writes
`cleanup-required.json` with the exact bucket/object privately. An operator must
inspect that object and arrange its cleanup; the runner does not delete unknown
objects or make quarantine copies. Do not upload work directories as CI artifacts.

### Source-age expiry and restore

Expiry is midnight UTC on the original source day plus **three calendar months**,
clamped to the last day of the target month. It is not 90 days and not three months
since upload. For example, January 31 expires on April 30.

Restore uses only an independently provided, bucket-scoped object **read** credential:
`TELEMETRY_BACKUP_R2_READ_ACCESS_KEY_ID` and
`TELEMETRY_BACKUP_R2_READ_SECRET_ACCESS_KEY`. It does not read writer or AE/HTTP tokens.

```bash
npm run telemetry:backup -- restore --day "$SOURCE_DAY" --config "$PRIVATE_CONFIG" \
  --output "$(realpath "$PRIVATE_PARENT")/restore-run"
```

The output must be new. Restore checks expiry before downloading and immediately
before releasing `bundle/`, after full private extraction and unchanged offline
verification. An expired day cannot be restored through this tool.

Native deletion may lag expiry, typically by up to 24 hours and potentially longer
for rules applied to older objects. The application's cutoff does not promise an
immediate physical purge or deny reads made directly with other valid credentials.

### Provision and renew lifecycle rules

Generate one reviewed native Wrangler/REST plan for seven days back and 365 days
forward from an explicit UTC anchor. This only writes local JSON; it needs no admin
credential and makes no request. Even for a new empty dedicated bucket, first obtain
its actual native lifecycle readback as a private `{"rules": [...]}` file:

```bash
npm run telemetry:backup -- lifecycle-plan --anchor "$UTC_DAY" \
  --previous "$ACTUAL_PRIVATE_LIFECYCLE_READBACK" \
  --output "$(realpath "$PRIVATE_PARENT")/lifecycle-proposed.json"
```

The generator preserves the readback's bucket-wide, enabled seven-day multipart-abort
rule, including its actual ID. It does not invent a replacement default. A default-only
readback produces 373 rules: that preserved rule plus 372 dated object-expiration rules.
Missing, altered or additional unrecognized rules fail closed.

Renew using the existing reviewed native rules, including rules for retained or
expired-but-not-yet-deleted objects:

```bash
npm run telemetry:backup -- lifecycle-plan --anchor "$UTC_DAY" \
  --previous "$EXISTING_PRIVATE_RULES" \
  --output "$(realpath "$PRIVATE_PARENT")/lifecycle-renewal.json"
```

Renewal preserves old daily rules, rejects conflicting/unrecognized rules, and fails
at 1,000 rules rather than silently pruning. Rules may only be removed after an
operator has independently confirmed that their objects are gone. Do not shorten
the horizon by feeding an incomplete readback to the generator.

An authorized operator can apply the reviewed native plan once with existing
Wrangler admin authentication, outside the daily runner:

```bash
npx wrangler r2 bucket lifecycle set "$R2_BUCKET" --file "$REVIEWED_PLAN"
```

Read back the exact bucket's rules and verify native expiration on a real object
before recording or extending the approved horizon. No S3 admin key is needed.

### Daily workflow gate

The daily workflow is disabled unless repository variable
`TELEMETRY_BACKUPS_ENABLED` is exactly `true`. Both its 02:17 UTC schedule and manual
dispatch execute only on `main`. It exposes no artifact uploads or aggregate output.
The capture step receives the configuration and four backup credentials above as
same-named secrets; restore credentials and lifecycle-admin authentication are not
available to it.

Before enabling, independently verify the exact account and bucket, disabled public
`r2.dev` access and custom domains, lifecycle readback/horizon, bucket-scoped writer
and separate reader permissions, real upload/download/offline verification,
duplicate-PUT protection and the exact native HEAD and GET expiration headers. Renew the verified
horizon before it runs out.

An independent alert for a missing verified daily object after 36 hours is also
required before claiming unattended protection. Its recipient and delivery route
must be configured outside this workflow; a scheduled workflow cannot reliably
monitor its own absence. GitHub can disable scheduled workflows after 60 days of
repository inactivity, and scheduled runs can be delayed or dropped.

## License

MIT © OpenClaw Foundation

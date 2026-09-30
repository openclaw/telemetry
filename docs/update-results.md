# Identifier-free update outcomes (schema 2)

This receiver accepts a terminal update outcome on the existing
`POST /api/latest-version` endpoint. It is separate from daily update checks and
schema-1 feature reports. This change does not enable a client, deploy the Worker,
provision a production dataset, or authorize production collection. The companion
client reports outcomes **on by default**, like the existing update ping, governed
by update-request policy rather than optional schema-1 feature statistics.
`update.checkOnStart: false`, `OPENCLAW_NO_AUTO_UPDATE=1`, and Nix mode suppress
outcome reports. A truthy `CI` always suppresses them, including when a replacement
`OPENCLAW_TELEMETRY_ENDPOINT` is explicitly configured. The daily-check custom-endpoint
exception does not apply to outcomes. `DO_NOT_TRACK=1`,
`openclaw telemetry off`, and `telemetry.enabled` control feature statistics, not
default-on update outcomes; feature statistics remain off by default.

The receiver and separate outcome dataset must be deployed and verified **before
releasing the default-on client**. That rollout needs separate authorization;
local tests do not establish production readiness. The default production
template deliberately **omits `UPDATE_RESULTS`**: the existing push-to-main
workflow may deploy receiver code, but must not implicitly activate collection.
A separately authorized rollout must explicitly add the `UPDATE_RESULTS`
binding for `openclaw_update_results`, preserving the existing `TELEMETRY`
binding, and verify retention and delivery before enabling production collection.
No deployment or provisioning is authorized by this PR.

## Capability handshake

An outcome attempt uses **two requests**, first `HEAD`, then (only when supported)
`POST`, to the same full configured `/api/latest-version` URL, including its
query. There is no new endpoint setting or fallback. Both requests use the fixed
`openclaw-update-result/1` User-Agent. Only exact status **204** with header
`OpenClaw-Update-Results: 2` permits the client to POST. Header names are
case-insensitive. Older receivers return 405; a receiver without the outcome
binding returns **503 without the capability header**. Neither gets outcome data.

HEAD has an empty body and `Cache-Control: no-store` for both 204 and 503. It
checks binding presence synchronously; it never reads an upload or geography,
uses the recording limiter, writes analytics (including sample points), or looks
up a version. It is a protocol capability check, **not production readiness or
successful storage proof**. The client shares a three-second timeout across both
requests, disallows redirects, and rechecks update-request opt-outs after the
HEAD await before sending. No retries or delayed queue are added. Daily GET and
opt-in schema-1 feature POST remain single requests and need no handshake.

## Wire contract

Send JSON with fixed User-Agent `openclaw-update-result/1` (not stored). All 18
fields in `test/fixtures/update-result.json` are mandatory; additional keys are
rejected, not ignored. The only numeric field is `schema: 2`; `event` is exactly
`update_result`. Other values must exactly match these case-sensitive labels:

| Field | Accepted values |
| --- | --- |
| outcome | succeeded, failed, rolled-back |
| fromVersion, targetVersion, resultingVersion, runningVersion | public release syntax below, or unknown |
| platform | linux, darwin, win32, freebsd, openbsd, unknown |
| arch | x64, arm64, arm, ia32, unknown |
| installMethod | git-checkout, npm-global, pnpm-global, bun-global, managed-service, unknown |
| channel | stable, beta, dev, extended-stable, unknown |
| duration | under-10s, under-1m, under-5m, under-30m, over-30m, unknown |
| postCheck | passed, failed, unknown |
| failedStage | requested, staging, validating, repairing, activating, restarting, verifying, unknown, none |
| errorCategory | permission, network, timeout, storage, other, none |
| errorCode | EACCES, EPERM, ENOSPC, ETIMEDOUT, ECONNRESET, ECONNREFUSED, ENOTFOUND, unknown, none |
| rollback | not-needed, not-attempted, succeeded, failed, unknown |
| recovery | safe, unsafe, unknown |

Public version syntax is
`/^202[0-9]\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]{0,5})(?:-[1-9][0-9]{0,2})?(?:-beta\.[1-9][0-9]{0,2})?$/`,
matching the entire string (including rejecting trailing line terminators).
The patch component accepts zero or a non-zero-leading integer up to six digits
(0–999999), including extended-stable versions such as `2026.8.33` and
`2026.8.123`. Year, month, revision and beta-suffix restrictions are unchanged.
It excludes build metadata, commit SHAs and private prerelease labels. This is
syntax validation, not a claim that a label was actually published. `succeeded`
requires `failedStage`, `errorCategory` and `errorCode` all to be `none`.

Uploads must be valid UTF-8 and at most **4096 bytes**, including whitespace and
any BOM. The fixed UA selects the 4096-byte streaming cap before JSON decoding,
so malformed, absent or oversized outcome bodies never reach the legacy recorder.
A parsed `schema: 2` or `event: "update_result"` also selects strict validation
without that UA, using the exact byte count from the legacy bounded reader.
Without the fixed UA, undecodable bodies cannot be classified as outcomes and
retain legacy invalid-feature behavior; clients must always send the fixed UA.

Invalid outcomes return `400 {"error":"invalid_update_result"}` with no recording.
A missing outcome binding or synchronous analytics write failure returns
`503 {"error":"update_results_unavailable"}`; there is **no fallback** to the daily
dataset. Neither response echoes input or diagnostics. Accepted requests receive
the existing version response (or its existing `503 version_unavailable`). A
version failure can occur after recording; clients must not infer exactly-once
storage or retry to recover an acknowledgement. The existing per-IP recording
limiter runs exactly once before reading a GET/POST upload: exhausted callers
receive their version answer without reading or validating the body, even if
it never finishes, and without recording. Thus invalid/unavailable outcome
responses above apply only while recording quota is available. IP is only a transient limiter key, never an analytics column.

## Storage and privacy

Binding `UPDATE_RESULTS` writes exclusively to `openclaw_update_results`. The daily
`TELEMETRY` binding and `openclaw_telemetry` columns remain unchanged. Outcome
processing does not read `request.cf`, parse legacy identity, load the feature
vocabulary, or write any daily row. No IDs, raw User-Agent, geography, hostname,
path, command, arbitrary error text, logs or free-form strings are stored.
Worker observability and invocation logs stay disabled. Cloudflare still
processes connection metadata independently of these Worker storage rules.

The positional contract in `src/update-result.ts` is:

| Column | Value |
| --- | --- |
| index1 | targetVersion (sampling key, not an identifier) |
| blob1 | event |
| blob2 | outcome |
| blob3 | fromVersion |
| blob4 | targetVersion |
| blob5 | resultingVersion |
| blob6 | runningVersion |
| blob7 | platform |
| blob8 | arch |
| blob9 | installMethod |
| blob10 | channel |
| blob11 | duration |
| blob12 | postCheck |
| blob13 | failedStage |
| blob14 | errorCategory |
| blob15 | errorCode |
| blob16 | rollback |
| blob17 | recovery |
| double1 | schema (2) |

Analytics Engine adds its own receipt timestamp and sampling weight. Its published
retention is **three months**; this change adds no archive, backup or export job.
Seventeen blobs, one double and one bounded version index fit the published
limits. Operators must confirm retention and the separate binding before a
separately authorized rollout. No production binding was provisioned or verified
by local tests. References: Cloudflare Analytics Engine
[limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) and
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/),
checked September 19, 2026.

## Aggregate-only analysis

No public statistics or individual report route is added. Authorized operators
can use the private Analytics Engine SQL API for bounded aggregates, for example:

```sql
SELECT blob4 AS target_version, blob2 AS outcome,
       SUM(_sample_interval) AS reports
FROM openclaw_update_results
WHERE timestamp > NOW() - INTERVAL '7' DAY AND double1 = 2
GROUP BY blob4, blob2
ORDER BY reports DESC
```

```sql
SELECT blob13 AS failed_stage, blob14 AS error_category,
       SUM(_sample_interval) AS reports
FROM openclaw_update_results
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND double1 = 2 AND blob2 != 'succeeded'
GROUP BY blob13, blob14
ORDER BY reports DESC
```

These are report counts, not unique installs, people or attempts. There are no
identifiers for deduplication or longitudinal joins. Missing reports, update-policy
opt-outs, Nix/CI suppression, NAT rate limits, unauthenticated spoofing and sampling
bias the counts.
Do not treat them as fleet-wide success rates, billing or security evidence.
Avoid individual-row exports or joins to daily geography; review any aggregate
publication separately for small groups. These SQL examples were not run against
production data.

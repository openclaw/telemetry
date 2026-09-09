# Check Worker health

Use this manual CLI to read hourly request and invocation-error estimates for the
`openclaw-telemetry` Worker. It queries Cloudflare's existing infrastructure metrics;
it does not change client collection, Worker observability, or Analytics Engine storage.

## Before running

- Use Node.js 24 and the repository's npm tooling.
- Supply an existing authorized API token as `CLOUDFLARE_API_TOKEN` and its account's
  32-character hexadecimal ID as `CLOUDFLARE_ACCOUNT_ID` in the inherited environment.
  The token needs read access to that account's Workers analytics.
- Do not put credentials in command arguments, shell-history examples, or reports.
  The CLI does not discover credentials, read Wrangler profiles, refresh tokens,
  request grants, or write authentication state.
- Wait at least ten minutes between invocations. This is operator policy, not a
  shared rate counter. Do not schedule the command or wrap it in a retry loop.

```bash
npm run --silent worker:health
```

There are no arguments or endpoint, query, Worker, or time-window overrides.
Missing or invalid environment values fail before any request.

The command writes one projected JSON object to stdout. Exit code `0` means a
complete, validated response; exit code `1` means unavailable data. Stdout is
**not access-controlled**. Keep output within the approved operator audience and
review it before sharing. The command creates no capture files or history.

## Read the result

At invocation, the CLI freezes `T` to the start of the current UTC hour minus one
hour. It queries `[T - 24 hours, T)`, with an inclusive start and exclusive end.
For example, a run at `2026-09-09T08:37:00Z` uses
`[2026-09-08T07:00:00Z, 2026-09-09T07:00:00Z)`. The lag leaves the newest hour out;
it does not guarantee that older data is complete.

An available result contains:

| Field | Meaning |
| --- | --- |
| `status` | `available`, not a claim that the Worker is healthy. |
| `worker` | Always `openclaw-telemetry`. |
| `window.startInclusive`, `window.endExclusive` | The fixed UTC bounds used in the request. |
| `hours` | Exactly 24 rows in ascending UTC-hour order. |
| `hours[].hour` | Start of the reported hour in UTC. |
| `hours[].requestsEstimate` | Cloudflare's adaptive request sum, unchanged. |
| `hours[].errorsEstimate` | Cloudflare's adaptive invocation-error sum, unchanged. |
| `hours[].sampleInterval` | Reported average sampling interval, or `null` when absent or null. |

Request and error values must be nonnegative safe integers. Sampling metadata, when
present, must be a finite nonnegative number. **Adaptive sums are already estimates**:
never multiply them by `sampleInterval`. Sampling metadata is not a confidence
interval or a census guarantee.

An explicitly returned zero is retained as zero. A missing hour is never filled
with zero: any incomplete hourly sequence makes the entire result unavailable.
Missing sampling metadata alone does not discard otherwise valid metrics.

Cloudflare's [Worker metrics documentation](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
describes aggregation across all routes and domains, including `workers.dev`,
while excluding requests blocked by security features such as WAF.
Invocation status is not HTTP status, and its Success category includes client
disconnections. These totals do not establish successful update responses,
Analytics Engine ingestion acknowledgements, or client delivery success.

This query selects only UTC-hour dimensions. It cannot isolate a particular route,
hostname, probe machine, or Analytics Engine SQL API latency. A successful health
query neither explains a separate SQL timeout nor proves that public telemetry is
complete or reliable.

## Bounds and failures

Each invocation makes at most **one POST** to
`https://api.cloudflare.com/client/v4/graphql`, scoped to one account and the fixed
Worker. It requests at most 24 rows. There are no retries, redirect following,
management requests, or ingestion requests.

One ten-second deadline covers connection establishment, response headers, and
streamed response data. The CLI closes its request on failure and limits the body
to 64 KiB while reading it. A deadline or connection failure does not establish
whether Cloudflare completed a dispatched query. Do not infer server cancellation.

Unavailable output contains `status` and a fixed `reason`, for example:

```json
{"status":"unavailable","reason":"incomplete_hours"}
```

For `http_error`, an optional `httpStatus` records the received integer status
from 100 through 599, without headers or response text. Use `401`/`403` to review
existing access, `429` to recognize rate limiting, and `5xx` to distinguish an
HTTP service failure. None of these statuses triggers a retry.

| Reason | Interpretation and next step |
| --- | --- |
| `invalid_arguments` | Remove arguments; the operation has no overrides. |
| `invalid_environment` | Check the two required environment variables without printing their values. |
| `request_timeout`, `network_error`, `response_incomplete` | The request did not yield a complete response. Stop; no automatic retry is performed. |
| `http_error`, `graphql_error` | Cloudflare did not return an accepted success response. Review existing access and service conditions separately. |
| `response_too_large` | The streaming body exceeded the fixed cap. Stop and review the response contract. |
| `invalid_response`, `invalid_hours`, `incomplete_hours` | Results were malformed, partial, duplicated, outside the window, or missing required hours. Do not substitute zeros. |
| `request_failed` | An unexpected local failure occurred. Inspect the implementation without exposing credentials or raw upstream data. |

HTTP errors, nonempty GraphQL errors (even alongside data), malformed JSON,
incomplete streams, extra rows, and invalid counts fail closed. Raw responses,
upstream errors, credentials, account IDs, and stack traces are not emitted.

## Contract evidence

The operation follows the
[pinned Cloudflare exporter schema](https://github.com/cloudflare/cloudflare-prometheus-exporter/blob/c98fd6772a4f/src/cloudflare/gql/schema.gql):
`workersInvocationsAdaptive`, `datetime_geq`/`datetime_lt`, `datetimeHour_ASC`,
`dimensions.datetimeHour`, `sum.requests`, `sum.errors`, and nullable `avg` with
`sampleInterval`. This static schema check and local transport tests do not
establish current live compatibility or account access.

Cloudflare's [GraphQL sampling documentation](https://developers.cloudflare.com/analytics/graphql-api/sampling/)
explains why returned adaptive counts are estimates rather than raw sample counts.
This command intentionally adds no confidence estimates, client dimensions, or
delivery ratios.

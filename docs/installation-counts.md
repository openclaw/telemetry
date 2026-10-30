# Identifier-free reporting installation counts

This is an **observed reporting installation-state-root** metric, not people,
accounts, physical machines, active users, human engagement or all installations.
The counter stores aggregates only. Legacy daily Analytics Engine rows and
schema-2 update outcomes are separate, unchanged owners.

## Capability and isolated count-only transport

The public constants in `src/installation-count.ts` are:

| Constant | Exact value |
| --- | --- |
| INSTALLATION_COUNT_HEADER | `OpenClaw-Installation-Count` |
| INSTALLATION_COUNT_USER_AGENT | `openclaw-installation-count/1` |

1. The existing uncached daily update GET or opt-in schema-1 feature POST sends
   **no count header**. A valid successful **200** version answer advertises
   `OpenClaw-Installation-Count: 1;<server UTC ordinal day>` **only when the optional
   `INSTALLATION_COUNTS` binding is configured**. The receiver captures that day
   once from its clock after the version lookup and uses `Cache-Control: no-store`
   on this day-bearing response. The separate five-minute npm cache remains in use.
   HEAD, schema-2 outcomes, malformed feature uploads and errors never advertise
   count capability. Quota-exhausted POSTs also omit it because their body is not
   read or classified. Old/unconfigured receivers advertise nothing.
2. After a fresh valid version answer, the companion client requires the exact
   capability `1;<day>` with canonical bounded integer day (0–99999999). It
   atomically claims **that server day**, not its local-clock day, using its
   existing SQLite owner per **endpoint + state root + day**. There is no claim
   or count metadata sent to an old/unconfigured receiver. Local time is only
   update bookkeeping, not the count bucket. A first install can count in this
   same capability-bearing cycle; no activation warm-up or persistent capability
   state is needed.
3. After claiming, the client rechecks current policy including explicit
   `telemetry.enabled: false` (`openclaw telemetry off`), `DO_NOT_TRACK` and
   CI restrictions for the captured endpoint. It may then send **one separate
   POST to that same full endpoint**, with the fixed generic User-Agent above,
   `OpenClaw-Installation-Count: 1;<server day>;<gap>` and **no body**. There are no
   feature, inventory, version, geography, identifier or token fields. Redirects
   are forbidden; the count POST has an independent bounded three-second timeout.
   No retry, outbox or delayed queue is added. Failed or ambiguous delivery never
   discards the valid cached version answer and never causes a repeated count.

This adds at most **one count-only POST** after an existing uncached successful
24-hour update check; it does not add another update check or model request.
A client-side cache hit, including a same-day cold restart that reuses the cache,
sends neither request. Feature statistics remain off by default.

Gap is canonical ASCII integer **1–31**: server-day distance from the previous
local claim, capped at 31; first/unknown history uses 31. No zero-gap header is
sent. Header fields accept no whitespace, extra fields or leading zeroes. The
receiver accepts the current or immediately previous authoritative UTC day,
retaining the reported original day rather than rebucketing by arrival time.
This allows delivery across midnight; future/older days and comma-joined duplicate
headers are rejected. No local client-clock comparison selects the count day.

**Any presence** of the count header selects the isolated count path before HEAD,
outcome parsing, legacy analytics, geography or npm lookup, even if the value is
empty/malformed. The generic count User-Agent also selects this path if its header
is missing. Valid requests require POST, that exact User-Agent, a valid header and
an absent/empty body, validated synchronously from provider-trusted physical HTTP
framing: no Transfer-Encoding and either exact Content-Length: 0, or absent
Content-Length with a null body. Real workerd exposes a non-null stream even for
a correctly framed Node fetch POST with Content-Length: 0, so that framing is
accepted without probing EOF. Nonzero/invalid lengths and present chunked or
unframed bodies are rejected immediately, including stalled streams. No stream
reader is obtained and no body is read, accumulated or decoded. There is no
raw-analytics fallback.

Count-only responses have no body and `Cache-Control: no-store`:

| Status | Meaning |
| --- | --- |
| 204 | Accepted, or intentionally ignored for absent binding, `DNT: 1` or exhausted recording quota |
| 400 | Invalid header, wrong method/User-Agent, or invalid/nonempty/unframed body framing |
| 503 | D1 write failed; delivery may still be ambiguous, so never retry |

Binding presence is capability, not proof of storage health or production
readiness. Count-only errors are separate from the already-successful update
answer. The client does not derive exactly-once storage from any response.

There is no identifier to deduplicate repeated requests at the receiver. The
client's durable daily claim owns that guarantee. Separate state roots count
separately; deleted/reset/copied state, missed deliveries, server clock errors,
opt-outs, rate limits, unavailable storage and forged requests bias this metric.
Missing an early qualifying report can undercount a longer window even when a
later report arrives. It is not suitable for billing, security decisions or
precise fleet size. No public configuration knob or statistics route is added.

## Aggregate storage and expiry

The optional `INSTALLATION_COUNTS` D1 binding uses
[`migrations/0001_installation_counts.sql`](../migrations/0001_installation_counts.sql).
Its only application table is:

| Column | Meaning |
| --- | --- |
| day | Report's bounded UTC ordinal day |
| gap | Days since previous local claim, capped at 31 |
| reports | Positive aggregate number of reports in this day/gap bin |

The primary key is `(day, gap)`. All columns have bounded integer constraints.
One transactional D1 batch deletes expired bins and atomically UPSERTs the count;
there is no read/modify/write race and no request-level record. At most 90 × 31
bins remain after cleanup. The D1 code receives only day/gap, not a Request,
User-Agent, IP, geography, token, dimension or timestamp. No raw events are
written to Analytics Engine for this counter. Count-only requests never enter
the legacy recorder, even when malformed. The separate ordinary update request
can still produce its existing documented identity/geography row; the histogram
contains none of those dimensions.

Retention is the current UTC day and preceding 89 days. Ingestion prunes older
bins; a daily scheduled cleanup also prunes when no clients report. A separately
authorized production rollout **must configure and monitor this cleanup**. Failed
cleanup or a disabled trigger can extend physical retention until recovery;
never describe a broken schedule as guaranteed automatic expiry. No archive,
backup or raw export job is added. Provider-managed D1 recovery/Time Travel and
connection processing are separate infrastructure policies the rollout must
review. Worker observability, logs and invocation logs remain disabled.

The existing per-IP recording limiter gates the histogram too, exactly once
after synchronous framing validation; no count body is read. IP is used only as
the existing transient limiter key,
not written to D1. Ordinary quota-exhausted update callers still receive their
version answer; quota-exhausted count-only POSTs return empty 204 without storage
or reading an unfinished body. D1 writes are awaited only by the separate count
POST; missing schema/storage errors return empty 503, never a changed update
answer. A successful update response is **not** an acknowledgement of count
storage; do not retry an ambiguous count.

## Deployment gate

The production `wrangler.jsonc` intentionally has **no D1 binding or cleanup
trigger**. Existing main-push automation can deploy receiver code, but cannot
provision or activate the new counter. Landing this change authorizes neither
production collection nor paid resources, infrastructure provisioning or manual
deployment. A separate authorized rollout must provision/approve D1, apply the
migration, add `INSTALLATION_COUNTS` and a daily cleanup trigger, verify storage,
expiry and provider recovery retention, then approve client rollout. Preserve
`TELEMETRY` and `UPDATE_RESULTS` ownership. No credentials are needed for local proof.
Never deploy `wrangler.local.jsonc`: its UUID is a dummy local database, not a
production identifier.

## Private aggregate analysis

Authorized operators can query the account-level **private D1 API or console**;
no Worker statistics route or client credential is added. Bind `:S` and `:E`
as inclusive UTC ordinal days with `0 <= E-S <= 30`, both inside retention:

```sql
SELECT COALESCE(SUM(reports), 0) AS reporting_installation_state_roots
FROM installation_counts
WHERE day BETWEEN :S AND :E AND gap > day - :S;
```

A report qualifies only when its previous local claim predates the window.
Under intact client claims and complete delivery this counts the first report
per root in that window exactly once. The 31-day gap cap supports windows of up
to 31 days, not arbitrary longer periods. Attempt-before-network prevents retry
overcount, but a lost qualifying report can cause undercount even if a later
report arrives. Unknown history and state resets can overcount.

Rolling 1/7/30 calendar-day windows ending today (today may be incomplete):

```sql
WITH today(d) AS (SELECT CAST(unixepoch('now') / 86400 AS INTEGER)),
windows(n) AS (VALUES (1), (7), (30))
SELECT n AS days, COALESCE(SUM(h.reports), 0) AS reporting_installation_state_roots
FROM windows CROSS JOIN today
LEFT JOIN installation_counts h ON h.day BETWEEN d-n+1 AND d AND h.gap > h.day-(d-n+1)
GROUP BY n ORDER BY n;
```

For a calendar month, convert its first and last included date to `S` and `E`;
months up to 31 days use the same query. Late boundary delivery can revise
counts for the previous day. These are private, biased reporting-root counts,
not public unique-user statistics; review any publication separately.

## Reproduce with local workerd and persisted SQLite

Use the locked dependencies, Node.js 24+ and **local-only** D1 commands:

```sh
npm ci
npm test -- test/installation-count.test.ts test/installation-count-runtime.test.mjs test/deployment.test.ts
npx wrangler d1 migrations apply installation-counts-local --local --config wrangler.local.jsonc
WRANGLER_SEND_METRICS=false npx wrangler dev --local --config wrangler.local.jsonc --ip 127.0.0.1 --port 8797 --test-scheduled
# In another terminal: inspect capability on the ordinary update response.
curl -i http://127.0.0.1:8797/api/latest-version
# Use its advertised server day below; do not derive it from the client clock.
# Example only: day=20754
curl -i -X POST -A openclaw-installation-count/1 -H "OpenClaw-Installation-Count: 1;$day;31" http://127.0.0.1:8797/api/latest-version
npx wrangler d1 execute installation-counts-local --local --config wrangler.local.jsonc --command 'SELECT day,gap,reports FROM installation_counts ORDER BY day,gap'
# Local simulated cron only:
curl 'http://127.0.0.1:8797/cdn-cgi/handler/scheduled?cron=0+0+*+*+*'
```

On hosts at their filesystem-watch limit, prefix the dev command with
`CHOKIDAR_USEPOLLING=true` instead of changing system limits.

The tests use the production Worker over real workerd HTTP with simulated D1
persisted to local SQLite, synthetic inputs and an npm upstream fixture. They
prove concurrent atomic increments, persistence across runtime restart, strict
invalid/duplicate header rejection, capability/legacy/outcome/HEAD separation,
zero raw count-path analytics/geography/npm access, DNT and rate limiting,
missing binding/schema availability, migration constraints and idle cleanup.
This does not establish production readiness or replace real client integration.

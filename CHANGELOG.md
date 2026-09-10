# Changelog

## Unreleased

**Highlights:** Public update checks and seven-day usage aggregates, with optional feature statistics and no stored install identifiers.

- Add an operator-invoked, dry-run-default aggregate capture pilot for one closed UTC day: hourly Analytics Engine reports and separate HTTP country estimates in a private, exclusively created bundle with offline verification. No scheduled backup, upload, raw-event restoration, storage provisioning, or retention change.
- Export one hash-pinned archived hourly Analytics Engine query to private daily JSON, CSV, and provenance/coverage artifacts. Preserve exact sampled report counts, flag partial days and missing hours, and restrict comparison totals to complete closed UTC days. No raw-event restoration, live queries, or backup job.
- Record bounded Cloudflare-derived request-origin country, region code, city, and timezone in baseline update-request metadata, without raw IPs or direct identifiers. Replace the unshipped client UTC-offset proposal, preserve existing columns and public stats, and disclose the unchanged three-month retention and feature opt-out boundary.
- Add offline, manifest-bound npm comparison tooling with matched UTC windows, captured feed cutoffs, anomaly checks, exclusion sensitivity, and separate undated version totals. Download events are never converted to installations or users.
- Show same-query feature report counts and percentages alongside version and platform rankings, plus a bounded process-architecture breakdown from existing fields. Preserve cached response compatibility and label truncated rankings, unavailable shares, and sampling limits without adding collection.
- Preserve successful update responses when the version cache fails, and validate cached versions with the same nonempty-string rules as npm responses.
- Bound User-Agent parsing before matching and reject malformed feature IDs without converting them into public names.
- Aggregate the complete retained public vocabulary without joint-group truncation, fail closed on incomplete query results, and expose fixed windows and query-local report totals and event watermarks. Label public counts as reports and configuration or inventory, preserving the legacy `installs` API alias.
- Preserve the ten-minute public stats freshness limit on cache hits without resetting their age, and refresh entries when the cache retains them beyond that limit.
- Generate and retain public plugin, channel, and provider vocabulary from immutable OpenClaw metadata; include bundled plugins and historical catalog names, and canonicalize accepted names before storage.
- Cache public stats for ten minutes, rate-limit cache misses independently of recording, and keep successful stats available when cache operations fail. Thanks @SebTardif.
- Disable Worker observability and request logging, and clarify transient IP use for rate limiting versus Analytics Engine storage and Cloudflare infrastructure processing.
- Serve the latest OpenClaw release with a five-minute npm cache and an optional urgent-release note.
- Publish seven-day version, platform, channel, provider, and plugin aggregates through the public stats API and homepage.
- Validate reported names against public catalogs, count private plugins without naming them, and rate-limit recording while preserving update responses.
- Bound optional telemetry uploads to 16 KiB before buffering them, while preserving update-check responses. Thanks @SebTardif.
- Update Cloudflare Worker tooling and GitHub Actions, and validate pull requests with reproducible installs, tests, and a Worker build before deployment.
- Upgrade the test runner to Vitest 5 and refresh Cloudflare Worker types; document Node.js 24 for development.
- Restrict deployment workflow token permissions to read-only repository contents. Thanks @vincentkoc.

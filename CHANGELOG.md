# Changelog

## Unreleased

**Highlights:** Public update checks and seven-day usage aggregates, with optional feature statistics and no stored install identifiers.

- Add a bounded, manual Worker-health CLI with hourly adaptive request and error estimates, strict incomplete-data handling, and an operator runbook. No client collection or Worker runtime settings change.
- Add offline, manifest-bound npm comparison tooling with matched UTC windows, captured feed cutoffs, anomaly checks, exclusion sensitivity, and separate undated version totals. Download events are never converted to installations or users.
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

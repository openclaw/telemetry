# Changelog

## Unreleased

**Highlights:** Public update checks and seven-day usage aggregates, with optional feature statistics and no stored install identifiers.

- Serve the latest OpenClaw release with a five-minute npm cache and an optional urgent-release note.
- Publish seven-day version, platform, channel, provider, and plugin aggregates through the public stats API and homepage.
- Validate reported names against public catalogs, count private plugins without naming them, and rate-limit recording while preserving update responses.
- Bound optional telemetry uploads to 16 KiB before buffering them, while preserving update-check responses. Thanks @SebTardif.
- Update Cloudflare Worker tooling and GitHub Actions, and validate pull requests with reproducible installs, tests, and a Worker build before deployment.
- Upgrade the test runner to Vitest 5 and refresh Cloudflare Worker types; document Node.js 24 for development.
- Restrict deployment workflow token permissions to read-only repository contents. Thanks @vincentkoc.

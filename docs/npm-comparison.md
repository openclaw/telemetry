# Offline npm comparisons

Use Node.js 24 and the repository's existing npm dependencies:

```sh
npm run npm:quality -- --manifest ./captures/manifest.json --output ./results/run-01
```

This command reads saved JSON only. It does not collect data, fall back to a
network service, schedule work, publish results, or load the Worker. The output
directory must not exist, must be outside the input archive, and must have an
existing parent. Resolve filesystem aliases before passing paths: symlink files
and symlink parent directories are rejected.

Each successful run creates `quality.json`, `quality.md`, and `input-hashes.json`
in a mode `0700` directory, with mode `0600` files. Reusing an output directory
fails without overwriting its contents. Keep the results private until reviewed.

## Manifest version 1

The manifest's parent directory is the input archive root. Every referenced file
must be beneath it and must have its exact byte length and SHA-256 recorded.
Unknown fields, unsupported schema versions, unknown references, duplicate
identities, unreferenced files, traversal, and invalid values are rejected.
Input files can be projected captures; their digest must cover the saved
projection, not the original HTTP body.

Required top-level fields:

| Field            | Contract                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | Exactly `1`.                                                                                                                           |
| `analysisAt`     | Explicitly zoned timestamp, at millisecond-or-coarser precision. Captures cannot be newer.                                             |
| `corePackage`    | Declared core package name in the inventory, or `null`. Independent of comparison exclusions.                                          |
| `files`          | Array of `{ id, file, bytes, sha256 }`. IDs are lowercase letters, digits, and hyphens, starting with a letter, at most 64 characters. |
| `windows`        | Array of `{ id, start, end }`, with inclusive UTC dates in `YYYY-MM-DD` format.                                                        |
| `comparison`     | `{ current, previous, baseExclusions, groups }`; window IDs and package names are explicit.                                            |
| `packages`       | Array of `{ name, manifestId, legacyFor, captures }`.                                                                                  |
| `cutoffControls` | Nonempty array of `{ id, package, capture }`, with distinct control package names; `package: null` means the global npm point.         |
| `anomalyProbes`  | Array of `{ day, capture }`, referring to global dated point responses. May be empty, leaving anomaly quality unknown.                 |
| `pointProbes`    | Array of `{ id, package, day, capture }` for explicit dated point responses. May be empty.                                             |
| `packaging`      | Saved packaging-declaration capture ID, or `null`.                                                                                     |
| `telemetry`      | `{ format, capture }`, where `format` is `query-window` or `public-stats`, or `null`.                                                  |

A package's `captures` is exactly `{ downloads, registry, versions }`. Each value
is a file ID or `null` for unacquired data. A null reference is different from a
referenced file that is missing: the latter fails the run. `manifestId` is a
bounded public plugin ID or `null`; `legacyFor` is another package name or `null`.
These are operator-declared mappings, not independently verified package
equivalence. Do not include private mappings or freeform evidence text.

`comparison.current` and `comparison.previous` must name different windows with
equal UTC day counts, in chronological order without overlap. Unrelated
assessment windows can have other lengths or overlap. An invalid comparison is
rejected before producing a growth percentage.

`baseExclusions` contains packages excluded from every group. Each group is
`{ id, exclude }`, where `exclude` lists additional packages. Every excluded name
must appear in `packages`; typos are rejected rather than interpreted as zero
impact. Missing captures for a known package remain unavailable. For example:

```json
{
	"current": "current-week",
	"previous": "previous-week",
	"baseExclusions": ["openclaw"],
	"groups": [
		{ "id": "all-plugins", "exclude": [] },
		{ "id": "without-codex", "exclude": ["@openclaw/codex"] }
	]
}
```

This is the `comparison` field, not a complete manifest. Inventory and capture
references must be supplied separately. There are no fixed dates, control
packages, archive layouts, or exclusion groups in the implementation.

## Saved capture contracts

npm captures contain `{ url, fetchedAt, status, body }` and optionally
`responseSha256`. Other saved metadata is not copied to reports. The tool
validates the expected HTTPS origin, decoded path, package identity, HTTP status,
timestamps, date bounds, and counts; credentials, queries, and fragments in
capture URLs are rejected.

| Kind             | Expected URL path and body                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dated downloads  | `https://api.npmjs.org/downloads/range/START:END/PACKAGE`; `{ package, start, end, downloads: [{ day, downloads }] }`.                                                 |
| Cutoff control   | `https://api.npmjs.org/downloads/point/last-day/PACKAGE`; `{ package, start, end, downloads }` for one UTC date. Global controls omit the package path and body field. |
| Dated point      | The same point endpoint with an explicit date instead of `last-day`.                                                                                                   |
| Publication      | `https://registry.npmjs.org/PACKAGE`; HTTP 200 with `{ name, time: { VERSION: TIMESTAMP } }`, or an HTTP 404 object.                                                   |
| Version snapshot | `https://api.npmjs.org/versions/PACKAGE/last-week`; `{ package, downloads: { VERSION: COUNT } }`, optionally with both `start` and `end`.                              |

Counts must be nonnegative safe integers. Duplicate dated rows, invalid calendar
dates, out-of-bounds rows, and unsafe sums are not accepted as measured totals.
Invalid capture evidence is reported as invalid; it does not become zero.
Malformed files, hash mismatches, manifest errors, and total resource-limit
violations fail the run before outputs are created.

All declared cutoff controls must return the same cutoff and have the same UTC
capture date. Dated series are usable for availability only when their UTC
capture date matches those controls. This binds the evidence to the saved
snapshot; a later analysis date does not refresh it. Lag is measured relative to
the last complete UTC date at capture time, not analysis time.

A packaging capture contains `capturedAt` and a nonempty `evidence` array. Each
entry needs `revision`, `responseSha256`, `url`, `excludedExtensions`, and
`distInclusions`. The URL must be the public OpenClaw repository's
`package.json` at the recorded revision. Revisions may be full commit SHAs or
version tags; tags are not represented as immutable commits. Exclusions are
public manifest IDs, and dist inclusions support `dist/` or `dist` only.
Unrecognized declaration contracts leave classification unknown. This is
captured source-declaration evidence, never proof of shipped tarball contents.

`query-window` telemetry uses `queriedAt` and
`window: { startInclusive, endExclusive }`. `public-stats` uses HTTP `status`,
`receivedAt`, and `body: { windowStart, windowEnd, generatedAt? }`.
The tool compares exact UTC instants, not similarly formatted calendar labels.
It does not consume report counts or calculate npm-to-telemetry conversion rates.

## Interpretation

- A complete set of dates is not proof of complete events.
- `known_gap` identifies a synchronized zero anomaly supported by the global
  point and every valid package series for that date. The probe date must be
  available under a known cutoff, and the probe and participating series must
  match its UTC capture date. Unavailable or unbound evidence, a contradiction,
  or a missing package date leaves the anomaly assessment unknown.
- `no_known_gap` means no detected gap in the assessed evidence. It does not
  certify reliable events, a census, or the absence of other outages.
- HTTP 200 zeros after the captured cutoff are unavailable, not zero demand.
  Registry 404s and unacquired series are not synthetic zeros either.
- Publication exposure counts intersecting UTC dates, including a partial first
  day. The earliest recorded version includes placeholders; it is not product
  availability or elapsed full days.
- Version snapshots without returned dates stay undated and separate. Their
  nominal period is not substituted for a dated series.
- Exclusion comparisons use only packages with both complete dated windows and
  available sums. They report unavailable package identities alongside the
  included count. A zero prior yields a null percentage, not infinity.
- Concentration and net arithmetic are not breadth of package growth, adoption,
  unique installs, users, or causal attribution. Legacy names are not
  deduplicated users.

## Bounds and provenance

Limits are fixed in the versioned implementation, not configurable overrides:
1 MiB manifest; 1,024 capture files; 4 MiB per capture; 32 MiB total capture bytes;
512 packages; 16 windows, groups, controls, or probes of each kind; 3,660 UTC dates
per window or dated series; 20,000 publication/version entries per capture;
250,000 aggregate parsed observation/declaration records. Oversized individual
capture collections are invalid evidence; exceeding the aggregate record budget
fails the run. Records include dated rows, publication entries, version counts,
packaging sources, exclusions, and dist inclusions.

The number of packages multiplied by the sum of all requested window lengths
must also be at most 250,000 UTC date assessments. This independent limit bounds
generated missing-date arrays even when the captured series are empty. Exceeding
it rejects the manifest before reading captures or producing reports.

`input-hashes.json` records the exact manifest and capture bytes used in analysis,
identified by manifest IDs rather than local paths. The optional recorded HTTP
response hash is validated as a SHA-256 string and labeled as recorded, never
recomputed or verified against a projection. A saved-file digest is not a wire
digest or a claim that a mutable source URL still serves the same bytes.

Outputs contain only selected structured metadata, fixed explanatory text, and
derived values. They do not copy headers, arbitrary mapping evidence, legacy
interpretations, local paths, or raw captures. Stable ordering and explicit
analysis time make repeated runs over the same bytes deterministic.

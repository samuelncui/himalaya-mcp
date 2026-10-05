# Release and recovery

## Owners and versioning

Normal source changes use reviewed pull requests. Commit the initial empty repository on `main` before preparing a candidate; release preparation rejects a dirty or uncommitted checkout. The user owns deployment credentials and dangerous-operation policy. Automation does not edit that policy or require maintainers to approve new dangerous entries.

The npm version is `<native-version>-adapter.<adapter-version>`, for example `2.2.1-adapter.0.1.1`. Tracked `package.json` holds the adapter version (`0.1.1`); assembly changes only the staging copy. When adapter source or packaged documentation changes for the same native version, bump the adapter SemVer through a reviewed change. npm versions are immutable: the same version with different bytes is rejected.

## Automatic upstream release

`upstream.yml` checks daily at 01:17 UTC or through `workflow_dispatch`; its optional `version` input selects a stable `X.Y.Z`, and an empty value selects the latest official release. The workflow pins its full source revision and Cargo.lock, verifies all five official archive/executable digests and feature sets, reflects the upstream Clap tree, and runs syntax, parser, and complete native Help checks. `catalog-diff.json` compares command, argument, alias, and Help changes with the integrity-verified preceding npm release; the first version records `initial`. The comparison excludes the candidate itself, so repeated builds retain the same evidence after publication. Removed paths are printed in CI. Retrieval or integrity failures stop generation rather than being treated as a first release. Generation and packaging stay under ignored `build/` and `dist/`; an upstream update does not commit a generated lock or catalog to `main`.

The exact packed artifact is checked on native macOS arm64/x64, Linux arm64/x64, and Windows x64 runners. Checks include dependency-free installation with lifecycle scripts disabled, offline `describe`/`doctor`, verified first download and cache reuse, protocol/tool definitions, and synthetic complex MIME with a loopback SMTP fixture. No mailbox credentials are available. Runner configuration is a requirement, not evidence that the matrix has already passed.

Candidates and evidence are retained in `release-candidate-<run-attempt>` artifacts for 30 days. Each upload has an attempt-specific name; generation and package jobs pass the exact sealed artifact ID to consumers. Failed-only reruns can reuse a successful earlier generation, and a repeated package job creates a new immutable candidate without deleting the previous one. A technical compatibility, provenance, or platform failure stops publication. Fix the generic generator, serializer, executor, or factual profile through a reviewed change and regenerate. Do not patch generated command entries, skip a failed platform, or turn unknown commands into a hidden allowlist.

Publishing jobs receive only sealed release artifacts, verify their hashes, and do not build upstream or execute the package. npm publication uses `latest`; `himalaya-<native-version>` also identifies the release for that native version. GitHub Release assets preserve `package.tgz`, `release.lock.json`, original source, Cargo.lock, and verification and definition-diff reports. The lock records adapter revision/dependency lock, upstream revision/features, catalog, and all five asset digests; package-local `dist/release.json` records the corresponding provenance without a circular package hash.

## npm bootstrap and trusted publishing

Before enabling automatic publication, confirm ownership of the configured public GitHub repository and npm package name. If the package does not yet exist, wait for all five platform jobs to pass, then have its owner publish that exact `release-candidate-<run-attempt>` artifact with their npm identity:

```sh
node scripts/release.mjs verify
npm publish build/release/package.tgz --tag latest --access public --ignore-scripts
```

Then configure the package's GitHub trusted publisher for this repository, workflow filename `upstream.yml`, and environment `npm`. Allow **npm publish** and **npm dist-tag** separately. The workflow pins npm `11.21.0`, which supports OIDC for both; an ordinary `npm whoami` result does not verify those OIDC permissions. An identical existing version may be reused without an npm publish. A green no-op rerun therefore does not prove permission to publish a new version: acceptance requires an actual new-version OIDC publish and a dist-tag operation. The publisher reads back archive integrity and both tags, and GitHub Release checks the actual Git tag commit. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

Set repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true` only after that setup. Without the gate, automation prepares a candidate rather than publishing. Do not add a long-lived npm token to compensate for missing OIDC configuration. The publisher rejects long-lived token variables and requires this repository's exact sealed `main` revision.

## Reproduce a candidate locally

Use a clean committed checkout, Node `24.21.0`, npm `11.19.0`, Rust, and the C build prerequisites described in [CONTRIBUTING.md](../CONTRIBUTING.md). This creates a candidate and verifies the current platform; it does not publish or prove all five platforms:

```sh
node --version # must report v24.21.0 for the packaging baseline
npm install --global npm@11.19.0 --ignore-scripts --registry=https://registry.npmjs.org
npm ci --ignore-scripts
node scripts/release.mjs prepare --version 2.2.1
node scripts/upstream.mjs generate --lock build/generated/upstream.lock.json
npm run build
npm run check
npm run verify:native
node scripts/release.mjs assemble
node scripts/release.mjs verify
node scripts/smoke-pack.mjs --package build/release/package.tgz
```

Generation and packaging pin Node `24.21.0` and npm `11.19.0`, matching the validated CI toolchain. The publisher separately uses npm `11.21.0` for OIDC/dist-tag support and publishes the existing archive without repacking it. Runtime platform checks can use the current Node 24 release. Changing the packaging toolchain requires review and a candidate check; matching source revisions alone does not prove matching archive bytes.

Every pack logs `Package evidence` with Node/npm/zlib versions, compressed and uncompressed tar digests, the gzip header, and each entry's content digest and tar metadata. Compare those records to locate content, metadata, or compression differences. These diagnostics do not change package contents or replace `release.lock.json`. A published npm version is immutable: do not ignore an integrity mismatch, overwrite release evidence, or replace a sealed CI package with a separately rebuilt local archive.

Omit `--version 2.2.1` on `prepare` to select the latest upstream release. The sealed package is `build/release/package.tgz`; its evidence is beside it. `publish` and `github` are isolated workflow stages, not local bypasses for failed CI. Keep candidate artifacts for investigation; never substitute files in a sealed release.

## Failed or interrupted releases

Inspect the exact failed run and its artifacts before changing code:

```sh
gh run list --workflow upstream.yml --limit 10
gh run view RUN_ID --log-failed
gh run rerun RUN_ID --failed
```

Replace `RUN_ID` with the relevant run ID. Rerun only failed jobs from the original run when npm published but tags or GitHub Release failed; this retains the original sealed package ID. A full rerun rebuilds a fresh candidate under new attempt-specific artifact names and must still satisfy the published version's immutable archive integrity. If the npm version already exists with identical archive integrity, the workflow repairs tags and release assets; different bytes fail and require a reviewed adapter version bump. If artifacts have expired, prepare and verify a fresh candidate from the recorded revisions; do not claim recovery unless its bytes match or publish it under a new adapter version. Automation refuses to move `latest` backward; an owner must explicitly handle a rollback.

For a compatibility failure, preserve `release.lock.json`, verification reports, and sanitized logs; reproduce the pinned upstream version locally, fix the owning source, and run the normal checks. A new workflow run then produces a new reviewed adapter candidate. User policy changes are not part of this procedure.

## Schedule and deployment recovery

A public repository's scheduled workflows can be disabled after 60 days without repository activity. Forked schedules start disabled, and scheduled runs may be delayed. Check the Actions page rather than assuming a timer has fired. Re-enable and trigger the workflow when needed:

```sh
gh workflow enable upstream.yml
gh workflow run upstream.yml --ref main
# To reproduce a specific native version instead of latest:
gh workflow run upstream.yml --ref main -f version=2.2.1
```

See [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) and [enabling workflows](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow). If publication needs to pause, set the publishing gate to false or disable the workflow; investigate before re-enabling it.

Deployments should pin an available npm version rather than follow `latest` silently. Upgrade or roll back by changing that pin and restarting the service. Keep native configuration, user policy, credentials, and persistent account storage outside the package; retain current refreshed OAuth credentials during rollback. Run local `doctor`, verify the new process and intended trusted client, and treat resources from the old process as expired. The adapter does not migrate account data or manage deployment backups.

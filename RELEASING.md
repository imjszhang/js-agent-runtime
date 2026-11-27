# Releasing with GitHub trusted publishing

Future npm publications use `.github/workflows/publish.yml` with GitHub OIDC. Do not publish locally, store an npm publishing token, or fall back to per-release browser authentication. Public source, a Git tag, a GitHub Release, registry publication and host deployment are separate outcomes.

## Prepare and publish

Use Node 24 and npm 11.19.1 for release preparation. Commit the intended version and changelog; `npm version <version> --no-git-tag-version` and `npm run version` keep package, lock and `RUNTIME_VERSION` aligned. Preserve existing published versions and tags.

The workflow accepts only `main` and `release/0.2`, and always checks out the original workflow SHA. `release/0.2` is the maintenance line based on v0.2.3; do not accidentally include unreleased main features in a patch release. Confirm the chosen branch contains precisely the intended changes.

First run preparation without publishing:

```sh
gh workflow run publish.yml --ref main -f version=<exact-version> -f publish=false
```

After reviewing the intended source and passing checks, publish:

```sh
gh workflow run publish.yml --ref main -f version=<exact-version> -f publish=true
```

For a maintenance release, use `--ref release/0.2`. Ordinary pushes, tags, PRs and preparation-only runs never publish. Stable versions use `latest`; prerelease versions use their alpha/beta/rc/mcp channel. The publication job alone has `id-token: write` and uses the `npm` environment. That environment allows only the two release branches and has no per-release approval or wait timer.

Preparation runs version/type/portable tests, package consumption and packing. It retains the tarball and a SHA-512 manifest from the clean exact source. The publishing job rechecks the source, package metadata, archive digest and channel before issuing at most one publish mutation. It refuses local execution, token-based fallback, mismatched artifacts and an existing version with different bytes.

Registry processing may delay visibility. On an uncertain outcome, inspect registry state and workflow logs; never blindly republish or bump the version to hide uncertainty. An identical existing version is verified without publishing again or moving its historical dist-tag backwards.

After success, verify exact version, integrity, signatures and provenance in a clean consumer. Download the same workflow artifact, create an annotated tag at its source SHA, and attach the archive and manifest to the GitHub Release. Deployment to a host remains a separate authorized operation.

## One-time npm binding

Bind package `js-agent-runtime` to repository `imjszhang/js-agent-runtime`, workflow filename `publish.yml`, environment `npm`, with direct `npm publish` allowed. Establishing or changing this binding may require one account verification. Do not select staged-only publishing, which would require approval on every release.

A new binding must complete its first successful publish within two days; a preparation-only run or an already-existing-version check does not validate it. If it expires, recreate it only when an actual release is ready. After successful validation, routine releases use short-lived GitHub credentials without manual npm authorization.

Reference: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

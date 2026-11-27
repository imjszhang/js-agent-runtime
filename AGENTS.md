# Project instructions

Read README.md for scope and RELEASING.md before release work.

All future npm publications use `.github/workflows/publish.yml` with GitHub OIDC, from the exact `main` or `release/0.2` workflow SHA. Do not publish locally, request per-release npm authorization or add a persistent publishing token as fallback. One-time binding authentication is distinct from publication.

Prepare and test the intended version, commit and sync the selected branch, then explicitly dispatch `publish=true` with the exact version. Preparation-only is the default. Inspect registry state before retrying uncertain outcomes; never blindly republish. Preserve immutable published versions/tags and keep unreleased main features out of maintenance releases.

Verify registry integrity, provenance and a clean consumer; tag the exact published source and retain workflow artifacts in the Release. Publication does not automatically upgrade any host project.

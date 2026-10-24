# Releasing

## First npm publication (0.1.0)

The GitHub source release does not publish to npm. From the clean `v0.1.0` checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm pack --dry-run
npm login
npm whoami
npm publish --access public
```

Confirm package name ownership and inspect the pack file list before publishing.
The prepublish hook runs version, type, and portable test checks; prepack builds `dist`.
Use the npm account's required authentication/2FA flow. No npm token belongs in this
repository. Registry availability is not reserved by creating a GitHub repository.

After successful publication, verify `npm view js-agent-runtime@0.1.0 version`.
If publication fails, fix the cause and retry the same unpublished version; do not
move an existing public tag to different source code.

## Subsequent versions

1. Start with a clean, up-to-date `main` and passing CI.
2. Move Unreleased changelog entries to the intended version and date, then commit.
3. Run `npm version patch` (or `minor` / `major`). The version hook updates
   `src/plan.ts`; npm updates package.json and package-lock.json, commits, and tags.
4. Run `npm run check` and `npm run test:package` on that version.
5. Push the commit and tag with `git push origin main --follow-tags`.
6. Verify CI, create the matching GitHub release, and publish with `npm publish --access public`.

During 0.x, breaking API changes use a minor increment. Patch versions are compatible
fixes. Never reuse a published npm version. npm publishing is manual; CI does not
hold credentials or publish automatically.

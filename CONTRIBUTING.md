# Contributing

Use Node.js 20 or newer on macOS or Linux.

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

Portable tests use fake CLIs and require no provider credentials. Native checks are
optional and documented in the README. Add regression coverage for behavioral changes;
keep credential resolution, redaction, and permission boundaries explicit. Update the
README for API changes and the Unreleased section of CHANGELOG.md for user-facing changes.

Submit focused pull requests against `main`. Do not include credentials, local logs,
generated `dist` files, or `node_modules`.

## Versions and releases

See [RELEASING.md](RELEASING.md). Package versions and the runtime version must stay in sync.
Adapter versions are separate compatibility identifiers; increment them when changing
an adapter's generated execution plans.

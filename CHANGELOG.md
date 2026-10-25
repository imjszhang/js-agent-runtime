# Changelog

Changes are recorded by package version. Version numbers follow Semantic Versioning;
during 0.x development, breaking changes increment the minor version.

## [Unreleased]

- Run Cursor Agent on native Windows. Point `harness.executable` at the version directory's `node.exe` (the `agent.cmd` shim is still rejected). The adapter starts the sibling `index.js` without a shell. `cursor-login` reads the Windows user credential file only when `useCurrentUserHomeForLogin` is set and never copies it. Workspace-write puts a PowerShell PATH shim ahead of the host shell to strip credential-like variables. Reviewed builds are `2026.07.23-e383d2b` and `2026.10.22-27dcf5f`. Cursor adapter version is now 2; recreate older plans. The stall-timeout preload remains bound to the first build and fails closed on any other bundle.

- Preserve Windows PowerShell arguments without doubling ordinary backslashes; isolate tool home/application-data directories and force `-NoProfile` while retaining native login inputs only in the parent Cursor process.

## [0.2.1] - 2026-10-25

- Add basic native Windows execution support. Live Windows validation covers Claude Code with `claude-config` and `bypass` only; other adapters and sandbox modes remain unverified on Windows, and Cursor remains POSIX-only.
- Support native Windows for `run()` and metadata `probe()`: children start hidden without a shell, and timeout, abort, output-limit and parent-exit handling end the process tree with `taskkill /T /F` while the root is still running. Windows has no graceful termination phase and does not contain descendants that outlive the root; see the README.
- On Windows, reject `.cmd`/`.bat` executables at planning time (they need a shell; point targets at the native `.exe`). Path overlap checks are case-insensitive there, as before.
- Add cross-platform process lifecycle tests, skip shebang fake-CLI and Cursor bash tests on Windows with explicit reasons, run `test:package` on Windows, and add Windows to CI. Verified one live Claude Code `claude-config` attempt on Windows.

## [0.2.0] - 2026-10-24

- Align local agent execution with js-llmlab: add OpenCode V2 and Cursor Agent adapters, examples and request-schema definitions.
- Verify OpenCode completion using credential-free native session exports; preserve unknown Cursor usage, cost and model identity.
- Add Cursor transport/login compatibility options, guarded stall-timeout support, and explicit full-access permission mapping.
- Support Claude API reasoning effort, partial output and explicit bypass; keep incomplete token accounting unknown and isolate child results from root completion.
- Add native version/login preflight checks within the execution deadline, Codex credential-store selection, and protected Claude subscription shell startup.
- Keep subscription costs unknown, inherit standard proxy variables with redaction, and compare native workspaces using resolved paths.
- Codex and Claude adapter versions are now 3; recreate older plans. Default Claude subscription login now requires macOS shell isolation; other POSIX platforms must select an explicit authentication directory.
- Add an opt-in live smoke runner with randomized file input/output checks and redacted records; verify one real workspace-write call through each of the five built-in adapters on macOS.

## [0.1.0] - 2026-10-24

- Initial public source release with deterministic planning, metadata probes, and local CLI execution.
- Built-in Codex, Claude Code, and DeepSeek Harness adapters.
- Explicit authentication and permission profiles, redacted execution records, cancellation, and timeouts.
- Adapter extensions, directory snapshots, request schema, ESM exports, and TypeScript declarations.
- Portable fake-CLI tests and optional native integration checks.

This records the GitHub source release; npm availability is tracked separately.

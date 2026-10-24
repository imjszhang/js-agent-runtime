# Changelog

Changes are recorded by package version. Version numbers follow Semantic Versioning;
during 0.x development, breaking changes increment the minor version.

## [Unreleased]

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

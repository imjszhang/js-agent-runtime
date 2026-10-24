# js-agent-runtime

Provider-aware execution of local agent CLIs. Node.js 20 or newer; macOS/Linux for process-group isolation. ESM JavaScript and TypeScript declarations are shipped. No production dependencies, model SDK, implicit `.env` loading, CLI installation, or automatic upgrades.

The package owns execution, not benchmark scoring or deliverable workflows. Callers select and stage instructions, skills, sources and assets; collect artifacts; validate content; and manage review, versions and publication.

## Installation

```sh
npm install js-agent-runtime
```

The command above applies after the first npm publication. For a source checkout:

```sh
npm ci --ignore-scripts
npm run build
npm pack
```

Install the resulting `.tgz` from your consuming project. Install and authenticate the
selected agent CLI separately. This package is an ESM library, not a CLI executable.

Source: [GitHub](https://github.com/imjszhang/js-agent-runtime) ·
[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Release guide](RELEASING.md)

## API

```js
import { plan, probe, run } from 'js-agent-runtime';

const execution = plan({
  runId: 'article-attempt-001',
  workspace: '/absolute/path/to/staged-workspace',
  prompt: 'Read instructions.md and produce the requested draft here.',
  target: {
    name: 'writer',
    harness: { adapter: 'codex', executable: 'codex', permission: 'workspace-write' },
    backend: {
      auth: 'api-key', provider: 'custom', model: 'your-model',
      protocol: 'responses', baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
    },
  },
  timeoutMs: 600_000,
});

// Static by default. Explicit metadata commands do not request a model completion.
const readiness = await probe(execution, { checkExecutable: true });
if (!readiness.ok) throw new Error('Agent is not ready');

const controller = new AbortController();
const result = await run(execution, {
  signal: controller.signal,
  runDir: '/absolute/path/to/new/runtime-record-directory',
  resolveCredential: ref => process.env[ref],
  onEvent: event => { /* append your own event projection using event.sequence */ },
});
// result.status: completed | failed | cancelled | timed_out
```

`plan(request)` is synchronous and deterministic. It validates types, protocol/auth combinations and path relationships, then returns a serializable process plan and hash. It does not inspect files or credentials, start a process, write files or make network requests. A changed plan or changed adapter is rejected by `run`; call `plan` again for a deliberate change. Passing an invalid request throws. Runtime execution failures return a failed result.

`probe(plan, options)` is static unless `checkExecutable` and/or `checkLogin` is true. Metadata checks run the selected CLI's version/login-status command with a bounded output and timeout. Native login checks report only a verdict, never credentials or raw identity metadata. API keys are resolved only at execution. Static or metadata success does not establish provider/model compatibility or artifact quality.

`run(plan, options)` starts one non-interactive attempt. Credentials come from `resolveCredential(ref)` or, by default, the named variable in `process.env`; the runtime never loads `.env`. A selected CLI may load its own environment files (see DeepSeek below). Operational `env` overrides are explicit and credential/configuration variable names are rejected. Only a small operating-system environment allowlist is inherited. Native authentication paths belong in `backend`, not `env`.

`stateDir` is an optional new temporary directory outside the workspace. The default is an OS temporary path derived from run ID and workspace. It must not already exist and is removed when execution finishes. A crash can leave it behind; inspect and remove stale state explicitly before rerunning that same plan. Runtime never deletes a pre-existing state directory. Native authentication directories are never copied or cleaned up.

`runDir` is optional, new-only, and must not overlap the workspace or temporary state. It contains only redacted `plan.json`, `events.jsonl`, `stdout.log`, `stderr.log` and `result.json`, with restrictive file modes. Logs from native CLI internals remain in temporary state and are removed. Known credential values, encoded forms and common secret fields are redacted before callbacks or persistence. Callers should still supply only intended task data in prompts. A caller's credential-resolver exception is replaced by a generic diagnostic.

Events include `schemaVersion`, `runId`, `sequence`, `time`, `type` and `data`. Event types are `started`, `message`, `tool`, `usage`, `raw`, `diagnostic` and final statuses. Observer callbacks are invoked in sequence; observer failures terminate the attempt. Their final drain is bounded. Unknown native event types remain available as redacted raw events. Malformed JSON, a terminal failure, nonzero exit or missing terminal completion makes the run fail. Exit zero alone is not success.

Timeout/abort terminates the POSIX process group, allows a short grace period, then force-kills remaining descendants. A child that intentionally escapes its process group cannot be contained by this mechanism. Parent-process exit handlers also kill active groups. No automatic retry, provider fallback, privilege escalation, native session resume or publication occurs.

## Built-in compatibility

| Adapter | API auth | Native auth |
|---|---|---|
| `codex` | `protocol: responses` with explicit endpoint | `auth: chatgpt`, optional absolute `codexHome` |
| `claude-code` | `protocol: anthropic-messages` with explicit endpoint | `auth: claude-subscription` or explicit `auth: claude-config`, optional absolute `claudeConfigDir` |
| `deepseek-harness` | `protocol: anthropic-messages`, explicit endpoint and model | Not supported; API key only |

API backend fields: `auth`, `provider`, `model`, `protocol`, `baseURL`, `apiKeyEnv`; `reasoningEffort` is supported only by Codex. Native backends cannot include API provider fields. Claude's native default auth namespace preserves the real user HOME; explicitly setting `claudeConfigDir` selects that CLI namespace, including its Keychain behavior. Credentials remain owned by the native CLI. No code reads auth file contents.

`claude-config` deliberately lets Claude Code load its existing **user** settings, including authentication and endpoint configuration. By default runtime uses `--setting-sources user`, preserves the real HOME (also with a custom `claudeConfigDir`), and supplies no API credential or endpoint override. It never inspects, copies, hashes, or serializes user settings. `model: 'configured'` is a reserved sentinel for this auth mode: it omits `--model` so the CLI chooses its configured/default model. An explicit model string still works. The run's `responseModel` records the model reported by native init/response events; planning cannot determine it. User settings remain live CLI-owned inputs, so a plan hash does not freeze them.

```js
const localTarget = {
  name: 'local-claude',
  harness: { adapter: 'claude-code', executable: 'claude', permission: 'bypass' },
  backend: { auth: 'claude-config', model: 'configured' },
};
```

For `claude-code`, `permission: 'bypass'` is an explicit opt-in requiring `auth: 'claude-config'`, and becomes `--permission-mode bypassPermissions`. Codex and Claude API-key/subscription targets reject it during planning. It disables the adapter's shell sandbox and does **not** provide filesystem containment. Task workspace paths do not constrain what the CLI can read or write. Fixed tools, no session persistence, disabled hooks and an empty strict MCP configuration still apply. Config mode does not use `--bare`, `--safe-mode` or `--restricted`, which would prevent the intended local configuration. On Claude Code 2.1.296, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forcibly resets bypass to default even with explicit allowed tools. Consequently only `claude-config` plus `bypass` sets it to `0`; all other Claude combinations retain `1`. This opt-in also gives up that CLI subprocess environment scrubbing. It should be selected only for a task explicitly authorized to use the local CLI with bypass. DeepSeek has its own explicit bypass mapping below.

For `claude-config`, `probe({checkLogin:true})` asks the CLI for authentication status and accepts its `loggedIn=true` verdict without requiring an OAuth/provider label. The result does not expose raw identity metadata or claim that the endpoint is Anthropic, that credentials work remotely, or that the selected model is compatible. Those require an actual execution. Claude adapter version 2 includes this mode; regenerate older Claude execution plans before running them. Existing API/subscription profiles retain their defaults.

Codex native login uses an internal Responses provider pinned to `https://chatgpt.com/backend-api/codex` with `requires_openai_auth=true`. It does not override `openai_base_url` or provide an API key. Probe and execution share this route definition. Codex adapter version 2 fixes the previous API-endpoint routing of native-login attempts; old execution plans must be regenerated and failed attempts remain unchanged.

Custom endpoints must implement the adapter's real tool-capable protocol. A Chat Completions endpoint cannot automatically serve as a Responses or Messages endpoint. JSON Schema is provided under `js-agent-runtime/schema`; runtime validation is authoritative, including extension adapters and cross-path constraints.

Adapters use CLI-provided sandbox/permission controls; this package does not implement an OS container. Read-only profiles omit write/shell tools where applicable; workspace-write profiles retain native sandboxing and deny interactive escalation. Codex disables ancestor project root inference and sets the Git ceiling to the supplied workspace. Claude's default API/subscription profiles use restricted mode to confine file tools to working directories and fail closed if their configured shell sandbox is unavailable. The explicit Claude configuration/bypass exceptions are described above.

Project/user customizations, automatic skill discovery and unrelated integrations are disabled by default. Explicit `claude-config` loads user settings while still disabling hooks and MCP integrations for the task. Production consumers must put their approved instruction and skill material into the explicit prompt/workspace. The package does not interpret a project-specific skill catalog or enable arbitrary MCP servers.

CLI metadata was checked against Codex `0.163.0-alpha.10.2` and Claude Code `2.1.296`. Flags and native event formats are version-sensitive; use probes and a controlled smoke test after changing CLI versions. The test suite uses fake CLIs; a fake test pass is not evidence of a successful provider connection or finished content. A separate no-model Codex sandbox check verified a nested temporary workspace can write inside itself and cannot write its ancestor repository.

On 2026-10-19, one real host integration run using Codex adapter version 2, Codex CLI `0.163.0-alpha.10.2`, `gpt-6.1-sol`, and ChatGPT native login completed successfully (exit 0, 206,131 ms) and generated six text files. The host subsequently generated the preview. This verifies that single native-login file-generation run; it does not verify other providers or models. Content review and task-specific acceptance remain the host application's responsibility.

## Extensions and snapshots

`registerAdapter({ id, version, validate, plan, createParser, probeArgs? })` adds a trusted in-process adapter and returns an unregister function. Built-ins cannot be overwritten. An extension validates its own backend; its process plan still has to retain the requested workspace/prompt, and generated files must stay under temporary state. Adapter code is trusted executable code, not user-provided JSON. `runProcess` is exported for thin legacy bridges; it has no business-specific persistence or scoring.

`snapshotDirectory(root, { exclude?, maxFiles?, maxBytes? })` returns a deterministic file/hash/size/mode inventory. It refuses symlinks and special files and skips `.git`, `node_modules` and `.env*`. This is a generic local inventory, not artifact acceptance. `sha256`, `hashObject` and `stableStringify` support frozen input manifests.

## Development and distribution

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack
```

An optional `npm run test:sandbox` invokes the installed Codex sandbox in temporary fake repositories (API and native-login plans, read-only and workspace-write). It never requests a model or reads credentials. It is intentionally separate from the portable fake test suite.

Portable tests cover strict validation, auth isolation, all built-in routes using fake agents, terminal parsing, redaction, observer errors, output limits, timeout/cancel and child cleanup, extension registration, snapshots and metadata probes. Config-mode regressions verify that planning performs no configuration reads, native settings remain unchanged, the configured model is inherited and its actual init value recorded, bypass arguments/scrub behavior are explicit, Codex and Claude API/subscription targets reject bypass, and native auth directories cannot overlap the workspace. Build produces `dist/*.js` and `dist/*.d.ts`; npm packages include only dist, schema, examples and documentation. Consumers should pin a package version or verified tarball; a local source link is for development only. No registry publication is performed by these commands.


### Native project context for Claude Code

Set `harness.contextMode: 'project'` with `auth: 'claude-config'`, and pass the actual project root as `RunRequest.workspace`. The default (`snapshot` or omitted) retains the prior restricted skill-discovery behavior. Project mode enables the native `Skill` tool, removes `--disable-slash-commands`, and selects `--setting-sources user,project,local`. Claude discovers `.claude/skills` and its native instructions from the requested working directory; it reads other project files on demand. This does not put the whole repository into the prompt. Native built-in/user-plugin skills may also be available; this option is not a project-only skill allowlist.

Permission selection remains independent: `bypass` still maps to `bypassPermissions` and provides no filesystem containment. Hooks remain disabled, MCP remains empty/strict, and sessions are not persisted. Native skill files and user/project settings remain live inputs, not frozen by the plan hash. Callers must capture provenance and control output placement. Only project mode allows a new `runDir` strictly below the workspace; equal/ancestor paths and state-directory overlap remain prohibited. Logs in the project are accessible to the agent, so they are audit records, not tamper-proof evidence.

The production host can keep frozen input snapshots and staging outside the final delivery directory while using the project root as cwd. No project-specific staging, review or publishing behavior is implemented in this public package.

### DeepSeek Harness

Use adapter `deepseek-harness` with an installed `dsh` executable (or its absolute path), an explicit API backend and model; see [example](examples/deepseek-api.json). The integration is based on js-llmlab's native adapter and verified against DSH `0.2.0-rc.2`. Nothing installs or upgrades the CLI automatically. Endpoint, provider name, model and credential reference are independent. DSH's internal `deepseek-official` registry name does not constrain the provider name in your target. Set the Messages **root** (for example `https://api.deepseek.com/anthropic`); DSH appends `/v1/messages`. Other services must accept DSH's tool calls and DeepSeek request extensions; generic Messages compatibility alone is not a guarantee. Native account login, `model: configured` and `reasoningEffort` are not supported.

The adapter runs `dsh --profile headless --patch <temporary-config> --json -`, passing the prompt over stdin. An isolated HOME/DSH_HOME and an explicit profile load only the shipped base/headless bundles; account authentication, alternate model routes, telemetry, plugin installation, web tools and delegation are disabled. The key is resolved only at run time into `JS_AGENT_RUNTIME_API_KEY`, never into configuration files. DSH itself may load cwd `.env` values; inherited values take precedence, its bootstrap variables are forbidden there, and the adapter pins endpoint, model and credential variable. Runtime does not read, copy or validate those files. Use a staged workspace if project environment loading is unwanted.

With `contextMode: project`, pass the real project root as `workspace`. DSH loads `AGENTS.md`/`CLAUDE.md` and local overlays at that root and applicable subdirectories; an empty `projectRootMarkers` list prevents walking into parent projects. `.agents/skills` is the only native skill root; personal/default skill roots are disabled. With default `snapshot` mode, automatic project instructions are disabled, while staged `.agents/skills` remains available. The caller still supplies selected rules and task inputs. Live project files are read on demand and are not frozen by a plan hash.

`read-only` denies filesystem mutations and removes shell tools. `workspace-write` uses DSH's native filesystem and shell sandbox, permitting writes within the workspace and platform temporary directories. `bypass` explicitly maps to `danger-full-access` with no filesystem containment. All modes set approval to `never`; bypass is never selected as a fallback. Shell sandbox availability is platform dependent and failures remain failures. Read access and network access are not confined by these write permissions. DSH gets a default 4000 ms shutdown grace for its managed shells; callers may override `terminationGraceMs`.

Successful execution requires a session ID, a completed `turn_end`, a final answer and exit zero, with no malformed, duplicate or trailing terminal events. Usage sums each unique step once (including cache reads/writes); incomplete usage stays unknown. Cost and responding model identity remain `null`, since the native projection does not report them.

`npm run test:deepseek-native` runs a real installed CLI against a loopback mock Messages server with a fake key and temporary files; it does not call a paid provider. Set `JS_AGENT_RUNTIME_DSH_EXECUTABLE` to select an explicit executable. This optional check is separate from portable tests and does not establish real provider/model availability.

## License

[MIT](LICENSE) © 2026 imjszhang.

# js-agent-runtime

[English](README.md) | 简体中文

**通过 JavaScript 或 TypeScript 调用 Codex、Claude Code、DeepSeek Harness、OpenCode V2 和 Cursor Agent。**

这是一个 Node.js 库，用统一的 `plan → probe → run` API 执行本机 AI 编程 Agent CLI。选择 Agent 及其支持的认证方式，指定工作区和任务，即可接收结构化事件和经过校验的执行结果。

[npm](https://www.npmjs.com/package/js-agent-runtime) · [快速上手](#快速上手) · [支持的 Agent](#支持的-agent) · [平台支持](#平台支持与验证) · [API 参考](#api) · [变更记录](CHANGELOG.md)

## 为什么使用 js-agent-runtime？

当 Node.js 应用需要调用已安装的编程 Agent 时，可以使用本库，例如开发工具、后台任务执行器、文件生成流程，或用于比较不同 Agent 执行结果的测试工具。

- **五种 Agent，一套执行接口。** 统一接入执行计划、就绪检查、流式事件和最终结果，各适配器负责对应 CLI 的参数及原生输出格式。
- **明确的认证和服务路由。** 使用受支持的 API 端点或已有原生登录。运行时在执行前校验适配器的协议与认证组合。
- **执行控制和记录。** 设置超时，通过 `AbortSignal` 取消，限制输出大小，并按需保存脱敏后的计划、事件和结果。
- **不只依赖退出码判断完成。** 适配器要求原生 CLI 给出任务完成证据；缺失的用量或费用保持未知，不进行推算补全。

Node.js **20+** · **ESM** · **TypeScript 类型声明** · **零生产依赖** · **MIT**

本库负责执行已有 Agent CLI，CLI 的安装和认证需单独完成。任务编排、重试、产物验证和发布由应用负责；权限与沙箱能力取决于选用的 CLI 和平台。

## 支持的 Agent

| Agent Harness | `harness.adapter` | 认证方式 | 配置示例 |
|---|---|---|---|
| **Codex CLI** | `codex` | API Key（Responses 协议）；ChatGPT 登录 | [API](examples/codex-api.json) · [原生登录](examples/native-login.json) |
| **Claude Code** | `claude-code` | API Key（Anthropic Messages 协议）；Claude 订阅；已有用户配置 | [API](examples/claude-api.json) · [用户配置](examples/claude-config.json) |
| **DeepSeek Harness（DSH）** | `deepseek-harness` | API Key（Anthropic Messages 协议） | [API](examples/deepseek-api.json) |
| **OpenCode V2** | `opencode` | API Key（Chat Completions 协议） | [API](examples/opencode-api.json) |
| **Cursor Agent** | `cursor-agent` | Cursor API Key；macOS 原生登录；Windows 原生登录需显式启用 | [API](examples/cursor-api.json) · [原生登录](examples/cursor-login.json) |

需要同时选择适配器**及与其兼容的后端**。仅替换适配器名称，并不能让认证、模型 ID 或协议互换。Cursor 使用自身原生服务；不支持 OpenCode V1。具体要求及 CLI 版本约束见[兼容性说明](#兼容性说明)。

其他 Harness 可通过 [`registerAdapter()`](#扩展与快照) 实现受信任的适配器。

## 安装

```sh
npm install js-agent-runtime
```

请单独安装并认证所选 Agent CLI。本包是 ESM 库；将示例保存为 `.mjs`，或在项目中设置 `"type": "module"`。仓库开发环境配置见[开发与分发](#开发与分发)。

源码：[GitHub](https://github.com/imjszhang/js-agent-runtime) ·
[变更记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [发布指南](RELEASING.md)

## 快速上手

下面使用**已有 ChatGPT 登录的 Codex CLI**，在新建的临时工作区执行任务。此示例会发起真实模型调用，并要求 Agent 创建文件。

前提条件：Node.js 20+，PATH 中已有安装并登录的 Codex CLI，以及该账号可用的模型。示例默认使用已记录的 macOS 冒烟测试中的 `gpt-6.1-sol`；可通过 `CODEX_MODEL` 选择其他模型。在 Windows 上，可执行文件必须是原生 `.exe`，详见[平台支持](#平台支持与验证)。

保存为 `run-agent.mjs`：

```js
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, probe, run } from 'js-agent-runtime';

const workspace = await mkdtemp(join(tmpdir(), 'agent-demo-'));
const execution = plan({
  runId: randomUUID(),
  workspace,
  prompt: 'Create hello.txt containing "Hello from Codex" in this workspace.',
  target: {
    name: 'local-codex',
    harness: {
      adapter: 'codex',
      executable: 'codex', // Windows 上请使用已安装的原生可执行文件路径。
      permission: 'workspace-write',
    },
    backend: {
      auth: 'chatgpt',
      model: process.env.CODEX_MODEL ?? 'gpt-6.1-sol',
    },
  },
  timeoutMs: 120_000,
});

const readiness = await probe(execution, {
  checkExecutable: true,
  checkLogin: true,
});
if (!readiness.ok) {
  console.error(readiness.checks);
  process.exit(1);
}

const result = await run(execution);
console.log({ status: result.status, text: result.text, workspace });
if (result.status !== 'completed') {
  console.error(result.error);
  process.exitCode = 1;
}
```

```sh
node run-agent.mjs
```

生成的文件会保留在输出的工作区路径中。`completed` 表示通过了适配器的执行检查；仍需按应用要求检查和验证文件。仅通过元数据检查并不能证明远程服务可访问。

API Key、自定义端点、取消、事件回调和持久化记录见 [API 示例](#api)。使用其他 Agent 时，可从[支持列表](#支持的-agent)中的配置示例开始。

## 平台支持与验证

支持能力与真实服务验证是两回事。以下是 **0.2.2** 的已记录验证范围，不代表所有 CLI 版本、服务商、模型或权限模式都可用。

| 平台 | 已验证范围 |
|---|---|
| **macOS** | 五种适配器各通过一次真实 `workspace-write` 调用，包括文件读写和输出校验。 |
| **Linux** | Node 20 / 22 / 24 的自动化测试和安装包检查。此处尚无真实服务调用记录。 |
| **Windows** | Node 22 / 24 的自动化测试和安装包检查；一次 `claude-config` + `bypass` 的 Claude Code 真实调用。Cursor 原生启动集成使用模拟 CLI，shell 测试执行真实 Windows PowerShell。 |

**Cursor Agent 在 Windows 上的真实服务调用尚未验证。** Windows 需要原生可执行文件，而非 `.cmd` / `.bat` 启动器，进程树终止也存在限制。`bypass` 不提供文件系统隔离。选择部署配置前，请阅读 [Windows 说明](#windows)和[真实调用验证记录](#真实调用验证)。

## API

下面展示显式 API 路由、取消、事件处理和可选执行记录。请替换端点、模型和绝对路径；工作区必须已经存在，记录目录必须是尚不存在的新目录。

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

// 默认为静态检查。显式执行的元数据命令不会请求模型补全。
const readiness = await probe(execution, { checkExecutable: true });
if (!readiness.ok) throw new Error('Agent is not ready');

const controller = new AbortController();
const result = await run(execution, {
  signal: controller.signal,
  runDir: '/absolute/path/to/new/runtime-record-directory',
  resolveCredential: ref => process.env[ref],
  onEvent: event => { /* 可利用 event.sequence 追加自己的事件记录 */ },
});
// result.status: completed | failed | cancelled | timed_out
```

`plan(request)` 是同步且确定性的函数。它校验类型、协议与认证组合以及路径关系，然后返回可序列化的进程计划和哈希。它不会检查文件或凭据，不会启动进程、写入文件或发起网络请求。如果计划或适配器发生变化，`run` 会拒绝执行；需要变更时应重新调用 `plan`。无效请求会抛出异常，运行期间的执行失败则返回失败结果。

除非 `checkExecutable` 和／或 `checkLogin` 为 true，否则 `probe(plan, options)` 仅做静态检查。元数据检查会执行所选 CLI 的版本或登录状态命令，并限制输出大小和执行时间。原生登录检查只报告判断结果，不返回凭据或原始身份信息。API Key 仅在执行时解析。静态或元数据检查成功，不代表服务商／模型兼容或产物质量合格。

`run(plan, options)` 启动一次非交互执行。凭据来自 `resolveCredential(ref)`，默认读取 `process.env` 中对应名称的变量；运行时从不加载 `.env`。所选 CLI 可能自行加载环境文件，见下文 DeepSeek 说明。运行环境的 `env` 覆盖必须显式提供，不允许覆盖凭据或配置类变量。继承范围仅包括少量操作系统环境变量白名单，以及 HTTP/HTTPS/ALL/NO_PROXY 的八个标准大小写代理变量。包含凭据的代理 URL 会脱敏；可通过运行选项 `env` 显式覆盖标准代理值。原生认证路径应配置在 `backend`，而不是 `env` 中。内置适配器首先在不传入 API 凭据的情况下检查 CLI 版本，再为 ChatGPT、Claude 订阅和 Cursor 登录目标确认原生登录状态。这些检查、凭据解析、任务执行及 OpenCode 会话检查共用 `timeoutMs`；检查失败不会回退到其他认证方式。`plan()` 和静态 `probe()` 始终不会启动进程。

`stateDir` 是工作区外可选的新临时目录，默认使用由运行 ID 和工作区推导出的操作系统临时路径。该目录必须尚不存在，执行结束后会被删除。崩溃可能留下临时状态；重新执行同一计划前，需要显式检查并删除旧状态。运行时不会删除预先存在的状态目录，也不会复制或清理原生认证目录。

`runDir` 是可选的新记录目录，必须尚不存在，且不能与工作区或临时状态目录重叠。目录只包含脱敏后的 `plan.json`、`events.jsonl`、`stdout.log`、`stderr.log` 和 `result.json`，并采用受限文件权限。原生 CLI 的内部日志保留在临时状态中，随后删除。已知凭据值、编码形式和常见敏感字段会在回调或持久化之前脱敏。调用方仍应只在提示词中提供任务需要的数据。凭据解析器抛出的异常会被替换成通用诊断信息。

事件包含 `schemaVersion`、`runId`、`sequence`、`time`、`type` 和 `data`。事件类型包括 `started`、`message`、`tool`、`usage`、`raw`、`diagnostic` 以及最终状态。观察者回调按顺序调用，回调失败会终止本次执行；收尾等待也有时间上限。未知的原生事件类型仍会作为脱敏后的原始事件提供。JSON 格式错误、任务失败的终结事件、非零退出码或缺失终结完成事件，都会使执行失败。仅退出码为零不代表成功。Claude 的部分消息以 message/tool 事件流式提供；子 Agent 的结果不能完成或替换主任务响应，主任务终结结果之后若继续产生主任务输出，也会判为失败。已经观察到输出时，原生零 token 占位值不会被当作完整用量。

超时或取消会终止 POSIX 进程组，等待短暂宽限期后强制结束剩余后代进程。主动脱离进程组的子进程无法由此机制约束。父进程退出处理器也会终止活动进程组。本库不会自动重试、回退服务商、提升权限、恢复原生会话或发布产物。

### Windows

`run()` 和带元数据检查的 `probe()` 也支持原生 Windows。Windows 的控制台子进程没有进程组，因此进程约束弱于 POSIX：

- 没有优雅终止阶段。超时、取消、输出超限或父进程退出时，会通过 `taskkill /T /F` 立即结束整个进程树；由于 Windows 很快会复用进程 ID，只在根进程仍运行时执行。这里的进程树依据 Windows 记录的父子关系，不是操作系统强制维护的进程组。
- 根进程退出后仍存活的后代进程不会被终止，也无法被约束。根进程正常退出后，管道会在宽限期结束时关闭；Agent 工具启动的后台进程可能继续运行。
- `harness.executable`（以及扩展适配器计划中的可执行文件）必须是原生可执行文件。规划阶段拒绝 `.cmd` 和 `.bat` 启动器，因为 Windows 必须通过 `cmd.exe` 启动它们，而运行时不会使用 shell。npm 安装的 CLI 通常使用 `.cmd` 垫片，请将目标指向垫片实际启动的原生 `.exe`。
- 路径重叠检查与 Windows 一致，不区分大小写。Windows 上的 Node 不会收到 `SIGTERM`；`exit` 和 `SIGINT` 处理器仍会结束活动进程树。
- Claude Code 的 shell 沙箱在原生 Windows 上不可用，因此使用 `workspace-write` 的 `claude-code` 目标要求沙箱并设置 `failIfUnavailable`，预期会拒绝执行。需要 shell 的任务可通过 `api-key` 或 `claude-config` 显式使用 `bypass`，但不提供文件系统隔离。Claude 默认订阅隔离仍仅支持 macOS。Codex、DeepSeek Harness 和 OpenCode 的沙箱尚未在 Windows 验证。Cursor Agent 可在 `harness.executable` 指向版本目录的 `node.exe` 时运行，不接受 `agent.cmd` 垫片。其 shell 边界是在 PATH 前端放置一个小型 `powershell.exe`，清理凭据类变量，将工具的主目录／应用数据目录重设为临时状态，并禁用配置文件后运行 Windows PowerShell。通过绝对路径启动的 shell 无法被该机制拦截。

## 兼容性说明

[Agent 概览](#支持的-agent)列出了支持的认证方式和示例。以下说明协议、权限和版本要求。

API 后端字段包括 `auth`、`provider`、`model`、`protocol`、`baseURL` 和 `apiKeyEnv`；`reasoningEffort` 支持 Codex 的现有取值，以及 Claude Code API 的 `low`、`high`、`max`（通过 `--effort` 传入）。Claude 原生模式、DeepSeek、OpenCode 和 Cursor 均不支持该字段。原生后端不能包含 API 服务商字段。Claude 原生默认认证命名空间保留真实用户 HOME；显式设置 `claudeConfigDir` 会选择该 CLI 命名空间，包括对应 Keychain 行为。凭据始终由原生 CLI 管理，本库不读取认证文件内容。认证目录环境变量不会隐式继承，需通过对应后端字段显式提供。Claude 订阅执行要求 CLI 2.1.296 或更新版本，且登录元数据匹配 `claude.ai`／第一方服务。默认命名空间使用受保护的 macOS shell 包装程序，阻止通过绝对路径读取用户启动文件；其他平台需要显式指定 `claudeConfigDir`。Claude 订阅和 ChatGPT 的费用保持为 `null`；原生 token 价格估算不等于订阅账单。

`claude-config` 会有意允许 Claude Code 加载已有的**用户设置**，包括认证和端点配置。默认使用 `--setting-sources user`，保留真实 HOME（自定义 `claudeConfigDir` 时同样如此），且不覆盖 API 凭据或端点。它不会检查、复制、计算哈希或序列化用户设置。`model: 'configured'` 是此认证模式的保留值：省略 `--model`，让 CLI 使用已配置／默认模型；也可以显式指定模型字符串。执行结果中的 `responseModel` 记录原生 init/response 事件报告的模型，规划阶段无法确定。用户设置仍是由 CLI 管理的实时输入，不会被计划哈希冻结。

```js
const localTarget = {
  name: 'local-claude',
  harness: { adapter: 'claude-code', executable: 'claude', permission: 'bypass' },
  backend: { auth: 'claude-config', model: 'configured' },
};
```

对于 `claude-code`，`permission: 'bypass'` 是显式启用项，支持 `api-key` 和 `claude-config`，订阅目标仍会拒绝。它映射为 `--permission-mode bypassPermissions`，关闭 shell 沙箱，不提供文件系统隔离；工作区不会限制 CLI 的读写范围。固定工具集合、禁用 hooks、不持久化会话以及空的严格 MCP 配置仍生效。配置模式和 API bypass 模式省略 `--safe-mode`／`--restricted`，API 认证仍保留 `--bare`。在已审查的 Claude Code 版本中，`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` 会将 bypass 重置为默认模式，因此显式 bypass 使用 `0`，放弃该子进程环境清理。运行时不会自动选择 bypass。DeepSeek 和 Cursor 的显式 bypass 映射见下文。

对于 `claude-config`，`probe(plan, {checkLogin:true})` 会询问 CLI 的认证状态，接受 `loggedIn=true` 的判断，不要求 OAuth／服务商标签。结果不会暴露原始身份信息，也不表明端点一定是 Anthropic、凭据可用于远程服务或所选模型兼容；这些都需要真实执行验证。Claude 适配器版本 3 增加 API effort／部分消息支持、显式 API bypass 和订阅 shell 包装程序。Codex 适配器版本 3 增加凭据存储选择和订阅代理隔离。执行旧计划前应重新生成计划。

Codex 原生登录使用固定指向 `https://chatgpt.com/backend-api/codex` 的内部 Responses 服务商，并设置 `requires_openai_auth=true`。它不会覆盖 `openai_base_url` 或提供 API Key，探测与执行共用该路由定义。Codex 适配器版本 2 修复了原生登录执行原先被路由到 API 端点的问题；旧执行计划必须重新生成，既有失败记录保持不变。

自定义端点必须实现适配器实际使用且支持工具调用的协议。Chat Completions 端点不会自动成为 Responses 或 Messages 端点。JSON Schema 可通过 `js-agent-runtime/schema` 获取；实际校验以运行时为准，包括扩展适配器和跨路径约束。

适配器使用 CLI 提供的沙箱／权限控制，本包不实现操作系统容器。只读配置会在适用时移除写入／shell 工具；工作区写入配置保留原生沙箱，并拒绝交互式提权。Codex 禁止向祖先目录推断项目根目录，并将 Git 向上查找的边界设为指定工作区。Claude 的非 bypass API／订阅配置使用 restricted 模式，将文件工具限制在工作目录内；所配置的 shell 沙箱不可用时会拒绝执行。Claude 显式配置／bypass 的例外见上文。

默认禁用项目／用户自定义、自动技能发现和无关集成。显式 `claude-config` 会加载用户设置，但任务期间仍禁用 hooks 和 MCP 集成。生产环境调用方必须将获准使用的指令及技能材料放入明确的提示词／工作区。本包不会解释某个项目专有的技能目录，也不会启用任意 MCP 服务。Cursor 的原生上下文及远程扩展限制见下文。

CLI 元数据已针对 Codex `0.163.0-alpha.10.2` 和 Claude Code `2.1.296` 检查。命令行参数与原生事件格式对版本敏感；更换 CLI 版本后，应运行探测和受控冒烟测试。测试套件使用模拟 CLI，通过模拟测试并不代表真实服务连接成功或内容已完成。另有一次不调用模型的 Codex 沙箱检查，验证了嵌套临时工作区可以写入自身，但无法写入祖先仓库。

2026-10-19，一次宿主真实集成运行使用 Codex 适配器版本 2、Codex CLI `0.163.0-alpha.10.2`、`gpt-6.1-sol` 和 ChatGPT 原生登录，成功完成执行（退出码 0，用时 206,131 毫秒），生成六个文本文件，随后由宿主生成预览。这只验证了该次原生登录文件生成任务，不代表其他服务商或模型已验证。内容审查和任务验收仍由宿主应用负责。

## 扩展与快照

`registerAdapter({ id, version, validate, plan, createParser, probeArgs? })` 注册一个受信任的进程内适配器，并返回注销函数。内置适配器不能被覆盖。扩展自行校验其后端；进程计划仍必须保留请求中的工作区／提示词，生成文件也必须位于临时状态目录内。适配器代码是受信任的可执行代码，不能把用户提供的 JSON 当作适配器。执行期间，`createParser(request?)` 会收到工作目录已经解析的请求，现有零参数解析器仍兼容。自定义适配器不继承内置的版本／登录检查。导出的 `runProcess` 可用于简单的旧系统桥接，不包含业务专有的持久化或评分逻辑。

`snapshotDirectory(root, { exclude?, maxFiles?, maxBytes? })` 返回确定性的文件／哈希／大小／权限清单。它拒绝符号链接和特殊文件，并跳过 `.git`、`node_modules` 和 `.env*`。这是通用的本地文件清单，不是产物验收。`sha256`、`hashObject` 和 `stableStringify` 可用于生成冻结输入清单。

## Agent 专项配置

### Claude Code 原生项目上下文

结合 `auth: 'claude-config'` 设置 `harness.contextMode: 'project'`，并将真实项目根目录作为 `RunRequest.workspace` 传入。默认模式（`snapshot` 或省略）保留原有的受限技能发现行为。项目模式启用原生 `Skill` 工具，移除 `--disable-slash-commands`，并使用 `--setting-sources user,project,local`。Claude 从指定工作目录发现 `.claude/skills` 及其原生指令，按需读取其他项目文件，并不会把整个仓库直接放入提示词。原生内置／用户插件技能也可能可用；该选项并不是只允许项目技能的白名单。

权限选择独立生效：`bypass` 仍映射为 `bypassPermissions`，不提供文件系统隔离。Hooks 保持禁用，MCP 保持空配置和严格模式，会话不持久化。原生技能文件以及用户／项目设置仍是实时输入，不会被计划哈希冻结。调用方必须记录来源并控制输出位置。仅项目模式允许在工作区的严格子目录中创建新的 `runDir`；仍禁止与工作区同路径、位于其祖先路径或与状态目录重叠。Agent 可以访问项目内的日志，因此它们是审计记录，不是防篡改证据。

生产宿主可以在最终交付目录外保留冻结的输入快照和暂存区，同时将项目根目录用作 cwd。本公共包不实现项目专有的暂存、审查或发布流程。

### DeepSeek Harness

使用适配器 `deepseek-harness`、已安装的 `dsh` 可执行文件（或其绝对路径），并显式指定 API 后端和模型，见[示例](examples/deepseek-api.json)。集成基于 js-llmlab 的原生适配器，已针对 DSH `0.2.0-rc.2` 验证，不会自动安装或升级 CLI。端点、服务商名称、模型和凭据引用彼此独立；DSH 内部的 `deepseek-official` 注册名称不会限制目标中的服务商名称。请设置 Messages **根地址**，例如 `https://api.deepseek.com/anthropic`，DSH 会追加 `/v1/messages`。其他服务必须接受 DSH 的工具调用和 DeepSeek 请求扩展；仅通用 Messages 兼容并不足以保证可用。不支持原生账号登录、`model: configured` 或 `reasoningEffort`。

适配器执行 `dsh --profile headless --patch <temporary-config> --json -`，通过 stdin 传入提示词。隔离的 HOME/DSH_HOME 和显式 profile 只加载随 CLI 提供的 base/headless bundle；禁用账号认证、其他模型路由、遥测、插件安装、网页工具和任务委派。Key 仅在运行时解析到 `JS_AGENT_RUNTIME_API_KEY`，不会写入配置文件。DSH 自身可能加载 cwd 中的 `.env`，继承的变量优先；其引导变量不允许在该文件中设置，适配器也固定了端点、模型和凭据变量。运行时不会读取、复制或校验这些文件。如不希望加载项目环境，应使用独立的暂存工作区。

使用 `contextMode: project` 时，将真实项目根目录作为 `workspace`。DSH 加载该根目录及适用子目录中的 `AGENTS.md`／`CLAUDE.md` 和本地覆盖配置；空的 `projectRootMarkers` 列表阻止其向上遍历到父项目。`.agents/skills` 是唯一的原生技能根目录，个人／默认技能根目录被禁用。在默认 `snapshot` 模式下，自动项目指令被禁用，但暂存的 `.agents/skills` 仍可使用。调用方仍需提供选定的规则和任务输入。实时项目文件按需读取，不会被计划哈希冻结。

`read-only` 拒绝文件系统修改并移除 shell 工具。`workspace-write` 使用 DSH 的原生文件系统和 shell 沙箱，允许写入工作区及平台临时目录。`bypass` 显式映射为 `danger-full-access`，不提供文件系统隔离。所有模式均将审批设置为 `never`，不会回退到 bypass。Shell 沙箱可用性依赖平台，失败不会被自动绕过。这些写入权限不限制读取和网络访问。DSH 管理的 shell 默认有 4000 毫秒终止宽限期，可通过 `terminationGraceMs` 覆盖。

成功执行必须具备会话 ID、已完成的 `turn_end`、最终回答和零退出码，且不能有格式错误、重复或终结后追加的终结事件。用量按唯一步骤累加一次，包括缓存读写；不完整用量保持未知。原生输出不报告费用和实际响应模型身份，因此对应字段保持 `null`。

`npm run test:deepseek-native` 使用真实安装的 CLI、模拟 Key 和临时文件，连接本机回环地址上的模拟 Messages 服务，不调用付费服务商。通过 `JS_AGENT_RUNTIME_DSH_EXECUTABLE` 可指定可执行文件。该可选检查独立于可移植测试，不能证明真实服务商／模型可用。

### OpenCode V2

使用 `adapter: 'opencode'`、已安装的 `opencode` 可执行文件，以及 `protocol: 'chat-completions'` 的 API 后端，见[示例](examples/opencode-api.json)。适配器沿用 js-llmlab 对 `@opencode/cli` V2 的集成，已审查版本为 2.0.32，版本检查会拒绝 V1。它运行 `run --standalone --format json` 并启动私有的临时原生服务。HOME、XDG 目录和配置均与宿主隔离，禁用项目配置和自动模型拉取；受信任的本地 shell hook 通过将变量设为 `undefined` 标记来移除继承的凭据。工具权限不等同于操作系统沙箱。仅支持 `read-only` 和 `workspace-write`。

报告成功前，运行时会在相同的隔离状态中执行不带凭据的 `session export --standalone`，核对会话、服务商／模型、工作区、完整提示词、助手消息及原生任务成功终结结果。这可弥补 V2 因竞态而缺失最终流式事件的情况，但不能挽救格式错误的输出、原生错误或无效会话。导出过程共用任务截止时间和输出上限。用量来自导出的累计 token：输入包括缓存读写，输出包括推理。统计不完整或涉及委派时，用量保持未知；`cost` 和 `responseModel` 为 `null`。

### Cursor Agent

使用 `adapter: 'cursor-agent'`、独立安装的 `cursor-agent` CLI，以及 `{auth: 'cursor-login', model}` 或 `{auth: 'cursor-api-key', model, apiKeyEnv?}`。Cursor 使用自身原生服务，因此拒绝 provider/protocol/baseURL 字段；默认 Key 引用是 `CURSOR_API_KEY`。参见 [API 示例](examples/cursor-api.json)和[原生登录示例](examples/cursor-login.json)。原生登录支持 macOS Keychain；在 Windows 上，设置 `useCurrentUserHomeForLogin` 后可使用用户配置目录中的凭据文件。API Key 使用隔离的内存凭据存储。本库不执行登录／登出，也不复制凭据。在 Windows 上，`harness.executable` 必须指向版本目录的 `node.exe`，由适配器传入同目录的 `index.js`，不能指向 `agent.cmd`。

已审查的构建为 `2026.07.23-e383d2b` 和 `2026.10.22-27dcf5f`。Cursor 适配器版本 2 增加后一构建及 Windows 执行支持，旧计划需要重新生成。版本探测使用原始 CLI、隔离 HOME，且不传 Key 或预加载程序。登录状态确认的是凭据存在，不是订阅使用权限。所有执行都会拒绝工作区根目录中存在 `.cursor` 条目的情况。成功结果要求初始化会话、工作区／认证来源匹配，存在一个成功终结结果，并正常退出。原生用量可能含有生成的零占位值或遗漏重试，init 模型只是显示标签，因此汇总的 `usage`、`cost` 和 `responseModel` 保持 `null`。

标准权限使用明确工具集合并启用原生沙箱，只读权限使用 ask 模式。POSIX 上受信任的 bash/zsh 包装程序跳过启动文件，移除工具凭据，同时保留标准代理变量。Windows 上将 `powershell.exe` 和 `pwsh.exe` 垫片置于 PATH 前端，清理凭据类变量，将 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOMEDRIVE` 和 `HOMEPATH` 重设为临时状态，并通过 `-NoProfile` 运行 Windows PowerShell。父级 Cursor 登录进程保留显式选择的用户目录。传入 PowerShell 的参数会保留反斜杠、引号和 Unicode。Node 无法在不借助 shell 的情况下启动 `.cmd` 垫片，因此这里使用原生可执行文件，但仍无法拦截 CLI 通过绝对路径启动的 shell。`permission: 'bypass'` 显式使用 `--force` 并禁用沙箱，保留原生 shell/PATH，不提供文件系统隔离。任何模式都不会自动批准 MCP。原生账号／团队插件、hooks、托管技能和祖先上下文仍可能被加载。文件读取工具并未统一受 shell 沙箱约束，因此不保证读取仅限工作区。

Cursor 专用的可选 harness 字段：

- `useHttp1ForAgent: true` 选择原生 HTTP/1.1 传输设置。
- `useCurrentUserHomeForLogin: true` 为原生登录进程保留用户 HOME；配置／数据／缓存和标准工具 shell 仍保持隔离。API Key 和版本探测始终使用隔离 HOME。
- `nativeStallTimeoutMs` 接受 30,000–300,000 毫秒。此兼容性预加载功能需要显式启用，且只在核对入口文件名、完整 bundle SHA-256 和替换锚点后，修改 `2026.07.23-e383d2b` 的默认停滞超时。它不是官方 CLI 选项，不会修改安装文件。如果不匹配（包括 `2026.10.22-27dcf5f` bundle），会拒绝执行。预加载程序会在工具运行前移除自身，也不会延长任务总截止时间。

Cursor 在规划 shell 包装程序时捕获启动 PATH；元数据检查和执行都使用该 PATH，因此 `options.env.PATH` 不会替换它。PATH 变化后需要重新生成计划。Cursor 和 OpenCode 与 DeepSeek 一样，默认使用 4,000 毫秒终止宽限期，可通过 `terminationGraceMs` 覆盖。可移植测试使用模拟 CLI 和本地测试数据；真实服务验证单独执行，见下文。

Windows 垫片源码位于 `src/cursor-shell-win.cs`；在 Windows 上使用 `npm run build:cursor-shell:win`（.NET Framework 编译器），或在 macOS/Linux 上使用 `npm run build:cursor-shell:win -- --docker` 重建内嵌可执行文件。Docker 构建使用官方 Mono 镜像，仅挂载临时源码／输出目录。源码变更应与生成的 `src/cursor-shell-win-exe.ts` 一起提交。`npm run check:cursor-shell`（也包含在 `npm run check` 中）校验规范化源码哈希和内嵌二进制哈希；它检查生成快照是否过期，不验证编译是否可复现。Windows 测试通过真实 PowerShell 执行随包提供的垫片，验证参数、禁用配置文件和工具目录隔离。Windows Cursor 的真实服务调用仍未验证。

## 真实调用验证

`npm run test:live -- --config /absolute/path/to/targets.json --output /absolute/path/to/new-check-directory` 会发起真实模型调用。配置格式为 `{ "targets": [/* Target objects */], "timeoutMs": 180000 }`；输出目录必须尚不存在，其父目录必须已经存在。请提供已安装的可执行文件路径、原生登录，或对应名称的 API Key 环境变量。脚本不会加载 `.env` 或安装 CLI。

每个目标执行一次独立尝试，最多三个目标并发，不自动重试或回退。元数据检查后，原生 Agent 必须读取随机生成的 `input.json`，写出含相同随机值及正确整数和的 `result.json`，并报告最终标记。宿主检查文件内容和原始输入哈希，不执行 Agent 生成的代码。`summary.json` 记录 CLI 版本、认证模式、请求／报告的模型、耗时、工具事件、退出状态、产物哈希和验证结果；每次执行的脱敏运行记录保存在 `logs/`。失败执行也会保留，供诊断使用。此流程独立于可移植的模拟 CLI 测试套件。

2026-10-24，五种内置适配器在 macOS 上各通过一次真实 `workspace-write` 调用，包括工具活动、正确输出文件、输入未改变及零退出码：

| 适配器 | 已安装 CLI 版本 | 已测试的认证和模型 |
|---|---|---|
| Codex | `0.163.0-alpha.11.2` | ChatGPT 登录；请求 `gpt-6.1-sol`，low effort |
| Claude Code | `2.1.296` | `claude-config`，使用配置模型；报告 `claude-opus-5-5` |
| DeepSeek Harness | `0.2.0-rc.2` | DeepSeek API Key；通过 Messages 请求 `deepseek-flash` |
| OpenCode V2 | `2.0.32` | DeepSeek API Key；通过 Chat Completions 请求 `deepseek-flash` |
| Cursor Agent | `2026.07.23-e383d2b` | 原生登录；请求 `auto` |

Cursor 使用了 `useHttp1ForAgent: true`、`useCurrentUserHomeForLogin: true` 和 `nativeStallTimeoutMs: 300000`。该结果只覆盖这些选定的本地配置，其他认证方式和模型不在此次真实调用范围内。

2026-10-24，在原生 Windows（10.0.26100 x64、Node.js 24.22.1）上也通过了一次真实调用：Claude Code `2.1.309`（原生 `claude.exe`），使用 `claude-config`、配置模型（报告为 `claude-opus-5-5`）和 `bypass` 权限。探测通过，Agent 使用了 Glob/Read/Write，输出文件和输入未改变检查均通过，退出码为零。Windows 上未尝试其他适配器的真实调用。

## 开发与分发

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack
```

Windows 会跳过使用 shebang 脚本作为模拟 CLI 的测试，并注明原因：Windows 无法在不借助 shell 的情况下启动这些脚本。Cursor 执行测试硬链接当前 Node 二进制，并启动同目录的 `index.js`，与 Windows 适配器使用相同入口。`tests/process.test.mjs` 直接使用当前 Node 可执行文件，在各平台覆盖超时、取消、输出上限、后代进程清理及完整扩展适配器执行。

可选的 `npm run test:sandbox` 会在临时模拟仓库中调用已安装的 Codex 沙箱，检查 API 和原生登录计划的只读／工作区写入模式，不请求模型，也不读取凭据。它独立于可移植的模拟测试套件。

可移植测试覆盖严格校验、认证隔离、使用模拟 Agent 的五种内置路由、终结事件解析、脱敏、观察者异常、输出上限、超时／取消和子进程清理、扩展注册、快照以及元数据探测。新增用例覆盖 OpenCode 导出结果核对、Cursor 启动／权限／认证检查、Claude 部分输出和未知用量处理、原生预检截止时间以及订阅费用语义。配置模式回归验证规划阶段不读取配置、原生设置不变、继承配置模型并记录实际 init 模型值、bypass 参数／清理行为明确、Codex 和 Claude 订阅目标拒绝 bypass，以及原生认证目录不能与工作区重叠。构建产出 `dist/*.js` 和 `dist/*.d.ts`；npm 包仅包含 dist、schema、示例和文档。使用方应固定包版本或经过验证的 tarball，本地源码链接仅用于开发。这些命令不会向注册表发布包。

## 许可证

[MIT](LICENSE) © 2026 imjszhang。

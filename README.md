# WTAgent

Turn GPT Web into a local CLI agent.

把 GPT 网页聊天变成一个本地 CLI Agent。

[中文](#中文) · [English](#english)

## 中文

WTAgent 把 GPT 网页聊天连接到本地工具，提供类似 Codex 的 CLI Agent 体验。当前首个适配器支持 ChatGPT Web。

网页 GPT 负责思考，WTAgent 在本机：

- 读取和修改本地文件
- 调用结构化本地命令，运行构建、测试和开发服务

不需要 OpenAI API Key，也不要求 ChatGPT Pro。WTAgent 使用独立的 Chrome Profile 保存你的网页登录状态，并使用该账号在网页上实际可用的模型和额度；如果账号拥有 Pro，它会成为额外优势。

支持矩阵：

- macOS
- Linux
- Windows 10 1809+ / Windows 11 x64
- Windows ARM64 目前为预览支持

边界：

- 需要 Chrome 或 Chromium；首版不支持 Edge
- Git 和 `rg` 是可选项，不是运行前提
- WSL 不在首版支持范围内；请直接在原生 PowerShell / CMD / Windows Terminal 中运行

### 快速开始

需要 Node.js 20.17+ 和 Chrome/Chromium。

```bash
npm install -g wtagent@alpha --registry=https://registry.npmjs.org/
wtagent login
```

Windows PowerShell：

```powershell
npm install -g wtagent@alpha --registry=https://registry.npmjs.org/
wtagent doctor
wtagent login
```

登录完成后，进入项目目录：

```bash
cd my-project
wtagent
```

也可以直接附带任务：

```bash
wtagent "检查这个项目并修复测试"
wtagent -C ./my-project "创建一个网站"
```

之后直接在终端中继续对话。WTAgent 会把任务交给 GPT Web，并在本地执行文件操作和结构化本地命令。使用 `↑` / `↓` 浏览本次 CLI 会话的历史输入。

按 `Ctrl+C` 或 `Ctrl+D` 可退出并关闭专用 Chrome。若上一次异常退出留下了 Chrome，WTAgent 会在验证其 CDP 身份后复用并接管它。

常见说明：

- `wtagent doctor` 会检查 Node、Chrome、目录权限和运行环境
- 首次登录只会写入 WTAgent 的专用 Chrome Profile，不会接管你的日常浏览器 Profile
- 如果系统没有 Git 或 `rg`，WTAgent 仍应保留核心文件读写与搜索能力

## English

WTAgent connects GPT Web chat to local tools, providing a Codex-like CLI agent experience. The first adapter currently supports ChatGPT Web.

GPT Web handles reasoning. WTAgent runs locally to:

- Read and edit local files
- Run structured local commands, builds, tests, and development servers

No OpenAI API key or ChatGPT Pro subscription is required. WTAgent stores your web login in a dedicated Chrome profile and uses the models and quota actually available to that account. Pro is an optional bonus when the account has it.

Support matrix:

- macOS
- Linux
- Windows 10 1809+ / Windows 11 x64
- Windows ARM64 is currently preview only

Boundaries:

- Requires Chrome or Chromium; Edge is out of scope for the first Windows release
- Git and `rg` are optional accelerators, not runtime requirements
- WSL is not supported in v1; run WTAgent from native PowerShell, CMD, or Windows Terminal

### Quick start

Requires Node.js 20.17+ and Chrome/Chromium.

```bash
npm install -g wtagent@alpha --registry=https://registry.npmjs.org/
wtagent login
```

Windows PowerShell:

```powershell
npm install -g wtagent@alpha --registry=https://registry.npmjs.org/
wtagent doctor
wtagent login
```

After signing in, start WTAgent inside a project:

```bash
cd my-project
wtagent
```

Or provide the first task directly:

```bash
wtagent "inspect this project and fix the tests"
wtagent -C ./my-project "build a website"
```

Continue chatting in the terminal. WTAgent sends tasks to GPT Web and executes file operations and structured local commands. Use `↑` / `↓` to browse input history from the current CLI session.

Press `Ctrl+C` or `Ctrl+D` to exit and close the dedicated Chrome. If an abnormal exit leaves Chrome running, WTAgent verifies and adopts that CDP instance on the next start.

Notes:

- `wtagent doctor` checks Node, Chrome, writable data paths, and runtime support
- WTAgent always uses its own Chrome profile and does not reuse your daily browsing profile
- Core file and search capabilities must continue to work even when Git or `rg` is missing

## License

[MIT](./LICENSE)

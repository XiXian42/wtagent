# WTAgent

WTAgent（Web Tool Agent）使用用户自己的 ChatGPT Pro 网页会话，在本地执行文件和终端工具。

ChatGPT Web 负责推理并通过 XML 提出工具调用；本地 Node.js Runtime 负责解析、权限判断、执行、记录和恢复。浏览器使用独立 Chrome Profile，不接管用户日常使用的 Chrome。

> Web intelligence. Local actions.

## 当前能力

- 独立、可见、持久化的 Chrome Profile；默认启动后自动最小化窗口，需要登录或人机验证时自动恢复，随后再最小化（`--no-minimize` 可保持窗口可见）。
- 原生 Chrome 登录，随后通过 CDP 连接同一个 Profile。
- 自动选择 ChatGPT `Pro` 模式；按稳定的 DOM 属性（非显示文字）识别，兼容多语言界面。`Pro` 被限流不可选时，自动回退到菜单中它前一个可用模式（如 Extra high），并在 CLI 中打印所选模式或回退原因。
- XML 单工具调用协议和有限格式重试。
- 项目内文件列举、读取、搜索、创建、覆盖、追加和精确编辑。
- 结构化 `program + argv` 命令执行、超时和进程树终止。
- 开发服务器等长运行进程的启动、日志读取、URL 识别和停止。
- 项目外路径、提权、删除、推送、发布、部署和敏感环境变量的本地审批。
- 一网页会话一份 Codex rollout、JSONL 事件日志、工具调用去重和待回传结果恢复。
- 消息中用 `@文件` 附带本地文件，通过网页上传交给 ChatGPT（支持项目内外的任意路径）。
- 默认对话入口，以及 `resume`、`status`、`login`、`logout`、`doctor` CLI 命令。

## 环境要求

- Node.js 20.17 或更高版本。
- Google Chrome 或 Chromium。
- 用户自己的 ChatGPT Pro 账户。

支持 macOS、Windows 和 Linux 的路径、Chrome 发现与进程管理逻辑。当前真实网页 smoke test 已在 macOS Chrome 上通过；Windows/Linux 应在发布前继续跑真实网页验收。

## 安装

通过 npm 安装 alpha 版本：

```bash
npm install -g wtagent@alpha
wtagent doctor
```

从源码安装：

```bash
npm install
npm link
wtagent doctor
```

也可以不执行 `npm link`，直接运行：

```bash
node src/cli/main.js doctor
```

如果没有自动发现 Chrome：

```bash
wtagent --chrome-path "/path/to/chrome" doctor
```

也可设置 `WTAGENT_CHROME_PATH`。旧的 `WEBAGENT_CHROME_PATH` 仍可作为兼容回退。

## 首次登录

```bash
wtagent login
```

登录命令会打开没有 CDP/自动化参数的原生 Chrome。完成登录，直到页面能看到 ChatGPT 聊天记录或账户头像，并且不再显示 `Log in`，再回到终端按 Enter。

CLI 会关闭原生窗口，用同一个 Profile 建立一次新的 CDP 连接并验证登录态。验证失败时会重新打开原生登录窗口，不会把 Google 登录成功误判为 ChatGPT 登录成功。

不要在 `wtagent` 打开的 CDP 窗口中重新执行 Google OAuth；使用 `wtagent login` 更新登录状态。

## 退出登录

```bash
wtagent logout          # 确认后删除本地 Chrome Profile
wtagent logout --yes    # 跳过确认（用于脚本化测试）
```

登录状态完全保存在专用 Chrome Profile（chatgpt.com 的 Cookie 与 localStorage）中，没有单独的 token 文件。`logout` 只删除本地 Profile 目录，把 wtagent 恢复到全新的“游客”状态，方便从头验证 `login → run` 全流程；它不会影响你 ChatGPT 账号在其他浏览器/设备上的登录，也不会调用网页端的退出。下次 `wtagent login` 会重新创建 Profile。

## 新建会话

在项目目录中直接进入对话：

```bash
cd my-site
wtagent
```

也可以直接附带第一条任务：

```bash
mkdir my-site
wtagent -C ./my-site "创建一个可运行的个人网站，完成构建验证"
```

显式选择模式：

```bash
wtagent -C ./my-site --mode Pro "添加联系页面并运行测试"
```

指定的模式若被限流不可选，CLI 会自动回退到菜单里前一个可用模式并打印提示；若该模式在菜单中不存在或选择器未找到，则保持当前模式继续，并在终端说明原因。模式识别只依赖稳定 DOM 属性，不按界面文字，因此多语言界面下同样可用。

单轮 ChatGPT 响应默认最多等待 10 分钟。需要更长时间时，可传入毫秒数：

```bash
wtagent --model-turn-timeout-ms 900000 -C ./my-site "执行 Extra High 代码审查"
```

Chrome 窗口默认在启动后最小化，不干扰桌面；需要人工登录或人机验证时会自动恢复，处理完再最小化。若想全程保持窗口可见：

```bash
wtagent --no-minimize -C ./my-site "调试这个页面"
```

执行期间终端会显示：

- 网页模型解析后的进度消息；
- 工具名称和参数；
- 命令 stdout/stderr；
- 需要审批的高风险操作；
- 最终消息和 Session ID。

项目内的常规读写、构建和测试默认自动执行。命中高风险规则时，每次只批准当前操作。

## 用 `@文件` 附带文件

在任意消息里用 `@` 引用本地文件，WTAgent 会在发送前把这些文件上传到 ChatGPT 网页输入框（等价于网页上的“添加文件”）：

```
you › 总结这个报告 @docs/report.pdf
you › 分析这张图 @/Users/me/Downloads/photo.jpeg
you › 对比 @"src/main.js" 和 @src/old.js
```

- 支持裸路径（`@path/to/file`）、绝对路径（`@/abs/path`）、`~` 家目录和带引号路径（`@"my file.pdf"`，可含空格）。
- 相对路径按项目根目录解析；绝对路径按原样使用。因为这是上传到你自己的 ChatGPT 会话（不是本地工具读取），所以**不限制在项目目录内**，可附带任意位置的文件。缺失或指向目录的引用会被跳过并在终端说明原因。
- 已附带/被跳过的文件都会在 CLI 中打印，让你知情。
- 上传走网页通道，支持图片、PDF 等二进制；文件字节保存在 ChatGPT 对话中，不进入本地 rollout。导出到 Codex/Claude Code 时，用户消息会追加 `[attached: 文件名]` 说明，使导出会话仍能反映附带了哪些文件。

## Session 状态与继续

列出最近 Session：

```bash
wtagent status
```

查看完整状态：

```bash
wtagent status session_20260729164118_fc0ade19
```

恢复中断的 run：

```bash
wtagent resume session_20260729164118_fc0ade19
```

在同一个 ChatGPT 对话中追加功能：

```bash
wtagent resume session_20260729164118_fc0ade19 "再增加一个暗色主题切换按钮"
```

一个本地 Session 严格对应一个 ChatGPT 网页对话。`resume` 打开已保存的会话 URL；需要新对话时直接使用 `wtagent` 创建新的 Session。`<done>true</done>` 只结束当前执行轮次并把控制权交还用户，不会关闭 Session，也不会产生不可继续的“任务完成态”。若上次本地工具已经执行、但结果尚未回填网页，Runtime 会先重发保存的结果，避免重复执行写操作或命令。

Runtime 不以工具次数判断完成，而是根据当前用户请求和本轮工具证据验收：要求创建或修改时必须存在成功的本地变更或执行证据；明确要求读取、测试、构建或验证时，还必须存在对应的成功证据，且验证发生在变更之后。缺少证据的“已完成”声明会被退回网页模型继续处理。若确实需要用户提供信息，可以用 `done=true` 提出具体问题并交还控制权。

## 本地工具

| 工具 | 作用 |
| --- | --- |
| `fs.list` | 列出目录树 |
| `fs.read` | 分段读取文本文件 |
| `fs.write` | 创建、覆盖或追加文本文件 |
| `fs.edit` | 原子化精确文本替换 |
| `fs.search` | 使用 ripgrep 或 JavaScript 回退搜索 |
| `terminal.exec` | 执行会结束的程序 |
| `process.start` | 启动开发服务器等长运行程序 |
| `process.read` | 读取长运行程序状态和日志 |
| `process.stop` | 停止长运行程序 |
| `process.list` | 列出当前 Session 管理的程序 |

模型不会直接获得本机终端或文件权限。它只能发送类似以下内容：

```xml
<agent_response>
  <done>false</done>
  <message>创建入口文件。</message>
  <tool_call name="fs.write">
    <args>
      <path>index.html</path>
      <content><![CDATA[<h1>Hello</h1>]]></content>
      <mode>overwrite</mode>
    </args>
  </tool_call>
</agent_response>
```

XML 是网页与本地 Runtime 的通信协议。`tool_call` 只是请求；Runtime 会先做确定性 XML 解析、Zod 参数校验、路径解析和策略判断，再决定是否执行。模型不负责生成 `call_id`，Runtime 会为本地恢复和 Codex transcript 生成内部调用标识。

## 数据位置

默认数据目录：

- macOS：`~/Library/Application Support/wtagent`
- Windows：`%APPDATA%\wtagent`
- Linux：`$XDG_DATA_HOME/wtagent` 或 `~/.local/share/wtagent`

其中包含：

- `chrome-profile/`：专用 Chrome Profile；
- `sessions/<session-id>/session.json`：会话和恢复检查点；
- `sessions/<session-id>/events.jsonl`：运行事件日志；
- `sessions/<session-id>/rollout-*.jsonl`：该 ChatGPT 对话唯一对应的 Codex rollout；
- `sessions/<session-id>/tool-output.jsonl`：终端工具的完整流式输出；
- `diagnostics/`：仅在 `--debug` 下产生的页面截图和 HTML。

可用 `--home <path>` 或 `WTAGENT_HOME` 修改数据目录。若新目录尚不存在但检测到旧版真实数据，WTAgent 会继续使用旧 `webagent` 数据目录；`WEBAGENT_HOME` 也保留为兼容回退。

## License

[MIT](./LICENSE)

## 导出到 Codex / Claude Code

对话从第一轮起直接写入该 Session 的 `rollout-*.jsonl`：首行是 `session_meta`，后续是 `{timestamp, type: "response_item", payload}`，payload 采用 OpenAI Responses 形状（`message` / `function_call` / `function_call_output`）。

```bash
wtagent export <session-id> --format codex                # 打印 Codex rollout JSONL
wtagent export <session-id> --format claude-code -o s.jsonl  # 写出 Claude Code 会话 JSONL
```

- `codex`：输出 `session_meta` + `response_item` 行，可放入 `~/.codex/sessions/**` 结构。
- `claude-code`：输出以 `uuid`/`parentUuid` 串联、带 `tool_use`/`tool_result` 块的记录，对应 `~/.claude/projects/*/*.jsonl`。

WTAgent 专属脚手架只存在于网页 transport：长协议提示使用 `<agent_protocol>`，每条 outbound message 的最后一段固定为一个 `<system_reminder>`。它们明确表示用户所运行应用的响应格式，而不伪装成 ChatGPT 原生 system/tool channel。这些内容不写入 portable rollout，因此导出到 Codex/Claude Code 时不会泄漏 XML 协议或 WTAgent 工具目录。

## 开发与验证

```bash
npm run check
npm test
npm pack --dry-run
```

测试默认使用 Fake Web Adapter，不需要真实账号。真实 ChatGPT Web 依赖实时 DOM 和用户会话，作为人工 smoke test。

## 已知限制

- ChatGPT Web 没有真正的 system/tool channel；协议内容都是普通聊天文本，因此本地 Runtime 始终是最终权限边界。
- 网页 DOM 更新可能需要调整 `src/browser/chatgpt-web-adapter.js` 中的 Locator。
- V1 每轮只执行一个工具，不并行执行多个模型工具调用。
- Session 恢复依赖已保存的 ChatGPT 会话 URL；URL 失效时需要新建 Session。
- Windows/Linux 的真实 ChatGPT 网页端到端验收尚未在本工作区执行。
- 不支持无头（headless）模式。实测无头 Chrome（`--headless` 与 `--headless=new`）访问 `chatgpt.com` 会被 Cloudflare 拦到验证页（标题为“请稍候…”，页面含 `challenges.cloudflare.com` / `cf-turnstile`），无法加载聊天界面；有头模式正常。因此浏览器必须以可见窗口运行。若只是想让窗口不占用桌面，使用默认的自动最小化即可——最小化窗口不影响页面渲染（ChatGPT 仍正常加载）。

完整架构与状态设计见 [技术方案](docs/technical-design.md)。

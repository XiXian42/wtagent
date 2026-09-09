# WTAgent

Turn ChatGPT Web (including Pro) into Codex.
Turn Claude Web into Claude Code.

Also DeepSeek, Gemini, Grok, Kimi, GLM.

No API key. No MCP. No tunnel. No plugin.

https://xixian42.github.io/wtagent/

[中文](#中文)

## Quick start

Requires Node.js 20.x ≥20.17, 22.x ≥22.13, or ≥23.5, and Chrome/Chromium. WTAgent supports macOS, Linux, native Windows, and preview support for WSL2 with WSLg. WSL1 and external X11 configurations are best effort.

On WSL, install the Linux Chrome/Chromium package inside the distribution and launch WTAgent from WSL. WTAgent keeps file and command execution in the WSL environment and connects to that Linux browser over local CDP. Display environment variables are only configuration hints; actual GUI availability is confirmed when Chrome starts. Windows-host Chrome is not supported from WSL yet.

```bash
npm install -g wtagent
```

Open a working directory and start WTAgent:

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

ChatGPT asks you to choose `Pro` or `Current`; other providers keep or silently select their configured default. Then type a task:

```text
$ wtagent
you › Create hello.js that writes "Hello from WTAgent" to hello.txt. Run it with Node.js and verify the result.
```

WTAgent creates the files in the current directory, runs the script locally, and checks its output. You can continue chatting in the same terminal after the task finishes.

Choose a provider with `--model` (ChatGPT is the default). Supported values are `chatgpt`, `claude`, `deepseek`, `gemini`, `kimi`, and `glm`:

```bash
wtagent --model claude "inspect this project and summarize its architecture"
wtagent --model gemini "inspect this project and summarize its architecture"
```

Claude keeps the model selected by claude.ai in its browser profile; WTAgent does not override it.
Gemini likewise keeps the model selected in its browser profile.

If the provider is not signed in, WTAgent opens its dedicated Chrome profile and asks you to sign in. Each provider has an independent profile, and your task continues automatically after login.

WTAgent itself does not require an API key. It uses your own web account, available models, and quota.

You can also provide the first task directly:

```bash
wtagent "create hello.js, run it, and verify the output"
```

Multiline paste and `↑` / `↓` input history are supported. Press `Ctrl+C` or `Ctrl+D` to exit.

## 中文

把 ChatGPT 网页版（含 Pro）变成 Codex。
把 Claude 网页版变成 Claude Code。

同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。

无需 API Key，无需 MCP，无需隧道，无需插件。

https://xixian42.github.io/wtagent/

### 快速开始

需要 Node.js 20.x ≥20.17、22.x ≥22.13 或 ≥23.5，以及 Chrome/Chromium。支持 macOS、Linux、原生 Windows，以及预览支持带 WSLg 的 WSL2。WSL1 和外部 X11 配置仅按尽力支持处理。

在 WSL 中使用时，需要在 WSL 发行版内部安装 Linux 版 Chrome/Chromium，并从 WSL 启动 WTAgent。文件读写和命令执行仍然发生在 WSL 环境中，WTAgent 通过本地 CDP 连接这个 Linux 浏览器。图形环境变量仅表示已配置，实际可用性会在 Chrome 启动时确认。当前还不支持从 WSL 直接控制 Windows 主机上的 Chrome。

```bash
npm install -g wtagent
```

进入工作目录并启动：

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

ChatGPT 会让你选择 `Pro` 或 `Current`；其他 provider 会保持或自动选择配置的默认模式。然后直接输入任务：

```text
$ wtagent
you › 创建 hello.js，将“Hello from WTAgent”写入 hello.txt。用 Node.js 运行并验证结果。
```

WTAgent 会在当前目录创建文件、运行本地脚本并检查输出。任务完成后，可以继续在同一个终端中对话。

通过 `--model` 选择 provider（默认是 ChatGPT）。可选值包括 `chatgpt`、`claude`、`deepseek`、`gemini`、`kimi` 和 `glm`：

```bash
wtagent --model claude "分析这个项目并总结架构"
wtagent --model gemini "分析这个项目并总结架构"
```

Claude 会沿用 claude.ai 在该浏览器 Profile 中选择的模型，WTAgent 不会自动切换模型。
Gemini 同样沿用其浏览器 Profile 当前选择的模型。

如果尚未登录对应 provider，WTAgent 会打开它的独立专用 Chrome Profile 并提示登录；登录成功后任务会自动继续。

WTAgent 本身无需 API Key，而是使用你自己的网页账号、可用模型和额度。

也可以在启动时直接附带第一个任务：

```bash
wtagent "创建 hello.js，运行并验证输出"
```

支持多行粘贴和 `↑` / `↓` 输入历史。使用 `Ctrl+C` 或 `Ctrl+D` 退出。

## License

[MIT](./LICENSE)

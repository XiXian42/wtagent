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

After login, interactive runs give you five seconds to choose a model in the browser. Press Enter to continue immediately, or wait to keep the current selection. Then type a task:

```text
$ wtagent
you › Create hello.js that writes "Hello from WTAgent" to hello.txt. Run it with Node.js and verify the result.
```

WTAgent creates the files in the current directory, runs the script locally, and checks its output. You can continue chatting in the same terminal after the task finishes.

Choose a provider with `--model` (ChatGPT is the default). Supported values are `chatgpt`, `claude`, `deepseek`, `gemini`, `grok`, `kimi`, and `glm`:

```bash
wtagent --model claude "inspect this project and summarize its architecture"
wtagent --model gemini "inspect this project and summarize its architecture"
```

### Generate and save images

Use ChatGPT, Gemini, or Grok to generate images in the current conversation. No
extra image flag is needed; describe the image in your task:

```bash
wtagent --model chatgpt --once "Generate a square illustration of a blue robot watering a plant. Save it locally."
wtagent --model gemini --once "Generate a 16:9 watercolor city skyline and save the image locally."
wtagent --model grok --once "Generate a minimalist landscape illustration and save it locally."
```

WTAgent waits for the completed image reply, downloads its images, checks their
format and dimensions, and records SHA-256 hashes. Supported file formats are
PNG, JPEG, and WebP. Files are saved under the current project's
`artifacts/native-images/<turn-id>/`, for example:

```text
artifacts/native-images/<turn-id>/image-1.png
artifacts/native-images/<turn-id>/image-2.webp
```

The extension follows the downloaded file's actual format. Multiple images from
one reply are saved separately. WTAgent passes the verified local paths back to
the model, which can finish the task or continue with file operations such as
organizing assets and building a page that uses them.

In an interactive conversation, attach a local reference image with `@path`:

```text
you › @assets/reference.png Create a watercolor illustration based on this reference and save it locally.
```

Reference handling, image size, aspect ratio, and image availability depend on
the website and selected model. WTAgent uses your logged-in account and its
quota. A text-only explanation or refusal is returned as text; it is not reported
as a saved image.

If downloading or returning the saved paths is interrupted, resume the recorded
session without adding a new instruction:

```bash
wtagent resume <session-id>
```

Recovery reuses the recorded reply when it can verify the conversation. It does
not automatically repeat an image-generation request whose submission is
uncertain. Partially downloaded replies may need to download their files again.

### Generate music with Gemini

```bash
wtagent --model gemini --type music --once "Create peaceful instrumental piano music, no vocals"
```

`--type music` selects Gemini's native Music tool. Tracks are saved under
`artifacts/music/<turn-id>/`. If Gemini returns an MP4 with audio and a cover
video, WTAgent preserves that original; when `ffmpeg` is on PATH, it also extracts
an `.m4a` audio file without re-encoding. Without FFmpeg, the original MP4 remains
usable. Duration follows the provider's output.

Download interruptions can be resumed with `wtagent resume <session-id>`. A bare
resume of a completed music session returns its saved result without generating
again. The default `--type agent` retains ordinary agent behavior, including
native image output.

### Conversation recovery and diagnostics

The ChatGPT adapter supports legacy and modern message layouts, temporary
conversation URLs, and virtualized history. When a send cannot be verified,
WTAgent preserves the session for recovery. Structural failure reports identify
the recognized page layout, missing identity fields, and send stage; the CLI
shows the report path for startup, send-confirmation, and recovery failures.

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

登录后，交互模式会留出 5 秒供你在浏览器里选择模型。按 Enter 可立即继续，等待倒计时结束则沿用当前选择。然后输入任务：

```text
$ wtagent
you › 创建 hello.js，将“Hello from WTAgent”写入 hello.txt。用 Node.js 运行并验证结果。
```

WTAgent 会在当前目录创建文件、运行本地脚本并检查输出。任务完成后，可以继续在同一个终端中对话。

通过 `--model` 选择 provider（默认是 ChatGPT）。可选值包括 `chatgpt`、`claude`、`deepseek`、`gemini`、`grok`、`kimi` 和 `glm`：

```bash
wtagent --model claude "分析这个项目并总结架构"
wtagent --model gemini "分析这个项目并总结架构"
```

### 生成图片并保存到本地

使用 ChatGPT、Gemini 或 Grok，在当前对话中直接生成图片。无需额外的生图参数，在任务里描述要画的内容即可：

```bash
wtagent --model chatgpt --once "生成一张蓝色小机器人给盆栽浇水的方形插画，保存到本地"
wtagent --model gemini --once "生成一张 16:9 的水彩城市天际线，保存到本地"
wtagent --model grok --once "生成一张极简风格的山水插画，保存到本地"
```

WTAgent 等待图片回复完成后下载文件，检查格式和尺寸，并记录 SHA-256 哈希。支持 PNG、JPEG 和 WebP。文件保存在当前项目的 `artifacts/native-images/<turn-id>/` 目录，例如：

```text
artifacts/native-images/<turn-id>/image-1.png
artifacts/native-images/<turn-id>/image-2.webp
```

扩展名以下载文件的实际格式为准。一条回复包含多张图片时，会分别保存。WTAgent 把经过验证的本地路径交回模型，模型可以结束任务，也可以继续整理素材、制作引用这些图片的页面等。

在交互对话中，可以通过 `@路径` 附加本地参考图：

```text
你 › @assets/reference.png 参考这张图，生成水彩风格的插画并保存到本地。
```

是否支持参考图、图片尺寸、宽高比和图片生成，取决于网站及当前选择的模型。WTAgent 使用你已登录的账号和额度。若网站只返回文字说明或拒绝生成，会如实返回文字，不会声称已经保存图片。

下载或回传文件路径时中断，可以不带新指令恢复原会话：

```bash
wtagent resume <session-id>
```

恢复时会核对会话并复用已记录的回复；无法确认是否已提交的生图请求不会自动重发。只下载了一部分图片的回复，恢复时可能需要重新下载文件。

### 使用 Gemini 生成音乐

```bash
wtagent --model gemini --type music --once "生成一段舒缓钢琴纯音乐，不要人声"
```

`--type music` 会启用 Gemini 原生 Music 工具，文件保存到 `artifacts/music/<turn-id>/`。如果 Gemini 返回带封面画面和音轨的 MP4，WTAgent 会保留原文件；本机 PATH 中有 `ffmpeg` 时，还会在不重新编码的情况下提取 `.m4a` 纯音频。未安装 FFmpeg 时仍可使用原始 MP4，时长以网站实际生成结果为准。

下载中断后，可用 `wtagent resume <session-id>` 继续。已完成的音乐会话不带新指令恢复时，会返回已保存的结果，不再生成一次。默认 `--type agent` 保持普通智能体行为，也支持直接接收图片。

### 会话恢复与兼容诊断

ChatGPT 适配器支持新旧消息结构、临时会话地址和只保留部分消息节点的长对话。无法确认发送结果时，会保留会话供恢复。结构化诊断会记录识别到的页面结构、缺失的消息身份字段和发送阶段；启动、发送确认或恢复失败时，终端会显示诊断文件路径。

Claude 会沿用 claude.ai 在该浏览器 Profile 中选择的模型，WTAgent 不会自动切换模型。
Gemini 同样沿用其浏览器 Profile 当前选择的模型。

如果尚未登录对应 provider，WTAgent 会打开它的独立专用 Chrome Profile 并提示登录；登录成功后任务会自动继续。

WTAgent 本身无需 API Key，而是使用你自己的网页账号、可用模型和额度。

也可以在启动时直接附带第一个任务：

```bash
wtagent "创建 hello.js，运行并验证输出"
```

支持多行粘贴和 `↑` / `↓` 输入历史。使用 `Ctrl+C` 或 `Ctrl+D` 退出。

## Development and regression tests / 开发与回归测试

Run from a source checkout / 在源码目录运行：

```bash
npm ci
npm test
npm run check
npm run test:media
npm run test:chatgpt-dom
```

`test:media` covers image downloads, native multi-image replies, interrupted
recovery, music handling, and provider DOM behavior. The browser tests require
Chrome/Chromium (or `WTAGENT_CHROME_PATH`), use isolated test pages, and do not
require a web account or consume generation quota. They do not replace live
account testing when a provider changes its service.

`test:media` 覆盖图片下载、多图回复、中断恢复、音乐处理和各网站的 DOM 行为。浏览器测试需要 Chrome/Chromium，也可通过 `WTAGENT_CHROME_PATH` 指定路径；测试使用隔离页面，无需账号，也不消耗生成额度。网站服务变化后的真实账号验证仍需单独进行。

## License

[MIT](./LICENSE)

# WTAgent

Use GPT Web as a local CLI agent.

WTAgent connects GPT Web to your local project: GPT reasons in the browser while WTAgent reads and writes local files and runs commands on your machine.

[中文](#中文)

## Quick start

Requires Node.js 20.17+ and Chrome/Chromium. WTAgent supports macOS, Linux, native Windows, and WSL with WSLg or another Linux graphical display.

On WSL, install the Linux Chrome/Chromium package inside the distribution and launch WTAgent from WSL. WTAgent keeps file and command execution in the WSL environment and connects to that Linux browser over local CDP. Windows-host Chrome is not supported from WSL yet.

```bash
npm install -g wtagent
```

Open a working directory and start WTAgent:

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

Choose `Pro` or `Current`, then type a task:

```text
$ wtagent
you › Create hello.js that writes "Hello from WTAgent" to hello.txt. Run it with Node.js and verify the result.
```

WTAgent creates the files in the current directory, runs the script locally, and checks its output. You can continue chatting in the same terminal after the task finishes.

If ChatGPT is not signed in, WTAgent opens its dedicated Chrome profile and asks you to sign in. Your task continues automatically after login.

No OpenAI API key or ChatGPT Pro subscription is required. WTAgent uses your own ChatGPT Web account, available models, and quota.

You can also provide the first task directly:

```bash
wtagent "create hello.js, run it, and verify the output"
```

Multiline paste and `↑` / `↓` input history are supported. Press `Ctrl+C` or `Ctrl+D` to exit.

## 中文

WTAgent 将 GPT 网页聊天连接到本地项目：GPT 在浏览器中思考，WTAgent 在你的电脑上读写本地文件并运行命令。

### 快速开始

需要 Node.js 20.17+ 和 Chrome/Chromium。支持 macOS、Linux、原生 Windows，以及带 WSLg 或其他 Linux 图形显示环境的 WSL。

在 WSL 中使用时，需要在 WSL 发行版内部安装 Linux 版 Chrome/Chromium，并从 WSL 启动 WTAgent。文件读写和命令执行仍然发生在 WSL 环境中，WTAgent 通过本地 CDP 连接这个 Linux 浏览器。当前还不支持从 WSL 直接控制 Windows 主机上的 Chrome。

```bash
npm install -g wtagent
```

进入工作目录并启动：

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

选择 `Pro` 或 `Current`，然后直接输入任务：

```text
$ wtagent
you › 创建 hello.js，将“Hello from WTAgent”写入 hello.txt。用 Node.js 运行并验证结果。
```

WTAgent 会在当前目录创建文件、运行本地脚本并检查输出。任务完成后，可以继续在同一个终端中对话。

如果尚未登录 ChatGPT，WTAgent 会打开专用 Chrome 并提示登录；登录成功后任务会自动继续。

无需 OpenAI API Key，也不要求 ChatGPT Pro。WTAgent 使用你自己的 ChatGPT 网页账号、可用模型和额度。

也可以在启动时直接附带第一个任务：

```bash
wtagent "创建 hello.js，运行并验证输出"
```

支持多行粘贴和 `↑` / `↓` 输入历史。使用 `Ctrl+C` 或 `Ctrl+D` 退出。

## License

[MIT](./LICENSE)

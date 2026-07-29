# WTAgent

Turn ChatGPT Web into a local CLI agent.

把 ChatGPT 网页版变成一个本地 CLI Agent。

[中文](#中文) · [English](#english)

## 中文

WTAgent 使用你自己的 ChatGPT Pro 网页会话，提供类似 Codex 的本地 CLI Agent 体验。

ChatGPT Web 负责思考，WTAgent 在本机：

- 读取和修改本地文件
- 调用本地 Shell，运行构建、测试和开发服务

不需要 OpenAI API Key。WTAgent 使用独立的 Chrome Profile 保存 ChatGPT 登录状态。

### 快速开始

需要 Node.js 20.17+ 和 Chrome/Chromium。

```bash
npm install -g wtagent@alpha
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

之后直接在终端中继续对话。WTAgent 会把任务交给 ChatGPT Web，并在本地执行文件和 Shell 操作。

## English

WTAgent turns your own ChatGPT Pro web session into a Codex-like local CLI agent.

ChatGPT Web handles reasoning. WTAgent runs locally to:

- Read and edit local files
- Run shell commands, builds, tests, and development servers

No OpenAI API key is required. WTAgent stores the ChatGPT session in a dedicated Chrome profile.

### Quick start

Requires Node.js 20.17+ and Chrome/Chromium.

```bash
npm install -g wtagent@alpha
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

Continue chatting in the terminal. WTAgent sends tasks to ChatGPT Web and executes file and shell operations locally.

## License

[MIT](./LICENSE)

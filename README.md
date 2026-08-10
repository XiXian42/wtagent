# WTAgent

Use GPT Web as a local CLI agent.

把 GPT 网页聊天变成可读写本地文件、运行本地命令的 CLI Agent。

[中文](#中文) · [English](#english)

## 中文

WTAgent 把 GPT Web 连接到你的本地项目，提供类似 Codex 的命令行体验：GPT 在网页中思考，WTAgent 在本机读写文件、编译代码并运行测试。

当前支持 ChatGPT Web。无需 OpenAI API Key，也不要求 ChatGPT Pro；使用的是你自己的网页账号、可用模型和额度。

### 开始使用

需要 Node.js 20.17+ 和 Chrome/Chromium；支持 macOS、Linux 和原生 Windows，暂不支持 WSL。

```bash
npm install -g wtagent
```

进入要工作的目录并启动：

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

启动后选择 `Pro` 或 `Current`，然后直接输入任务。如果尚未登录 ChatGPT，WTAgent 会打开专用 Chrome 并提示你登录；登录成功后任务会自动继续。

例如，启动后直接在终端输入：

```text
$ wtagent
you › 创建 qsort.c，实现整数快速排序。使用系统可用的 C 编译器开启警告编译，并运行测试，覆盖普通输入、重复值和空输入。
you › 再增加一组包含负数的测试
```

WTAgent 会在当前目录创建代码、调用本地编译器并运行测试。任务完成后可以继续在同一个终端中对话。

也可以在启动时直接附带任务：

```bash
wtagent "创建 qsort.c，编译并测试"
```

支持多行粘贴和 `↑` / `↓` 输入历史。使用 `Ctrl+C` 或 `Ctrl+D` 退出。

## English

WTAgent connects GPT Web to your local project and provides a Codex-like CLI experience: GPT reasons in the browser while WTAgent reads and writes files, compiles code, and runs tests on your machine.

The current adapter supports ChatGPT Web. No OpenAI API key or ChatGPT Pro subscription is required; WTAgent uses your own web account, available models, and quota.

### Get started

Requires Node.js 20.17+ and Chrome/Chromium. macOS, Linux, and native Windows are supported; WSL is not currently supported.

```bash
npm install -g wtagent
```

Open a working directory and start WTAgent:

```bash
mkdir wtagent-demo
cd wtagent-demo
wtagent
```

Choose `Pro` or `Current`, then type a task. If ChatGPT is not signed in, WTAgent opens its dedicated Chrome profile and asks you to sign in. The task continues automatically after login.

For example, start it and type directly in the terminal:

```text
$ wtagent
you › Create qsort.c with an integer quicksort. Compile it with warnings using an available C compiler, then test normal input, duplicate values, and empty input.
you › Add another test containing negative numbers.
```

WTAgent creates the code in the current directory, invokes the local compiler, and runs the tests. Keep chatting in the same terminal after the task finishes.

You can also provide the first task directly:

```bash
wtagent "create qsort.c, compile it, and test it"
```

Multiline paste and `↑` / `↓` input history are supported. Press `Ctrl+C` or `Ctrl+D` to exit.

## License

[MIT](./LICENSE)

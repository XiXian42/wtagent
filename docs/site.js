// Progressive enhancement only: the English page and setup commands work
// without JavaScript. No analytics, remote scripts, or account information.
const translatedNodes = [...document.querySelectorAll("[data-i18n]")];
const english = Object.fromEntries(
  translatedNodes.map((node) => [node.dataset.i18n, node.textContent]),
);
const chinese = {
  "skip": "跳转到正文",
  "nav.demo": "看演示",
  "nav.how": "怎么用",
  "nav.faq": "使用提醒",
  "hero.eyebrow": "开源的本地编程助手",
  "hero.title1": "把 ChatGPT 网页版变成",
  "hero.title2": "Codex。",
  "hero.turn": "把",
  "hero.chatgpt": "（含 Pro）变成 Codex。",
  "hero.claude": "变成 Claude Code。",
  "hero.also": "同时支持",
  "hero.lede": "无需 API Key，无需 MCP，无需隧道，无需插件。",
  "hero.start": "在本地试用",
  "hero.watch": "看看怎么做",
  "hero.fact1": "无需 API Key",
  "hero.fact2": "使用你的账号与额度",
  "hero.fact3": "开源 · MIT",
  "hero.note": "独立 CLI，并非官方 Codex 或 Claude Code 客户端。",
  "copy": "复制",
  "art.browser": "你的网页 AI 账号",
  "art.more": "以及更多",
  "art.task": "“修复这个 bug，并运行测试。”",
  "art.reply": "我会先读代码，再修改文件，然后检查结果。",
  "art.local": "你的本地项目",
  "art.tools": "真实文件，真实命令。",
  "art.read": "读取项目",
  "art.edit": "修改代码",
  "art.run": "运行测试",
  "art.result": "把执行结果返回对话，继续完成任务。",
  "art.caption": "工作流示意图，并非产品截图或在线会话。",
  "providers.label": "一个 CLI，选择你常用的网页 AI。",
  "demo.kicker": "不只是给出答案",
  "demo.title": "不是一段等你复制的代码，而是实际执行任务。",
  "demo.intro": "用一个小 bug 展示完整过程：查看文件、修改代码、运行测试，再核对结果。",
  "demo.badge": "真实 ChatGPT 录屏",
  "demo.fullsize": "查看大图 ↗",
  "demo.play": "播放 GIF",
  "demo.taskLabel": "交给它的任务",
  "demo.step1": "找到问题",
  "demo.detail1": "读取源码，运行测试，复现失败。",
  "demo.step2": "修改本地文件",
  "demo.detail2": "直接做针对性修改，而不是给出一段等你粘贴的建议。",
  "demo.step3": "检查执行结果",
  "demo.detail3": "重新运行测试命令，查看输出。",
  "demo.transcript": "阅读文字版演示",
  "demo.transcriptText": "演示项目的 slugify 函数最初只替换第一个空格。WTAgent 读取源码、运行测试，将其改为统一处理连续空白，再次运行测试。预期结果是三个测试全部通过。只有本地验证成功，才会生成回放素材。",
  "demo.source": "查看可复现的演示源码 ↗",
  "how.kicker": "到底改变了什么",
  "how.title": "还是你的网页账号，不一样的工作方式。",
  "how.intro": "WTAgent 为网页 AI 对话补上本地工具执行循环。你在终端里交代任务，模型仍在服务商的网站上运行。",
  "how.beforeLabel": "手动使用网页聊天",
  "how.beforeTitle": "你来完成所有复制、粘贴和执行。",
  "how.beforeText": "描述问题，把代码贴进聊天。将答案复制到编辑器，运行命令，再把报错贴回去。",
  "how.beforeFlow": "聊天 → 你 → 编辑器 → 终端 → 你 → 聊天",
  "how.afterLabel": "使用 WTAGENT",
  "how.afterTitle": "让 Agent 执行这些本地步骤。",
  "how.afterText": "描述任务。WTAgent 处理文件与命令请求，把结果返回给模型，并在本地策略要求时向你申请批准。",
  "how.afterFlow": "你的任务 → 网页 AI ↔ WTAgent ↔ 本地项目",
  "use.readTitle": "理解一个代码库",
  "use.readText": "找到入口，追踪某个功能，解释相关文件。",
  "use.editTitle": "完成一项具体修改",
  "use.editText": "在选定项目中修复 bug，或添加一个小功能。",
  "use.testTitle": "执行并验证",
  "use.testText": "运行命令、查看报错，让模型根据结果继续调整。",
  "how.technical": "想了解适配器、XML 协议和会话恢复？",
  "how.design": "阅读技术设计 ↗",
  "start.kicker": "先从小项目开始",
  "start.title": "怎么用",
  "start.requirements": "需要 Node.js 20.x ≥20.17、22.x ≥22.13 或 ≥23.5，以及 Chrome / Chromium。",
  "start.platforms": "macOS · Linux · Windows。WSL2 + WSLg 为预览支持。",
  "start.guide": "完整安装说明 ↗",
  "start.install": "安装 WTAgent",
  "start.project": "打开测试项目并启动",
  "start.login": "程序会打开专用 Chrome Profile。按提示登录你自己的网页 AI 账号，默认使用 ChatGPT。",
  "start.task": "在终端中输入任务",
  "start.claude": "选择网页 AI",
  "start.providers": "可将 claude 替换为：",
  "notes.title": "使用提醒",
  "notes.account": "使用你自己的账号，遵守服务商条款与额度限制。网页改版或访问限制可能中断使用，无法保证账号不受限制。",
  "notes.data": "文件和命令在本地执行，但返回对话的代码与输出会发送给网页 AI 服务商。不要分享密钥或未经授权的数据。",
  "notes.local": "本地策略检查不等于系统沙箱。请审核命令与修改、保留备份，并先在可丢弃的测试项目中试用。",
  "faq.kicker": "开始之前",
  "faq.title": "说明白它是什么，也说明白它不是什么。",
  "faq.officialQ": "这是 Codex 或 Claude Code 吗？",
  "faq.officialA": "不是。WTAgent 是独立的命令行 Agent，提供类似的“读文件—改代码—执行—验证”工作流。它不会变成官方客户端，不承诺功能完全一致，也不代表获得 OpenAI、Anthropic 或其他服务商的认可。",
  "faq.costQ": "需要 API Key 或额外订阅吗？",
  "faq.costA": "WTAgent 本身免费、采用 MIT 协议，无需模型 API Key。它使用你自己的网页 AI 账号。可用模型、付费功能与使用上限取决于该账号；WTAgent 不提供额外额度，也不绕过服务商限制。",
  "faq.privacyQ": "我的代码完全不会离开电脑吗？",
  "faq.privacyA": "不是。工具在本地执行，但返回对话的文件内容和命令输出会发送给你选择的网页 AI 服务商，适用其条款与数据政策。不要处理密钥、受监管数据或未经授权分享的私有项目。",
  "faq.safetyQ": "模型想执行什么就能执行什么吗？",
  "faq.safetyA": "工具请求需要通过格式验证和本地策略检查。项目外访问、破坏性命令、发布等敏感操作可能需要批准。这不等于操作系统沙箱：获准运行的程序仍具备本地执行能力。请审核请求、使用版本控制，并先在测试项目中试用。",
  "faq.reliabilityQ": "所有服务商和模型都能一直正常使用吗？",
  "faq.reliabilityA": "不能保证。登录状态、模型权限、额度和网页改版都会影响浏览器自动化。具备适配器不代表所有模型和账号都经过在线实测。请查看仓库的当前说明、核对服务商的自动化使用条款，并在访问受限时停止使用。",
  "faq.demoQ": "GIF 是真实在线 AI 会话的录屏吗？",
  "faq.demoA": "现在首页使用真实 ChatGPT 会话录屏。任务实际耗时 99.9 秒，GIF 仅压缩模型等待时间；终端执行、文件修改和测试结果均来自该次真实运行。",
  "cta.kicker": "少一点复制，多一点实际执行。",
  "cta.title": "给你的网页 AI 一个本地任务。",
  "cta.start": "开始使用",
  "cta.source": "在 GitHub 查看源码 ↗",
  "footer.note": "独立开源软件，与各 AI 服务商无隶属关系，也未获其背书。",
  "footer.issues": "反馈问题",
  "footer.friends": "友情链接",
  "footer.ziwei": "紫微斗数",
};

const ui = {
  en: {
    copied: "Copied",
    copyCommand: "Copy command:",
    copyPrompt: "Copy this command:",
    copyFallback: "Automatic copy is unavailable. Select and copy the command.",
    copySuccess: "Command copied to clipboard.",
    play: "Play GIF",
    stop: "Stop GIF",
    demoError: "The GIF could not be loaded. The static preview is still available.",
    demoAlt: "Real WTAgent terminal recording using ChatGPT Web.",
    navigation: "Primary navigation",
    mapping: "Workflow comparison",
    home: "WTAgent home",
    title: "WTAgent — Turn ChatGPT Web into Codex",
    description: "Turn ChatGPT Web (including Pro) into Codex. Turn Claude Web into Claude Code. Also DeepSeek, Gemini, Grok, Kimi, GLM. No API key, no MCP, no tunnel, no plugin.",
    shareTitle: "WTAgent — Turn ChatGPT Web into Codex",
    shareDescription: "Turn ChatGPT Web (including Pro) into Codex. Turn Claude Web into Claude Code. Also DeepSeek, Gemini, Grok, Kimi, GLM. No API key, no MCP, no tunnel, no plugin.",
    shareImageAlt: "WTAgent: Turn ChatGPT Web (including Pro) into Codex. Turn Claude Web into Claude Code. Also DeepSeek, Gemini, Grok, Kimi, GLM.",
  },
  zh: {
    copied: "已复制",
    copyCommand: "复制命令：",
    copyPrompt: "复制这条命令：",
    copyFallback: "无法自动复制，请选中命令后手动复制。",
    copySuccess: "命令已复制到剪贴板。",
    play: "播放 GIF",
    stop: "停止播放",
    demoError: "GIF 加载失败，仍可查看静态封面。",
    demoAlt: "真实 WTAgent 终端录屏（使用 ChatGPT Web）。",
    navigation: "主导航",
    mapping: "编程工作流对照",
    home: "WTAgent 首页",
    title: "WTAgent — 把 ChatGPT 网页版变成 Codex",
    description: "把 ChatGPT 网页版（含 Pro）变成 Codex。把 Claude 网页版变成 Claude Code。同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。无需 API Key，无需 MCP，无需隧道，无需插件。",
    shareTitle: "WTAgent — 把 ChatGPT 网页版变成 Codex",
    shareDescription: "把 ChatGPT 网页版（含 Pro）变成 Codex。把 Claude 网页版变成 Claude Code。同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。无需 API Key，无需 MCP，无需隧道，无需插件。",
    shareImageAlt: "WTAgent：把 ChatGPT 网页版（含 Pro）变成 Codex。把 Claude 网页版变成 Claude Code。同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。",
  },
};

const storageKey = "wtagent-site-language";
const languageButton = document.querySelector("[data-language]");
const copyButtons = [...document.querySelectorAll("[data-copy]")];
const copyTimers = new WeakMap();
const status = document.querySelector("#site-status");
const demoImage = document.querySelector("#demo-image");
const demoButton = document.querySelector("[data-demo-toggle]");
let playing = false;
let autoPlayUsed = false;
let demoVisible = false;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function initialLanguage() {
  const queryLanguage = new URL(window.location.href).searchParams.get("lang");
  if (queryLanguage === "zh" || queryLanguage === "en") return queryLanguage;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // Storage may be disabled; the page still works.
  }
  return "en";
}

let language = initialLanguage();

function text(key) {
  return (language === "zh" ? chinese[key] : english[key]) ?? english[key] ?? key;
}

function announce(message) {
  if (status) status.textContent = message;
}

function renderCopyButton(button) {
  const label = button.querySelector(".copy-label");
  const copied = button.dataset.copyState === "copied";
  if (label) label.textContent = copied ? ui[language].copied : text("copy");
  button.setAttribute("aria-label", `${ui[language].copyCommand} ${button.dataset.copy}`);
}

function renderPlayback() {
  if (!demoImage) return;
  if (demoButton) {
    demoButton.setAttribute("aria-pressed", String(playing));
    const label = demoButton.querySelector("[data-demo-label]");
    if (label) label.textContent = playing ? ui[language].stop : ui[language].play;
  }
  demoImage.alt = ui[language].demoAlt;
}

function updateMeta(selector, value) {
  document.querySelector(selector)?.setAttribute("content", value);
}

function applyLanguage(next, persist = false) {
  language = next === "zh" ? "zh" : "en";
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  translatedNodes.forEach((node) => {
    node.textContent = text(node.dataset.i18n);
  });
  document.title = ui[language].title;
  updateMeta('meta[name="description"]', ui[language].description);
  updateMeta('meta[property="og:title"]', ui[language].shareTitle);
  updateMeta('meta[property="og:description"]', ui[language].shareDescription);
  updateMeta('meta[property="og:image:alt"]', ui[language].shareImageAlt);
  document.querySelector("nav")?.setAttribute("aria-label", ui[language].navigation);
  document.querySelector(".product-mapping")?.setAttribute("aria-label", ui[language].mapping);
  document.querySelector(".site-header .brand")?.setAttribute("aria-label", ui[language].home);
  if (languageButton) {
    languageButton.textContent = language === "zh" ? "EN" : "中文";
    languageButton.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换到中文");
    languageButton.setAttribute("lang", language === "zh" ? "en" : "zh-CN");
  }
  copyButtons.forEach(renderCopyButton);
  renderPlayback();
  if (!persist) return;
  try {
    window.localStorage.setItem(storageKey, language);
  } catch {
    // A language preference is optional, not a prerequisite.
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("lang", language);
    window.history.replaceState(null, "", url);
  } catch {
    // Keep the toggle usable in restricted or file:// previews.
  }
}

copyButtons.forEach((button) => {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const value = button.dataset.copy;
    if (!value || button.disabled) return;
    button.disabled = true;
    const timer = copyTimers.get(button);
    if (timer) window.clearTimeout(timer);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      button.dataset.copyState = "copied";
      button.classList.add("copied");
      renderCopyButton(button);
      announce(ui[language].copySuccess);
      copyTimers.set(button, window.setTimeout(() => {
        delete button.dataset.copyState;
        button.classList.remove("copied");
        renderCopyButton(button);
        copyTimers.delete(button);
      }, 1800));
    } catch {
      delete button.dataset.copyState;
      button.classList.remove("copied");
      renderCopyButton(button);
      announce(ui[language].copyFallback);
      window.prompt(ui[language].copyPrompt, value);
    } finally {
      button.disabled = false;
    }
  });
});

function startDemo() {
  if (!demoImage || playing || document.hidden) return;
  playing = true;
  demoImage.src = demoImage.dataset.demoMotion;
  renderPlayback();
}

function maybeAutoplay() {
  if (autoPlayUsed || !demoVisible || document.hidden || reducedMotion.matches) return;
  if (!demoImage?.hasAttribute("data-demo-autoplay")) return;
  autoPlayUsed = true;
  startDemo();
}

function stopDemo() {
  if (!demoImage || !playing) return;
  playing = false;
  demoImage.src = demoImage.dataset.demoStill;
  renderPlayback();
}

if (demoImage) {
  if (demoButton) {
    demoButton.hidden = false;
    demoButton.addEventListener("click", () => {
      autoPlayUsed = true;
      if (playing) stopDemo(); else startDemo();
    });
  }
  demoImage.addEventListener("error", () => {
    if (!playing) return;
    stopDemo();
    announce(ui[language].demoError);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopDemo(); else maybeAutoplay();
  });
  window.addEventListener("pagehide", stopDemo);
  reducedMotion.addEventListener?.("change", event => {
    if (event.matches) stopDemo(); else maybeAutoplay();
  });
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      demoVisible = entry.isIntersecting && entry.intersectionRatio >= 0.35;
      if (!entry.isIntersecting) stopDemo(); else maybeAutoplay();
    }, { threshold: [0, 0.35] });
    observer.observe(demoImage);
  } else {
    demoVisible = true;
    maybeAutoplay();
  }
}

if (languageButton) {
  languageButton.hidden = false;
  languageButton.addEventListener("click", () => {
    applyLanguage(language === "en" ? "zh" : "en", true);
  });
}

applyLanguage(language);

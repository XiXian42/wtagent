import { BaseWebAdapter, firstVisible, hasCompleteAgentEnvelope } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const KIMI_URL = "https://www.kimi.com/";

// Kimi (www.kimi.com, Moonshot) adapter.
//
// Kimi's chat DOM is clean and semantic, verified against the live app:
//   - composer: a Lexical contenteditable `.chat-input-editor` (like ChatGPT),
//     so the base fill/keyboard path works; the send control is
//     `.send-button-container` (disabled when empty), and Enter also sends
//   - messages: `.chat-content-item.chat-content-item-user` and
//     `.chat-content-item.chat-content-item-assistant`
//   - every message carries a STABLE per-message UUID in `data-archer-id`, so
//     the base's default id-based identity ladder works directly (no volatile
//     virtual-list key like DeepSeek)
//   - assistant replies may include a `.thinking-container` reasoning block
//     before the answer; assistantText reads the answer markdown outside it
//   - a live conversation URL is /chat/<uuid>
//   - a model switcher (`.current-model`) opens a Naive-UI popover
//     (`.models-container .model-item`); WTAgent defaults it to K3 — see
//     selectMode.
export class KimiWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? KIMI_URL,
      providerName: "Kimi",
    });
  }

  conversationUrlPattern() {
    return /^\/chat\//;
  }

  composerLocators() {
    return [
      this.page.locator(".chat-input-editor"),
      this.page.locator('div[contenteditable="true"][data-lexical-editor="true"]'),
      this.page.locator('main div[contenteditable="true"]'),
      this.page.locator('textarea'),
    ];
  }

  sendButtonLocators() {
    // The send control is a div, not a <button>; it carries `disabled` in its
    // class when the composer is empty. firstVisible + isEnabled won't detect
    // the class-based disable, so the base's Enter fallback is the reliable
    // path — these are best-effort only.
    return [
      this.page.locator(".send-button-container:not(.disabled)"),
      this.page.getByRole("button", { name: /send|发送/i }),
    ];
  }

  // Kimi shows no persistent labeled stop button; generation liveness is not
  // proven by a stop control, so the wider dead-request grace applies (below).
  stopButtonLocators() {
    return [
      this.page.getByRole("button", { name: /stop|停止|中断/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.getByRole("button", { name: /新建会话|新对话|new chat/i }),
      this.page.getByRole("link", { name: /新建会话|新对话|new chat/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", { name: /^(登录|log in|sign in)$/i }),
    ];
  }

  authTextPattern() {
    return /手机号快捷登录|手机号登录|发送验证码|登录以同步|log in to sync|sign in/i;
  }

  assistantMessages() {
    return this.page.locator(".chat-content-item-assistant");
  }

  userMessages() {
    return this.page.locator(".chat-content-item-user");
  }

  conversationMessages() {
    return this.page.locator(".chat-content-item");
  }

  // Kimi tags every message with a stable UUID in data-archer-id — a genuine
  // per-message id, so the base id-based identity ladder works unchanged.
  async messageIdentity(message) {
    const id = await message.getAttribute("data-archer-id").catch(() => null);
    return { id, turn: null };
  }

  async assistantText(message) {
    // Prefer the visible answer markdown. Native-tool cards and thinking
    // blocks share `.markdown` too, so exclude those first; if the only text
    // left is a mid-tool failure such as "文件阅读失败", keep waiting for the
    // later protocol envelope instead of treating that card as the reply.
    // `.markdown` is nested inside `.markdown-container`. Selecting both
    // duplicates the same reply (Kimi then looks like it emitted two envelopes).
    const answer = message.locator(
      ".markdown:not(.thinking-container .markdown):not(.toolcall-container .markdown)",
    );
    if (await answer.count().catch(() => 0)) {
      const chunks = [];
      const seen = new Set();
      const count = await answer.count();
      for (let index = 0; index < count; index += 1) {
        const text = (await answer.nth(index).innerText().catch(() => "")).trim();
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);
        chunks.push(text);
      }
      const joined = chunks.join("\n");
      if (joined.includes("<agent_response") || !this.#isNativeToolPlaceholder(joined)) {
        return joined;
      }
    }
    return await message.innerText().catch(() => "");
  }

  #isNativeToolPlaceholder(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || trimmed.includes("<agent_response")) {
      return false;
    }
    return /文件阅读失败|文件读取失败|阅读失败|read file failed|tool (?:call )?failed/i.test(trimmed);
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating(message) {
    if (await this.#isNativeToolRunning(message)) {
      return true;
    }
    // Kimi renders the action bar (.segment-assistant-actions — copy/share/…
    // icons) under a reply only once it has FULLY finished streaming. Its
    // absence is the reliable completion signal: a structural DOM check that
    // does not depend on localized status text ("思考中" vs "思考已完成"), so
    // a mid-stream pause can never read as a finished reply.
    return await message
      .locator(".segment-assistant-actions")
      .count()
      .catch(() => 0) === 0;
  }

  async extraStableWindowMs(message, text) {
    if (hasCompleteAgentEnvelope(text)) {
      return 0;
    }
    if (await this.#hasNativeToolCard(message) || this.#isNativeToolPlaceholder(text)) {
      return 8_000;
    }
    return 0;
  }

  async #isNativeToolRunning(message) {
    // Completed cards show completion markers: 已完成/失败, or a result count
    // ("9 个结果" / "N 条结果" / "N results") for a finished web search. Only a
    // card free of ALL markers can be in flight.
    const running = message.locator(
      ".toolcall-container:not(.thinking-container):not(:has-text('已完成')):not(:has-text('失败'))"
      + ":not(:has-text('个结果')):not(:has-text('条结果')):not(:has-text('results')), "
      + ".toolcall-title-container:not(.thinking-container .toolcall-title-container)",
    );
    if (await running.count().catch(() => 0) === 0) {
      return false;
    }
    const title = await running.first().innerText().catch(() => "");
    if (/已完成|失败|failed|个结果|条结果|results/i.test(title)) {
      return false;
    }
    return /阅读|读取|搜索|执行|运行中|running|reading|searching/i.test(title);
  }

  async #hasNativeToolCard(message) {
    const cards = message.locator(
      ".toolcall-container:not(.thinking-container), "
      + ".toolcall-title-container:not(.thinking-container .toolcall-title-container)",
    );
    return await cards.count().catch(() => 0) > 0;
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /重试|重新生成|retry|升级|upgrade/i }),
      message.locator('[class*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  // Kimi does not expose a persistent stop button, so — like DeepSeek — the
  // silent phase before the first token must not be misread as a dead request.
  deadRequestGraceMultiplier() {
    return 5;
  }

  // Kimi has a model switcher (快速 / K3 / K3 集群). The registry's defaultMode
  // "k3" asks to switch to K3 ("擅长对话与 Agent 任务，全能旗舰") on every fresh
  // conversation, silently. Any other value keeps the current model.
  //
  // The switcher is `.current-model`; it opens a Naive-UI popover whose rows are
  // `.models-container .model-item`, the selected one carrying `checked`. After
  // selecting, the switcher label starts with the model name (e.g. "K3 进阶").
  // Best-effort and non-throwing, mirroring runModeSelection's contract.
  async selectMode(mode) {
    this.requirePage();
    if (mode !== "k3") {
      return { status: "skipped", requested: mode, attempts: 0 };
    }

    const switcher = this.page.locator(".current-model").first();
    // The switcher can mount a beat after the composer on a fresh conversation;
    // wait briefly before concluding it is absent.
    await switcher.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null);
    if (await switcher.count().catch(() => 0) === 0) {
      await this.writeDiagnostics("kimi-model-switcher-not-found");
      return {
        status: "switcher_not_found",
        requested: mode,
        attempts: 0,
        reason: "Model switcher was not found.",
      };
    }

    // Already on K3? The switcher label starts with "K3" (but not "K3 集群").
    const label = (await switcher.innerText().catch(() => "")).trim();
    if (/^K3(?!\s*集群)/.test(label)) {
      return {
        status: "already",
        requested: mode,
        selectedLabel: "K3",
        attempts: 0,
        reason: "Already using K3.",
      };
    }

    await switcher.click({ timeout: 5_000 }).catch(() => null);
    await this.page.locator(".models-container .model-item")
      .first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);

    // Click the row whose title line is exactly "K3" (not "快速" / "K3 集群").
    const k3 = this.page.locator(".models-container .model-item").filter({
      hasText: /^K3(?!\s*集群)/,
    }).first();
    const clicked = await k3.count().catch(() => 0) > 0
      && await k3.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await this.page.waitForTimeout(500);

    const after = (await switcher.innerText().catch(() => "")).trim();
    if (clicked && /^K3(?!\s*集群)/.test(after)) {
      return {
        status: "select",
        requested: mode,
        selectedLabel: "K3",
        attempts: 1,
        reason: "Selected K3.",
      };
    }
    await this.page.keyboard.press("Escape").catch(() => null);
    await this.writeDiagnostics("kimi-mode-k3-unresolved");
    return {
      status: "unresolved",
      requested: mode,
      attempts: 1,
      reason: "Could not confirm K3 was selected.",
    };
  }
}

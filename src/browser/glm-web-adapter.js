import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const GLM_URL = "https://chat.z.ai/";

// Preferred models, newest first: try GLM-5.3 when present, else GLM-5.2. The
// site sometimes exposes 5.3 and sometimes only 5.2, so selection walks this
// list and clicks the first one present in the menu.
const PREFERRED_MODELS = ["GLM-5.3", "GLM-5.2"];

// GLM / Z.ai (chat.z.ai) adapter.
//
// chat.z.ai is an Open WebUI (Svelte) frontend, verified against the live app:
//   - composer: `textarea#chat-input` (placeholder "有什么我能帮您的？" / "有什么我能帮您的?")
//   - messages: `#messages-container [id^="message-<uuid>"]`, each id carrying a
//     STABLE per-message UUID; the user row has class `user-message`, the
//     assistant row instead contains `#response-content-container`. So identity
//     uses the base's default id-based ladder (like Kimi, unlike DeepSeek).
//   - assistant answer markdown is `.markdown-prose` / `.prose`; a "思考过程"
//     (deep-thinking) block may precede it and is excluded when reading the reply
//   - a live conversation URL is /c/<uuid>
//   - model switcher: `button.modelSelectorButton`; the registry defaultMode
//     "latest" picks the newest available model (GLM-5.3, else GLM-5.2)
//   - Cloudflare guards the site; the base throwIfBlockedPage surfaces the
//     window so the user can pass the check (wtagent's own CDP launch is not
//     fingerprinted the way headless automation is)
export class GLMWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? GLM_URL,
      providerName: "GLM",
    });
  }

  conversationUrlPattern() {
    return /^\/c\//;
  }

  composerLocators() {
    return [
      this.page.locator("#chat-input"),
      this.page.locator('textarea[placeholder*="帮您"]'),
      this.page.locator("main textarea"),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator("#send-message-button"),
      this.page.getByRole("button", { name: /send|发送/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator("#stop-response-button"),
      this.page.getByRole("button", { name: /stop|停止|中断/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator("#sidebar-new-chat-button"),
      this.page.getByRole("button", { name: /新聊天|新建聊天|新对话|new chat/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", { name: /^登录$|^log in$|^sign in$/i }),
    ];
  }

  // Logged-out visitors are redirected to /auth — a locale-independent signal.
  authUrlPattern() {
    return /^\/auth/;
  }

  authTextPattern() {
    return /手机号登录|发送验证码|欢迎回来|登录即表示同意|sign in|log in|send code|welcome back/i;
  }

  assistantMessages() {
    // Assistant message rows: a stable-id message that is NOT the user row.
    return this.page.locator(
      '#messages-container [id^="message-"]:not([id$="-start"]):not(.user-message)',
    );
  }

  userMessages() {
    return this.page.locator(
      '#messages-container [id^="message-"]:not([id$="-start"]).user-message',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '#messages-container [id^="message-"]:not([id$="-start"])',
    );
  }

  // Each message row carries a stable UUID in its element id (message-<uuid>),
  // so the base's default id-based identity ladder works directly.
  async messageIdentity(message) {
    const raw = await message.getAttribute("id").catch(() => null);
    const id = raw ? raw.replace(/^message-/, "") : null;
    return { id, turn: null };
  }

  async assistantText(message) {
    // GLM (with 深度思考 on) often renders the whole reply — including the
    // protocol XML — inside a `思考过程` thinking-chain block, and streams a
    // "正在思考 / 跳过" placeholder first. Rather than try to isolate a separate
    // answer node (there often isn't one), return the full message text: the
    // protocol parser tolerates the leading 思考过程 text and extracts the
    // <agent_response> envelope.
    return await message.innerText().catch(() => "");
  }

  // Structural completion signal — the same idea as Kimi's action bar, and
  // fully locale-independent: GLM renders the response action bar
  // (.copy-response-button / .regenerate-response-button) under an assistant
  // message only after it has FULLY finished streaming. While generating (or
  // during the 深度思考 thinking phase), those Svelte slots stay empty, so no
  // buttons exist yet. This also covers the blank row GLM mounts a few seconds
  // before the first token: no buttons = still generating.
  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating(message) {
    const buttons = message.locator(
      ".copy-response-button, .regenerate-response-button",
    );
    return await buttons.count().catch(() => 0) === 0;
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

  // GLM keeps 深度思考 on and shows no persistent stop button, so — like DeepSeek
  // and Kimi — the silent phase before the first token must not be misread as a
  // dead request.
  deadRequestGraceMultiplier() {
    return 5;
  }

  sentUserWaitAttempts() {
    return 120;
  }

  // Selects the newest available model. The registry's defaultMode "latest" maps
  // to PREFERRED_MODELS (GLM-5.3, else GLM-5.2). Best-effort and non-throwing.
  //
  // The switcher is `button.modelSelectorButton`; opening it lists options whose
  // visible text is the exact model name. After clicking, the switcher label
  // becomes the selected model name.
  async selectMode(mode) {
    this.requirePage();
    if (mode !== "latest") {
      return { status: "skipped", requested: mode, attempts: 0 };
    }

    const switcher = this.page.locator("button.modelSelectorButton").first();
    await switcher.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null);
    if (await switcher.count().catch(() => 0) === 0) {
      await this.writeDiagnostics("glm-model-switcher-not-found");
      return {
        status: "switcher_not_found",
        requested: mode,
        attempts: 0,
        reason: "Model switcher was not found.",
      };
    }

    const current = (await switcher.innerText().catch(() => "")).trim();
    // Already on the most-preferred model that exists? If the current label is
    // the first preferred model, nothing to do.
    if (current.startsWith(PREFERRED_MODELS[0])) {
      return {
        status: "already",
        requested: mode,
        selectedLabel: PREFERRED_MODELS[0],
        attempts: 0,
        reason: `Already using ${PREFERRED_MODELS[0]}.`,
      };
    }

    for (const model of PREFERRED_MODELS) {
      await switcher.click({ timeout: 5_000 }).catch(() => null);
      await this.page.waitForTimeout(600);
      const option = this.page.getByText(model, { exact: true }).first();
      if (await option.count().catch(() => 0) === 0) {
        // Not in the menu; close and try the next preferred model.
        await this.page.keyboard.press("Escape").catch(() => null);
        continue;
      }
      await option.click({ timeout: 5_000 }).catch(() => null);
      await this.page.waitForTimeout(600);
      const after = (await switcher.innerText().catch(() => "")).trim();
      if (after.startsWith(model)) {
        // The model menu stays open after a selection; a click in the page
        // center dismisses it so it does not cover the composer.
        await this.#dismissModelMenu();
        return {
          status: current.startsWith(model) ? "already" : "select",
          requested: mode,
          selectedLabel: model,
          attempts: 1,
          reason: `Selected ${model}.`,
        };
      }
    }

    await this.#dismissModelMenu();
    await this.writeDiagnostics("glm-mode-latest-unresolved");
    return {
      status: "unresolved",
      requested: mode,
      attempts: 1,
      reason: `Could not select any of: ${PREFERRED_MODELS.join(", ")}.`,
    };
  }

  async #dismissModelMenu() {
    const viewport = this.page.viewportSize?.() ?? { width: 1280, height: 800 };
    await this.page.mouse.click(
      Math.floor(viewport.width / 2),
      Math.floor(viewport.height / 2),
    ).catch(() => null);
    await this.page.keyboard.press("Escape").catch(() => null);
    await this.page.waitForTimeout(200);
  }
}

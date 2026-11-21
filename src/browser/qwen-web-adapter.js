import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const QWEN_URL = "https://chat.qwen.ai/";

// Qwen (chat.qwen.ai / Tongyi Qianwen) adapter.
//
// Qwen's web interface (chat.qwen.ai) exposes:
//   - composer: textarea.message-input-textarea
//   - send button: button.send-button (enabled when text is present)
//   - stop button: button.stop-button
//   - message rows: .qwen-chat-message (.qwen-chat-message-user, .qwen-chat-message-assistant)
//   - thinking: .qwen-chat-thinking-status-card (excluded when reading assistantText)
//   - live conversation URLs: /c/<uuid>
export class QwenWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? QWEN_URL,
      providerName: "Qwen",
    });
  }

  conversationUrlPattern() {
    return /^\/c\//;
  }

  classifyConversationUrl(value) {
    const kind = super.classifyConversationUrl(value);
    if (kind !== "restorable") {
      return kind;
    }
    const parsed = value instanceof URL ? value : new URL(value);
    // Qwen briefly transitions from / to /c/new-chat before assigning the durable /c/<uuid>
    return /^\/c\/(?:new-chat|new)\/?$/i.test(parsed.pathname)
      ? "provisional"
      : "restorable";
  }

  composerLocators() {
    return [
      this.page.locator("textarea.message-input-textarea"),
      this.page.locator('textarea[placeholder*="Qwen" i]'),
      this.page.locator('textarea[placeholder*="千问"]'),
      this.page.locator("main textarea"),
      this.page.locator('div[contenteditable="true"]'),
      this.page.locator("textarea"),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator("button.send-button"),
      this.page.locator('.chat-prompt-send-button button, [class*="send-button"]'),
      this.page.locator('button[aria-label*="send" i]'),
      this.page.locator('button[aria-label*="发送"]'),
      this.page.getByRole("button", { name: /send|发送/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator("button.stop-button"),
      this.page.locator('.chat-prompt-send-button button:has(.icon-stop), [class*="stop-button"]'),
      this.page.locator('button[aria-label*="stop" i]'),
      this.page.locator('button[aria-label*="停止"]'),
      this.page.getByRole("button", { name: /stop|停止/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator(".sidebar-entry-fixed-list-content"),
      this.page.getByRole("button", { name: /^(new chat|新建对话|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新建对话|新对话)$/i }),
      this.page.locator('a[href="/"]'),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", {
        name: /^(log in|sign in|登录|登入)$/i,
      }),
      this.page.getByRole("link", {
        name: /^(log in|sign in|登录|登入)$/i,
      }),
    ];
  }

  authUrlPattern() {
    return /^\/(?:login|signin|sign-in|auth)(?:\/|$)/i;
  }

  authTextPattern() {
    return /sign in to qwen|log in to qwen|continue with google|continue with apple|continue with github|登录通义千问|登录 Qwen|手机号登录/i;
  }

  assistantMessages() {
    return this.page.locator(
      ".qwen-chat-message.qwen-chat-message-assistant, .qwen-chat-message-assistant",
    );
  }

  userMessages() {
    return this.page.locator(
      ".qwen-chat-message.qwen-chat-message-user, .qwen-chat-message-user",
    );
  }

  conversationMessages() {
    return this.page.locator(".qwen-chat-message");
  }

  async assistantText(message) {
    const content = message.locator(
      ".response-message-content, .custom-qwen-markdown, .qwen-markdown",
    );
    if (await content.count().catch(() => 0) > 0) {
      const text = await content.last().innerText().catch(() => "");
      if (text.includes("<agent_response") || text.includes("<tool_call") || text.trim()) {
        return text.replaceAll("\u00a0", " ");
      }
    }
    const raw = await message.innerText().catch(() => "");
    return raw.replaceAll("\u00a0", " ");
  }

  async userMessageText(message) {
    const content = message.locator(".chat-user-message, .user-message-content");
    if (await content.count().catch(() => 0) > 0) {
      const text = await content.first().innerText().catch(() => "");
      if (text.trim()) {
        return text.replaceAll("\u00a0", " ");
      }
    }
    const raw = await super.userMessageText(message);
    return raw.replaceAll("\u00a0", " ");
  }

  async messageIdentity(message) {
    const isAssistant = await message
      .evaluate((el) => el.classList.contains("qwen-chat-message-assistant"))
      .catch(() => false);
    const scope = isAssistant ? this.assistantMessages() : this.userMessages();
    const turn = await scope.count().catch(() => 0);

    const id = await message.evaluate((el) => {
      const userContainer = el.querySelector(".chat-user-message-container");
      const assistantContainer = el.querySelector(".chat-response-message");
      const userId = el.getAttribute("data-msg-id")
        || userContainer?.getAttribute("data-msg-id")
        || null;
      const assistantRawId = assistantContainer?.id || el.id || null;
      return userId || (assistantRawId ? assistantRawId.replace(/^chat-response-message-/, "") : null);
    }).catch(() => null);

    return { id: id || null, turn };
  }

  isNewAssistantIdentity({ id, turn, text }) {
    if (id && !this.assistantIdsBeforeSend.has(id)) {
      return true;
    }
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return Boolean(previous && String(text ?? "") !== previous);
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating() {
    return Boolean(await firstVisible(this.stopButtonLocators()));
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /重试|重新生成|retry|try again/i }),
      message.locator('[class*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }
}

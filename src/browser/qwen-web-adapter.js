import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const QWEN_URL = "https://chat.qwen.ai/";

// Qwen (chat.qwen.ai / Tongyi Qianwen) adapter.
//
// Qwen's web interface (chat.qwen.ai) supports:
//   - composer: textarea or [contenteditable="true"] input element
//   - live conversation URLs: /c/<uuid>
//   - send button: labeled send / submit button or SVG icon button; base Enter fallback also sends
//   - stop button: stop generation control
//   - new chat: new conversation buttons/links
//   - login controls: sign in / log in buttons, OAuth providers (Google, GitHub, Apple)
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

  composerLocators() {
    return [
      this.page.locator('textarea[placeholder*="Qwen" i]'),
      this.page.locator('textarea[placeholder*="千问"]'),
      this.page.locator('main textarea'),
      this.page.locator('main [contenteditable="true"]'),
      this.page.locator('div[contenteditable="true"]'),
      this.page.locator("textarea"),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label*="send" i]'),
      this.page.locator('button[aria-label*="发送"]'),
      this.page.getByRole("button", { name: /send|发送/i }),
      this.page.locator('button[type="submit"]'),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label*="stop" i]'),
      this.page.locator('button[aria-label*="停止"]'),
      this.page.getByRole("button", { name: /stop|停止/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.getByRole("button", { name: /^(new chat|新建对话|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新建对话|新对话)$/i }),
      this.page.locator('[data-testid="new-chat"]'),
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
      '[data-message-role="assistant"], .qwen-assistant-message, [class*="assistant-message"]',
    );
  }

  userMessages() {
    return this.page.locator(
      '[data-message-role="user"], .qwen-user-message, [class*="user-message"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '[data-message-role], .qwen-assistant-message, .qwen-user-message, [class*="message"]',
    );
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

import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";
import { readRenderedBlocks } from "./rendered-text.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const GROK_URL = "https://grok.com/";

export class GrokWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? GROK_URL,
      providerName: "Grok",
    });
  }

  conversationUrlPattern() {
    return /^\/c\//;
  }

  composerLocators() {
    return [
      // Grok replaces its initial textarea with a role=textbox editor during
      // hydration. Keep both variants in one live locator so a composer found
      // just before that replacement does not become an empty stale selector
      // by the time sendMessage fills it.
      this.page.locator('main textarea, main [role="textbox"]').first(),
      this.page.locator("textarea[aria-label]").first(),
      this.page.locator('[role="textbox"]').first(),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label*="send" i]'),
      this.page.locator('button[aria-label*="发送"]'),
      this.page.locator('button[type="submit"]'),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label*="停止模型响应"]'),
      this.page.locator('button[aria-label*="stop" i]'),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('[data-testid="new-chat"]'),
      this.page.locator('a[href="/"]'),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", {
        name: /^(log in|sign in|登录|登入|ログイン|로그인)$/i,
      }),
      this.page.getByRole("link", {
        name: /^(log in|sign in|登录|登入|ログイン|로그인)$/i,
      }),
    ];
  }

  authUrlPattern() {
    return /^\/(?:sign-in|signin|login|auth)(?:\/|$)/i;
  }

  authTextPattern() {
    return /sign in to grok|log in to grok|continue with x|continue with google|登录 Grok|登入 Grok/i;
  }

  assistantMessages() {
    return this.page.locator('[data-testid="assistant-message"]');
  }

  userMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [role="article"][aria-label="You"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [data-testid="assistant-message"], '
        + '[role="article"][aria-label="You"]',
    );
  }

  async userMessageText(message) {
    const markdown = message.locator(".response-content-markdown");
    if (await markdown.count().catch(() => 0) > 0) {
      const exact = await markdown.evaluateAll(readRenderedBlocks);
      if (exact.trim()) return exact;
    }
    return await super.userMessageText(message);
  }

  async messageIdentity(message) {
    const testId = await message.getAttribute("data-testid").catch(() => null);
    const aria = await message.getAttribute("aria-label").catch(() => null);
    const scope = testId === "user-message" || aria === "You"
      ? this.userMessages()
      : this.assistantMessages();
    // Grok wraps every visible user/assistant bubble in a stable response UUID:
    //
    //   <div id="response-..." data-scroll-anchor-root>
    //     <div data-testid="user-message|assistant-message">...</div>
    //   </div>
    //
    // Keep the count fallback for older DOM variants, but prefer the wrapper
    // identity whenever it is present. Besides making normal multi-turn
    // correlation stronger, this lets a fresh chat safely follow Grok's late
    // root -> /c/... navigation after the user bubble has already committed.
    const id = await message.evaluate((element) => (
      element.closest('[data-scroll-anchor-root][id^="response-"]')?.id
        ?? element.closest('[id^="response-"]')?.id
        ?? null
    )).catch(() => null);
    return {
      id: id || null,
      turn: await scope.count().catch(() => 0),
    };
  }

  isNewAssistantIdentity({ turn, text }) {
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return Boolean(previous && String(text ?? "") !== previous);
  }

  async assistantText(message) {
    const response = message.locator(".response-content-markdown");
    if (await response.count().catch(() => 0) > 0) {
      return await response.evaluateAll(readRenderedBlocks);
    }
    return await message.innerText().catch(() => "");
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating() {
    return Boolean(await firstVisible(this.stopButtonLocators()));
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) return null;
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|upgrade|重试|升级/i }),
      this.page.getByRole("button", { name: /retry|try again|upgrade|重试|升级/i }),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  async findGenerationErrorMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!/something went wrong|failed to generate|generation failed|try again|生成失败|出错了/i.test(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|重试|重新生成/i }),
      this.page.getByRole("button", { name: /retry|try again|重试|重新生成/i }),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  deadRequestGraceMultiplier() {
    return 3;
  }
}

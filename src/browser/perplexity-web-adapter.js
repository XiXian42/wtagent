import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const PERPLEXITY_URL = "https://www.perplexity.ai/";

// Perplexity (perplexity.ai) adapter.
export class PerplexityWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? PERPLEXITY_URL,
      providerName: "Perplexity",
    });
  }

  conversationUrlPattern() {
    return /^\/(?:search|p)\//;
  }

  classifyConversationUrl(value) {
    let parsed;
    try {
      parsed = value instanceof URL ? value : new URL(value);
    } catch {
      return "invalid";
    }
    if (parsed.protocol !== "https:") return "invalid";
    if (!["www.perplexity.ai", "perplexity.ai"].includes(parsed.hostname)) {
      return "invalid";
    }
    const pattern = this.conversationUrlPattern();
    if (this.authUrlPattern()?.test(parsed.pathname)) {
      return "unknown";
    }
    if (pattern?.test(parsed.pathname)) {
      return "restorable";
    }
    const isFresh = parsed.pathname === "/" || parsed.pathname === "/search";
    return isFresh ? "fresh" : "unknown";
  }

  composerLocators() {
    return [
      this.page.locator('textarea[placeholder*="Ask anything" i]').first(),
      this.page.locator('textarea[placeholder*="Ask follow-up" i]').first(),
      this.page.locator('textarea[placeholder*="Ask a question" i]').first(),
      this.page.locator('textarea[placeholder*="Search" i]').first(),
      this.page.locator('div[contenteditable="true"]').first(),
      this.page.locator("main textarea").first(),
      this.page.locator("textarea").first(),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label*="Submit" i]'),
      this.page.locator('button[aria-label*="Send" i]'),
      this.page.locator('button[aria-label*="Ask" i]'),
      this.page.getByRole("button", { name: /^(submit|send|ask|发送)$/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label*="Stop" i]'),
      this.page.locator('button[title*="Stop" i]'),
      this.page.getByRole("button", { name: /^(stop|停止)$/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('button[aria-label*="New thread" i]'),
      this.page.locator('a[href="/"]'),
      this.page.getByRole("button", { name: /^(new thread|new chat|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new thread|new chat|新对话)$/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.locator('button:has-text("Continue with Google")'),
      this.page.locator('button:has-text("Continue with Apple")'),
      this.page.locator('button:has-text("Sign in")'),
      this.page.locator('button:has-text("Log in")'),
      this.page.locator('button:has-text("Sign Up")'),
      this.page.locator('a[href*="/login"]'),
      this.page.locator('a[href*="/signin"]'),
      this.page.locator('input[type="email"]'),
      this.page.getByRole("button", { name: /^(sign in|log in|sign up|continue with google|continue with apple|登录|登入)$/i }),
      this.page.getByRole("link", { name: /^(sign in|log in|sign up|登录|登入)$/i }),
    ];
  }

  authUrlPattern() {
    return /^\/(?:login|signin|auth|join|session)(?:\/|$)/i;
  }

  authTextPattern() {
    return /sign up below to unlock|sign in to perplexity|continue with google|continue with apple|log in to perplexity|enter your email|登录 Perplexity/i;
  }

  async canUseGuest() {
    return false;
  }

  assistantMessages() {
    return this.page.locator(
      '[data-testid="answer"], [data-testid="assistant-message"], div.prose, [dir="auto"].prose',
    );
  }

  userMessages() {
    return this.page.locator(
      '[data-testid="user-query"], [data-testid="user-message"], [data-testid="message-user"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '[data-testid="user-query"], [data-testid="user-message"], [data-testid="message-user"], [data-testid="answer"], [data-testid="assistant-message"], div.prose',
    );
  }

  async messageIdentity(message) {
    const testId = await message.getAttribute("data-testid").catch(() => null);
    const isUser = testId === "user-query" || testId === "user-message" || testId === "message-user";
    const scope = isUser ? this.userMessages() : this.assistantMessages();
    const id = await message.getAttribute("id").catch(() => null)
      ?? await message.getAttribute("data-message-id").catch(() => null);
    return {
      id: id || null,
      turn: await scope.count().catch(() => 0),
    };
  }

  isNewAssistantIdentity({ id, turn, text }) {
    if (id && this.lastAssistantMessageIdBeforeSend && id !== this.lastAssistantMessageIdBeforeSend) {
      return true;
    }
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return Boolean(previous && String(text ?? "") !== previous);
  }

  async assistantText(message) {
    const textNode = message.locator('.prose, [data-testid="message-content"]');
    if (await textNode.count().catch(() => 0) > 0) {
      const text = await textNode.last().innerText().catch(() => "");
      if (text.trim()) {
        return text.replaceAll("\u00a0", " ");
      }
    }
    const text = await message.innerText().catch(() => "");
    return text.replaceAll("\u00a0", " ");
  }

  async userMessageText(message) {
    const text = await super.userMessageText(message);
    return text.replaceAll("\u00a0", " ");
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
      message.getByRole("button", { name: /retry|try again|重试/i }),
      this.page.getByRole("button", { name: /retry|try again|重试/i }),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  deadRequestGraceMultiplier() {
    return 3;
  }
}

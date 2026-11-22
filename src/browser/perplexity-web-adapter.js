import {
  BaseWebAdapter,
  firstVisible,
  readRenderedOutboundCorrelationId,
  renderedMessageContainsOutboundMarker,
} from "./base-web-adapter.js";
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
    return /^\/(?:search|p|session)\//;
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
    if (this.authUrlPattern()?.test(parsed.pathname)) {
      return "unknown";
    }
    // Perplexity creates a temporary /search/new/<uuid> route before replacing
    // it with the durable /session/<uuid> conversation. Classify /search/new/
    // as provisional so BaseWebAdapter tracks the transition cleanly.
    if (/^\/search\/new\//i.test(parsed.pathname)) {
      return "provisional";
    }
    const pattern = this.conversationUrlPattern();
    if (pattern?.test(parsed.pathname)) {
      return "restorable";
    }
    const isFresh = parsed.pathname === "/" || parsed.pathname === "/search";
    return isFresh ? "fresh" : "unknown";
  }

  composerLocators() {
    return [
      this.page.locator('div[contenteditable="true"].composer-editable').first(),
      this.page.locator('div[contenteditable="true"]').first(),
      this.page.locator('textarea[placeholder*="Ask anything" i]').first(),
      this.page.locator('textarea[placeholder*="Ask follow-up" i]').first(),
      this.page.locator('textarea[placeholder*="Ask a question" i]').first(),
      this.page.locator('textarea[placeholder*="Search" i]').first(),
      this.page.locator("main textarea").first(),
      this.page.locator("textarea").first(),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label="Submit" i]'),
      this.page.locator('button[aria-label="Send" i]'),
      this.page.locator('button[aria-label="Ask" i]'),
      this.page.locator('button[title="Submit" i]'),
      this.page.locator('button[title="Send" i]'),
      this.page.locator('button[title="Ask" i]'),
      this.page.getByRole("button", { name: /^(submit|send|ask|发送)$/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label="Stop generating" i]'),
      this.page.locator('button[aria-label="Stop" i]'),
      this.page.locator('button[title="Stop generating" i]'),
      this.page.locator('button[title="Stop" i]'),
      this.page.getByRole("button", { name: /^(stop|stop generating|停止|停止生成)$/i }),
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
    return /^\/(?:login|signin|auth|join)(?:\/|$)/i;
  }

  authTextPattern() {
    return /sign up below to unlock|sign in to perplexity|continue with google|continue with apple|log in to perplexity|enter your email|登录 Perplexity/i;
  }

  async canUseGuest() {
    return false;
  }

  assistantMessages() {
    return this.page.locator(
      'div.prose, [data-testid="answer"], [data-testid="assistant-message"], [dir="auto"].prose',
    );
  }

  userMessages() {
    return this.page.locator(
      '.group\\/user-bubble, [data-testid="user-query"], [data-testid="user-message"], [data-testid="message-user"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '.group\\/user-bubble, div.prose, [data-testid="user-query"], [data-testid="user-message"], [data-testid="message-user"], [data-testid="answer"], [data-testid="assistant-message"]',
    );
  }

  async userMessageSnapshot() {
    const messages = this.userMessages();
    if (typeof messages.allInnerTexts !== "function") return super.userMessageSnapshot();
    const texts = await messages.allInnerTexts().catch(() => null);
    return texts?.map((rawText, index) => {
      const renderedText = rawText.replaceAll("\u00a0", " ");
      return {
        id: readRenderedOutboundCorrelationId(renderedText),
        turn: index + 1,
        renderedText,
      };
    }) ?? null;
  }

  async prepareOutboundConfirmation({ outboundId, deadline } = {}) {
    const message = this.userMessages().last();
    const expand = message.locator('button:has-text("Read more"), button[aria-label="Read more" i]');
    if (await expand.count().catch(() => 0) !== 1) return;
    const text = await message.innerText({ timeout: 1000 }).catch(() => "");
    if (renderedMessageContainsOutboundMarker(text, outboundId)) return;
    const remaining = deadline - this.monotonicNow();
    if (!(remaining > 0)) return;
    await expand.click({ timeout: Math.min(1000, Math.ceil(remaining)) }).catch(() => {});
  }

  async messageIdentity(message) {
    const [testId, className] = await Promise.all([
      message.getAttribute("data-testid").catch(() => null),
      message.getAttribute("class").catch(() => null),
    ]);
    const isUser = Boolean(
      (className && className.includes("group/user-bubble"))
      || testId === "user-query"
      || testId === "user-message"
      || testId === "message-user",
    );
    const scope = isUser ? this.userMessages() : this.assistantMessages();
    const rawId = await message.getAttribute("id").catch(() => null)
      ?? await message.getAttribute("data-message-id").catch(() => null);
    const text = isUser ? await this.userMessageText(message) : "";
    const outboundId = isUser ? readRenderedOutboundCorrelationId(text) : null;
    return {
      id: rawId || outboundId || null,
      turn: await scope.count().catch(() => 0),
    };
  }

  sendConfirmationTimeoutMs() {
    return 30_000;
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

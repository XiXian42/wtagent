import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const CLAUDE_URL = "https://claude.ai/";

// Claude.ai adapter. All turn orchestration stays in BaseWebAdapter; this class
// only describes Claude's URL and DOM surface. The selectors prefer stable
// data-testid / ARIA attributes. Tailwind class names are used only where the
// live app currently exposes no semantic message-role attribute.
export class ClaudeWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? CLAUDE_URL,
      providerName: "Claude",
    });
  }

  conversationUrlPattern() {
    return /^\/chat\//;
  }

  composerLocators() {
    return [
      this.page.locator('[data-testid="chat-input"]'),
      this.page.locator('.ProseMirror[contenteditable="true"]'),
      this.page.locator('main div[contenteditable="true"]'),
      this.page.locator('main textarea'),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('[data-testid="chat-input-send"]'),
      this.page.locator('main button[aria-label*="send" i]'),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('[data-testid="chat-input-stop"]'),
      this.page.locator('main button[aria-label*="stop" i]'),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('a[href="/new"]'),
      this.page.getByRole("button", { name: /^(new chat|new conversation|新对话|新聊天)$/i }),
      this.page.getByRole("link", { name: /^(new chat|new conversation|新对话|新聊天)$/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.locator('[data-testid="email"]'),
      this.page.locator('[data-testid="login-with-google"]'),
      this.page.locator('[data-testid="continue"]'),
    ];
  }

  // Signed-out visits currently redirect to /login?from=logout. Keep OAuth and
  // SSO paths in the structural check because they also have no chat composer.
  authUrlPattern() {
    return /^\/(?:login|oauth|sso)(?:\/|$)/;
  }

  authTextPattern() {
    return /continue with google|continue with email|enter your email|sign in to claude|log in to claude|登录 Claude/i;
  }

  // Claude marks each user bubble with data-testid="user-message". Each
  // assistant transcript row contains exactly one node with data-is-streaming
  // ("true" while generating, "false" after completion), making that node a
  // language-independent assistant-row selector as well as a completion signal.
  assistantMessages() {
    return this.page.locator(
      '[data-testid="transcript-row"] [data-is-streaming]',
    );
  }

  userMessages() {
    return this.page.locator('[data-testid="user-message"]');
  }

  conversationMessages() {
    return this.page.locator(
      '[data-testid="user-message"], '
        + '[data-testid="transcript-row"] [data-is-streaming]',
    );
  }

  // Claude's role markers are stable but do not expose a unique per-message id.
  // Use the role-scoped row count as a monotonic boundary, matching the
  // BaseWebAdapter-supported count-baseline strategy.
  async messageIdentity(message) {
    const testId = await message.getAttribute("data-testid").catch(() => null);
    const scope = testId === "user-message"
      ? this.userMessages()
      : this.assistantMessages();
    return { id: null, turn: await scope.count().catch(() => 0) };
  }

  isNewAssistantIdentity({ turn, text }) {
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    // Claude may continue rendering into the current response node. Growth of
    // the send-time baseline is therefore also a new response boundary.
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return Boolean(previous && String(text ?? "") !== previous);
  }

  async assistantText(message) {
    // The streaming wrapper also contains response controls after completion;
    // read only the rendered answer body so Copy/Retry labels never leak into a
    // plain final answer. The class is Claude's semantic typography hook and is
    // kept as a content-only selector, not a turn/completion boundary.
    const response = message.locator(".font-claude-response");
    if (await response.count().catch(() => 0) > 0) {
      return await response.last().innerText().catch(() => "");
    }
    return await message.innerText().catch(() => "");
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating(message) {
    const streaming = await message
      .getAttribute("data-is-streaming")
      .catch(() => null);
    if (streaming === "true") {
      return true;
    }
    if (streaming === "false") {
      return false;
    }
    // Fail closed if the structural attribute disappears: do not accept a
    // potentially mid-stream response based on a short text-stability window.
    return true;
  }

  async attachFiles(files) {
    this.requirePage();
    const paths = (files ?? [])
      .map((file) => (typeof file === "string" ? file : file?.path))
      .filter(Boolean);
    if (paths.length === 0) {
      return { attached: [], failed: [] };
    }

    const input = this.page.locator('[data-testid="file-upload"]').first();
    try {
      await input.setInputFiles(paths, { timeout: 15_000 });
    } catch (error) {
      await this.writeDiagnostics("claude-attach-files-failed");
      return {
        attached: [],
        failed: paths.map((filePath) => ({ path: filePath, message: error.message })),
      };
    }

    // Wait for Claude to mount an attachment chip before sending the text.
    await this.page.locator(
      '[data-testid="file-thumbnail"], [data-testid*="attachment" i], '
        + 'button[aria-label*="remove" i]',
    ).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => null);
    return { attached: [...paths], failed: [] };
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|upgrade|重试|升级/i }),
      message.locator('[data-testid*="limit" i], [data-testid*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  async findGenerationErrorMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!/internal server error|something went wrong|failed to generate|生成失败|出错了/i.test(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|重试|重新生成/i }),
      message.locator('[data-testid*="retry" i], [data-testid*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  // A long-thinking Claude turn may be quiet before the first response node
  // mounts. The visible stop control normally proves liveness; this wider grace
  // prevents a transiently absent control from triggering a false dead request.
  deadRequestGraceMultiplier() {
    return 5;
  }
}

import { BaseWebAdapter, firstVisible, hasCompleteAgentEnvelope } from "./base-web-adapter.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

// Re-exported so existing importers (the runtime and browser-adapter tests)
// keep importing it from here even though it now lives on the provider-agnostic
// base module.
export { isConnectionLostError } from "./base-web-adapter.js";

const CHATGPT_URL = "https://chatgpt.com/";

function parseConversationTurn(value) {
  const match = String(value ?? "").match(/^conversation-turn-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// ChatGPT-specific implementation of the WebModelAdapter contract. Only the
// provider primitives (DOM locators, message identity, upload, overlay
// handling, usage-limit card) live here; all orchestration — launch/auth/send/
// reconnect and the turn-completion loop — is inherited from BaseWebAdapter.
// Model choice is intentionally left to the user in the ChatGPT website.
export class ChatGPTWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? CHATGPT_URL,
      providerName: "ChatGPT",
    });
  }

  // ---- provider primitives ----------------------------------------------

  conversationUrlPattern() {
    return /^\/c\//;
  }

  composerLocators() {
    return [
      this.page.locator("#prompt-textarea"),
      this.page.locator('textarea[placeholder*="Message" i]'),
      this.page.locator('textarea[placeholder*="消息"]'),
      this.page.locator('div[contenteditable="true"][data-lexical-editor="true"]'),
      this.page.locator('main div[contenteditable="true"]'),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('[data-testid="send-button"]'),
      this.page.getByRole("button", { name: /send|发送/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('[data-testid="stop-button"]'),
      this.page.getByRole("button", {
        name: /stop generating|stop|停止生成|停止/i,
      }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('[data-testid="create-new-chat-button"]'),
      this.page.getByRole("button", { name: /^(new chat|新聊天|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新聊天|新对话)$/i }),
      this.page.locator('a[href="/"]'),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", {
        // ChatGPT ships many locales; cover the common ones for the login
        // control. The /auth/ URL check below is the locale-independent
        // primary signal — these patterns only improve guest-shell detection.
        name: /^(log in|sign in|登录|ログイン|로그인|se connecter|anmelden|iniciar sesión|entrar|accedi)$/i,
      }),
      this.page.getByRole("link", {
        name: /^(log in|sign in|登录|ログイン|로그인|se connecter|anmelden|iniciar sesión|entrar|accedi)$/i,
      }),
    ];
  }

  // Logged-out visitors are redirected to /auth/… — locale-independent.
  authUrlPattern() {
    return /^\/auth\//;
  }

  authTextPattern() {
    return /log in to get answers|log in or sign up|sign up for free|get responses tailored to you|登录或注册|登录以|免费注册/i;
  }

  assistantMessages() {
    // request-placeholder-* nodes are ChatGPT's in-flight/error stubs — the
    // "正在思考" thinking slot and client error cards ("错误 d: 60758"-style).
    // They carry the assistant role but are never real replies. Excluding them
    // keeps a failed request from being read as an envelope-less reply and
    // burned through the protocol-error retry loop; the turn instead sees "no
    // reply" and recovers with the continuation nudge.
    return this.page.locator(
      '[data-message-author-role="assistant"]:not([id^="request-placeholder-"])',
    );
  }

  userMessages() {
    return this.page.locator('[data-message-author-role="user"]');
  }

  conversationMessages() {
    return this.page.locator(
      '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    );
  }

  async messageIdentity(message) {
    const [id, turn] = await Promise.all([
      message.getAttribute("data-message-id").catch(() => null),
      this.#messageTurn(message),
    ]);
    return { id, turn };
  }

  async #messageTurn(message) {
    if (typeof message?.evaluate !== "function") {
      return null;
    }
    const testId = await message.evaluate((element) => (
      element.closest('[data-testid^="conversation-turn-"]')
        ?.getAttribute("data-testid") ?? null
    )).catch(() => null);
    return parseConversationTurn(testId);
  }

  // The redesigned UI still exposes the stop button ([data-testid="stop-button"],
  // aria-label 停止回答/Stop answering) — present while a generation is active
  // (it stays visible through multi-minute pauses) and gone once the reply is
  // finished. Verified live: every truncated-envelope acceptance happened with
  // the button absent, and messages that later "grew" were ChatGPT REGENERATING
  // the reply in place after the nudge, not paused generations resuming. So the
  // signal is reliable and the short truncated-envelope grace applies.
  hasReliableCompletionSignal() {
    return true;
  }

  // ChatGPT sometimes CONTINUES the previous message in place (same
  // data-message-id) instead of starting a new one — e.g. when answering a
  // format-retry nudge it appends the completion to the very message that was
  // truncated. The id baseline alone would make that continuation invisible
  // to the turn loop forever, so a baseline message whose text has GROWN
  // since the send-time snapshot also counts as the new reply.
  isNewAssistantIdentity({ id, turn, text }) {
    if (super.isNewAssistantIdentity({ id, turn })) {
      return true;
    }
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return previous !== "" && String(text ?? "") !== previous;
  }

  async assistantText(message) {
    // Read the whole assistant turn first. A long XML response can contain
    // Markdown fences inside CDATA; ChatGPT then splits the rendered response
    // into many <pre><code> nodes and the first node contains the opening tag
    // but not the closing tag. The parent innerText keeps the complete envelope
    // and avoids one CDP round trip per nested code block on every poll.
    const fullText = await message.innerText().catch(() => "");
    if (fullText.includes("<agent_response")) {
      return fullText;
    }

    // Rare fallback for alternate renderers where the parent text omits code
    // contents: prefer a complete code-block envelope, but retain a partial
    // one so streaming progress remains visible until its closing tag arrives.
    const codeBlocks = message.locator("pre code");
    const codeBlockCount = await codeBlocks.count();
    let partialEnvelope = "";
    for (let index = 0; index < codeBlockCount; index += 1) {
      const code = await codeBlocks.nth(index).innerText().catch(() => "");
      if (hasCompleteAgentEnvelope(code)) {
        return code;
      }
      if (!partialEnvelope && code.includes("<agent_response")) {
        partialEnvelope = code;
      }
    }
    if (partialEnvelope) {
      return partialEnvelope;
    }

    const markdown = message.locator(".markdown");
    if (await markdown.count()) {
      return await markdown.last().innerText().catch(() => "");
    }
    return fullText;
  }

  // A plan/usage limit renders as an error card: error-tinted token classes
  // (text-token-text-error / bg-token-surface-error) plus a regenerate button
  // (data-testid="regenerate-thread-error-button"). Protocol replies are plain
  // markdown and never contain those, so their presence confirms the matching
  // text is a real notice rather than a reply that mentions "limit" in its
  // content. Text stays the primary signal (a notice always says something
  // recognizable in the UI language); the DOM features guard against false
  // positives and future language additions.
  // ChatGPT renders server-side generation failures as an error card —
  // "Internal Server Error" / "Something went wrong" / 生成失败 — with a
  // retry/regenerate button. A text match plus the retry affordance confirms
  // it is a real failure card, never a deliberate answer.
  async findGenerationErrorMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!/internal server error|something went wrong|生成失败|出错了|生成时发生错误/i.test(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|重试|regenerate|重新生成|try again/i }),
      message.locator('button[data-testid="regenerate-thread-error-button"]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) {
      return null;
    }
    const control = await firstVisible([
      message.locator('button[data-testid="regenerate-thread-error-button"]'),
      message.locator('[class*="text-token-text-error"]'),
      message.locator('[class*="bg-token-surface-error"]'),
      message.getByRole("button", {
        name: /retry|重试|try again|upgrade|升级/i,
      }),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  // Attaches local files to the composer via the hidden `#upload-files` input.
  // Playwright's setInputFiles drives the <input type=file> directly, so no
  // native OS file dialog is involved. Best-effort: returns which files were
  // attached and any failures without throwing, so a broken selector or a
  // rejected upload never aborts the turn.
  async attachFiles(files) {
    this.requirePage();
    const paths = (files ?? [])
      .map((file) => (typeof file === "string" ? file : file?.path))
      .filter(Boolean);
    if (paths.length === 0) {
      return { attached: [], failed: [] };
    }

    const input = await firstVisible([
      this.page.locator("#upload-files"),
    ]) ?? this.page.locator('main input[type="file"]').first();

    try {
      await input.setInputFiles(paths, { timeout: 15_000 });
    } catch (error) {
      await this.writeDiagnostics("attach-files-failed");
      return {
        attached: [],
        failed: paths.map((filePath) => ({ path: filePath, message: error.message })),
      };
    }

    // Wait for the composer to register the upload(s) so we do not send before
    // ChatGPT has ingested them. Uploaded files render as previews/chips; poll
    // for any thumbnail/remove-file control, with a bounded timeout.
    await this.page.locator(
      '[data-testid$="-file-thumbnail"], [data-testid*="attachment"], '
      + 'button[aria-label*="Remove" i], button[aria-label*="删除"]',
    ).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => null);

    return { attached: [...paths], failed: [] };
  }

  async dismissTransientOverlays() {
    const beacon = this.page.locator("#modal-beacon");
    if (!await beacon.isVisible().catch(() => false)) {
      return;
    }

    await this.page.keyboard.press("Escape").catch(() => null);
    await this.page.waitForTimeout(250);
    if (!await beacon.isVisible().catch(() => false)) {
      return;
    }

    const dismiss = await firstVisible([
      beacon.getByRole("button", {
        name: /^(close|dismiss|not now|maybe later|skip|got it|done|关闭|取消|暂不|稍后|跳过|知道了|完成)$/i,
      }),
      beacon.locator(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], button[aria-label*="关闭"]',
      ),
    ]);
    if (dismiss) {
      await dismiss.click().catch(() => null);
      await this.page.waitForTimeout(250);
    }

    if (await beacon.isVisible().catch(() => false)) {
      await this.writeDiagnostics("blocking-modal");
      throw new BrowserAdapterError(
        "A ChatGPT modal is blocking the composer and could not be dismissed safely.",
        { code: "BLOCKING_MODAL" },
      );
    }
  }

  // ChatGPT's thread list is virtualized: only the visible window is mounted.
  // Scrolls the thread container to the bottom so the latest replies mount.
  // Best-effort — any failure is swallowed.
  async scrollConversationToBottom() {
    await this.page.evaluate?.(() => {
      const message = document.querySelector("[data-message-author-role]");
      if (!message) {
        return;
      }
      let element = message.parentElement;
      for (
        let depth = 0;
        element && depth < 12;
        depth += 1, element = element.parentElement
      ) {
        if (element.scrollHeight > element.clientHeight + 50) {
          element.scrollTop = element.scrollHeight;
          return;
        }
      }
    }).catch(() => null);
  }

}

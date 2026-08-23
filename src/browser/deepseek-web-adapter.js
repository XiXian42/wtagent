import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const DEEPSEEK_URL = "https://chat.deepseek.com/";

// DeepSeek (chat.deepseek.com) adapter.
//
// DeepSeek's DOM has no data-testid / data-message-id / role attributes and
// uses hashed, volatile class names. The stable anchors it DOES expose, all
// verified against the live app, are:
//   - a single composer: textarea[name="search"] (placeholder "给 DeepSeek 发送消息")
//   - design-system classes prefixed `ds-`: `.ds-message` wraps each turn, and
//     assistant turns additionally contain `.ds-assistant-message-main-content`
//   - a virtualized message list whose row wrappers carry a monotonic
//     `data-virtual-list-item-key` — used as the per-message turn ordinal
//   - a live conversation URL of the form /a/chat/s/<uuid>
// There is no labeled send button (an unlabeled icon control), so sending
// relies on the base adapter's Enter fallback; likewise there is no labeled
// stop button, so generation is not detected via a stop control (the base
// treats "no stop button" as simply not-generating, and the reply's stable
// window + turn boundary still complete the turn correctly).
export class DeepSeekWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? DEEPSEEK_URL,
      providerName: "DeepSeek",
    });
  }

  conversationUrlPattern() {
    return /^\/a\/chat\/s\//;
  }

  // DeepSeek has no ChatGPT-style model dropdown; instead a new conversation
  // exposes mode chips (快速/专家/识图) and toggles (深度思考/智能搜索). The
  // registry's defaultMode ("expert-thinking") asks for 专家模式 (Expert) +
  // 深度思考 (Deep Thinking) — WTAgent's preferred DeepSeek setup, applied
  // silently on every fresh conversation (no interactive picker). Any other
  // requested value keeps the site's current setting.
  //
  // Selection is LANGUAGE-INDEPENDENT and idempotent:
  //   - the chips are role="radio" in a fixed order (fast, expert, image), so
  //     the expert chip is the second radio; visible labels are only used to
  //     double-check the position when they match a locale we know
  //   - after expert is active DeepSeek shows exactly ONE .ds-toggle-button
  //     (deep thinking); fast mode shows two (deep thinking + web search), so
  //     the toggle count itself proves the chip switch landed. Clicking the
  //     single remaining toggle needs no label at all.
  // Selection is best-effort — a UI change never aborts the run; it reports
  // "unresolved" and keeps the current mode, like runModeSelection.
  async selectMode(mode) {
    this.requirePage();
    if (mode !== "expert-thinking") {
      return { status: "skipped", requested: mode, attempts: 0 };
    }

    const steps = [];
    const chip = await this.#findExpertChip();
    if (!chip) {
      steps.push({ ok: false, label: "expert-chip" });
    } else {
      steps.push(await this.#ensureChipChecked(chip, "expert-chip"));
      if (steps[0].ok) {
        steps.push(await this.#ensureSingleThinkingToggle());
      }
    }

    const failed = steps.filter((s) => !s.ok);
    if (failed.length > 0) {
      await this.writeDiagnostics("deepseek-mode-partial");
      return {
        status: "unresolved",
        requested: mode,
        selectedLabel: "expert + deep-thinking",
        attempts: 1,
        reason: `Could not confirm: ${failed.map((s) => s.label).join(", ")}.`,
      };
    }
    return {
      status: "select",
      requested: mode,
      selectedLabel: "expert + deep-thinking",
      attempts: 1,
      reason: "Selected expert mode with deep thinking.",
    };
  }

  // Locates the expert chip without relying on its locale: try known labels
  // first, then fall back to the fixed chip order (fast, expert, image).
  async #findExpertChip() {
    const radios = this.page.locator('[role="radio"]');
    const count = await radios.count().catch(() => 0);
    if (count === 0) {
      return null;
    }
    const labelPattern = /专家|expert/i;
    for (let index = 0; index < count; index += 1) {
      const text = (await radios.nth(index).innerText().catch(() => "")).trim();
      if (labelPattern.test(text)) {
        return radios.nth(index);
      }
    }
    // Positional fallback: 快速/专家/识图 — the expert chip is the 2nd radio.
    return count >= 2 ? radios.nth(1) : null;
  }

  // Clicks a chip unless it is already aria-checked. Returns { ok, label }.
  async #ensureChipChecked(chip, label) {
    if (await chip.getAttribute("aria-checked").catch(() => null) === "true") {
      return { ok: true, label };
    }
    await chip.click({ timeout: 5_000 }).catch(() => null);
    await this.page.waitForTimeout(400);
    const checked = await chip.getAttribute("aria-checked").catch(() => null);
    return { ok: checked === "true", label };
  }

  // In expert mode exactly ONE toggle (deep thinking) exists; in fast mode
  // there are two. Clicking the single remaining toggle therefore never needs
  // a label. The toggle count also verifies the chip switch actually landed.
  async #ensureSingleThinkingToggle() {
    const toggles = this.page.locator(".ds-toggle-button");
    const count = await toggles.count().catch(() => 0);
    if (count !== 1) {
      return { ok: false, label: "deep-thinking-toggle" };
    }
    const toggle = toggles.nth(0);
    const isSelected = async () => (
      (await toggle.getAttribute("class").catch(() => "") ?? "")
        .includes("ds-toggle-button--selected")
    );
    if (await isSelected()) {
      return { ok: true, label: "deep-thinking-toggle" };
    }
    await toggle.click({ timeout: 5_000 }).catch(() => null);
    await this.page.waitForTimeout(400);
    return { ok: await isSelected(), label: "deep-thinking-toggle" };
  }

  composerLocators() {
    return [
      this.page.locator('textarea[name="search"]'),
      this.page.locator('textarea[placeholder*="发送消息"]'),
      this.page.locator('textarea[placeholder*="Message" i]'),
      this.page.locator('main textarea'),
    ];
  }

  // DeepSeek's send control is an unlabeled icon button, so the base adapter's
  // Enter fallback does the sending. Still offer best-effort locators so a
  // future labeled control is used if present.
  sendButtonLocators() {
    return [
      this.page.getByRole("button", { name: /send|发送/i }),
    ];
  }

  // No labeled stop-generating control is exposed, and the composer's send
  // button looks identical when idle-empty and when generating, so there is no
  // reliable DOM liveness signal. Returning nothing means the base loop never
  // sees a "generating" stop signal; the turn still completes on the
  // stable-window + new-turn boundary. Kept overridable for the day DeepSeek
  // ships a labeled control.
  stopButtonLocators() {
    return [
      this.page.getByRole("button", { name: /stop|停止/i }),
    ];
  }

  // DeepSeek defaults to 深度思考 (Deep Thinking), which can reason for minutes
  // before rendering the first assistant token — and it exposes no stop button
  // to prove it is alive during that phase. Without a wider grace window the
  // base dead-request detector would misread that silent thinking as a dead
  // request and fire a spurious "continue" nudge. 5 × the 60s base grace gives
  // a ~5 min pre-token window (and ~15 min after any signal), matching how long
  // Deep Thinking can legitimately stay quiet.
  deadRequestGraceMultiplier() {
    return 5;
  }

  newConversationControls() {
    return [
      this.page.getByRole("button", { name: /新对话|开启新对话|new chat/i }),
      this.page.getByRole("link", { name: /新对话|开启新对话|new chat/i }),
      this.page.locator('[data-testid="new-chat"]'),
    ];
  }

  loginControlLocators() {
    return [
      this.page.getByRole("button", { name: /^(登录|log in|sign in)$/i }),
      this.page.getByRole("button", { name: /密码登录|验证码登录|password|verification code/i }),
    ];
  }

  // Logged-out visitors are redirected to /sign_in — locale-independent.
  authUrlPattern() {
    return /^\/sign_in/;
  }

  authTextPattern() {
    return /发送验证码|密码登录|微信扫码登录|使用 Apple 账号登录|未注册的手机号|log in|sign in|send code|password login|sign in with apple/i;
  }

  // The message rows are the virtual-list wrappers that carry the stable
  // per-message key. Filtering by presence of the assistant content node
  // separates assistant turns from user turns without any role attribute.
  assistantMessages() {
    // Deep Thinking first mounts a think-only row
    // (`.ds-think-content`) with no answer node. Count that as an assistant
    // turn or the 5-minute dead-request window fires mid-thought.
    return this.page.locator(
      '[data-virtual-list-item-key]:has(.ds-assistant-message-main-content), '
      + '[data-virtual-list-item-key]:has(.ds-think-content)',
    );
  }

  userMessages() {
    return this.page.locator(
      '[data-virtual-list-item-key]:not(:has(.ds-assistant-message-main-content))'
      + ':not(:has(.ds-think-content))',
    );
  }

  conversationMessages() {
    return this.page.locator("[data-virtual-list-item-key]");
  }

  // DeepSeek's `data-virtual-list-item-key` is a virtual-list rendering index,
  // not a stable per-message id: during optimistic send/scroll it briefly takes
  // transient (even negative) values before settling. So it cannot be used as
  // the turn ordinal the base identity ladder expects. Instead DeepSeek uses a
  // COUNT baseline (see isNewAssistantIdentity): identity carries a count-based
  // ordinal, and a reply is "new" once the assistant-row count grows beyond the
  // baseline captured at send time.
  //
  // messageIdentity is called for both assistant rows (turn-completion loop) and
  // user rows (#waitForSentUserMessage). It returns a role-scoped ordinal: the
  // number of rows of the SAME role at or before this one. For the loop's
  // `.last()` assistant row that is the total assistant count; for a freshly
  // appended user row it exceeds the user baseline, so the send is detected.
  async messageIdentity(message) {
    const isAssistant = await message
      .locator(".ds-assistant-message-main-content, .ds-think-content")
      .count()
      .catch(() => 0) > 0;
    const scope = isAssistant ? this.assistantMessages() : this.userMessages();
    const turn = await scope.count().catch(() => 0);
    return { id: null, turn };
  }

  // A reply is genuinely new once the assistant-row count exceeds what existed
  // at send time. This is the count-based strategy the base explicitly allows
  // for providers whose DOM lacks a stable per-message id or turn ordinal, and
  // it is immune to the volatile virtual-list key. It never accepts a
  // pre-existing reply (guarding against stale answers) because the count only
  // rises when DeepSeek appends a new assistant turn.
  isNewAssistantIdentity({ turn, text }) {
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    // DeepSeek's virtual list often keeps the same row count and reuses the
    // last assistant slot. A changed answer (or a new protocol envelope) is
    // still a new turn even when the count does not grow.
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    const current = String(text ?? "");
    if (!previous || !current.trim() || current === previous) {
      return false;
    }
    return /<agent_response|<tool_call|<tool_calls|<invoke[\s>]/i.test(current);
  }

  async assistantText(message) {
    // Prefer the answer node; fall back to the think block so a still-thinking
    // turn is visible to the completion loop instead of looking empty.
    const content = message.locator(".ds-assistant-message-main-content");
    if (await content.count().catch(() => 0)) {
      const text = await content.last().innerText().catch(() => "");
      if (text.includes("<agent_response") || text.includes("<tool_call") || text.trim()) {
        return text;
      }
    }
    const think = message.locator(".ds-think-content");
    if (await think.count().catch(() => 0)) {
      const text = await think.last().innerText().catch(() => "");
      if (text.includes("<agent_response") || text.includes("<tool_call") || text.trim()) {
        return text;
      }
    }
    return await message.innerText().catch(() => "");
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating(message) {
    // Structural completion signal (same idea as Kimi's action bar, fully
    // locale-independent): DeepSeek renders the reply action bar — a row of
    // copy / regenerate / thumbs / share icon buttons carrying the stable
    // ds-button--iconLabelTertiary class — under an assistant message only
    // after it has FULLY finished streaming. While generating, including the
    // think-only (.ds-think-content) phase, no such buttons exist.
    const buttons = message.locator(
      '[role="button"].ds-button--iconLabelTertiary',
    );
    return await buttons.count().catch(() => 0) === 0;
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) {
      return null;
    }
    // Confirm with a retry/limit affordance so an ordinary reply that merely
    // mentions a limit is not misread as a notice.
    const control = await firstVisible([
      message.getByRole("button", { name: /重试|重新生成|retry|try again/i }),
      message.locator('[class*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  // DeepSeek's thread is virtualized; scroll the list container so the latest
  // reply mounts when resuming an existing conversation.
  async scrollConversationToBottom() {
    await this.page.evaluate?.(() => {
      const list = document.querySelector(".ds-virtual-list");
      if (list) {
        list.scrollTop = list.scrollHeight;
      }
    }).catch(() => null);
  }
}

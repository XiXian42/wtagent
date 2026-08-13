import fs from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { launchAndConnectCdpChrome } from "./cdp-browser.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import { ensureDirectory } from "../platform/paths.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";
import {
  chooseModeOption,
  labelMatchesToken,
  runModeSelection,
  slugMatchesToken,
  normalizeToken,
} from "./mode-selection.js";

const CHATGPT_URL = "https://chatgpt.com/";

// Playwright error messages for a dead transport. The Chrome process itself is
// usually still alive (e.g. the connection died while the Mac slept); these
// errors mean "reconnect", not "the browser is gone".
const CONNECTION_LOST_PATTERNS = [
  "target page, context or browser has been closed",
  "browser has been closed",
  "page has been closed",
  "connection closed",
  "connection is closed",
];

export function isConnectionLostError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return CONNECTION_LOST_PATTERNS.some((pattern) => message.includes(pattern));
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) {
        return item;
      }
    }
  }
  return null;
}

function deltaFrom(previous, current) {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  return "";
}

function hasCompleteAgentEnvelope(text) {
  const trimmed = String(text ?? "").trim();
  const start = trimmed.indexOf("<agent_response");
  const endTag = "</agent_response>";
  const end = trimmed.lastIndexOf(endTag);
  // The envelope is "complete" as soon as both the opening and closing tags
  // are present. ChatGPT may append trailing text or render rich cards after
  // the XML, so we do not require the closing tag to be the last content.
  return start >= 0 && end >= start;
}

function sameConversationUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin
      && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function parseConversationTurn(value) {
  const match = String(value ?? "").match(/^conversation-turn-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export class ChatGPTWebAdapter {
  constructor({
    profileDir,
    chromePath,
    baseUrl = CHATGPT_URL,
    debug = false,
    minimized = false,
    stdinStream = process.stdin,
    cancelOnEsc = false,
  }) {
    this.profileDir = path.resolve(profileDir);
    this.chromePath = chromePath;
    this.baseUrl = baseUrl;
    this.debug = debug;
    this.minimized = minimized;
    this.stdinStream = stdinStream;
    this.cancelOnEsc = cancelOnEsc;
    this.escCancelRequested = false;
    this.context = null;
    this.cdpChrome = null;
    this.page = null;
    this.assistantIdsBeforeSend = new Set();
    this.assistantMaxTurnBeforeSend = null;
    this.sentUserTurn = null;
    this.lastAssistantMessageId = null;
    this.lastModeSelection = null;
  }

  // `preferredUrl` lets a reused Chrome pick an existing tab that already
  // shows the conversation (instead of opening a new tab per run).
  async launch(preferredUrl = null) {
    if (this.context) {
      return;
    }
    await ensureDirectory(this.profileDir);
    const executablePath = discoverChromeExecutable(this.chromePath);

    this.cdpChrome = await launchAndConnectCdpChrome({
      executablePath,
      profileDir: this.profileDir,
      minimized: this.minimized,
      preferredUrl,
    });
    this.context = this.cdpChrome.context;
    this.page = this.cdpChrome.page;
    this.page.setDefaultTimeout(15_000);
    this.page.setDefaultNavigationTimeout(60_000);
    await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
  }

  async close() {
    await this.cdpChrome?.close();
    this.cdpChrome = null;
    this.context = null;
    this.page = null;
  }

  // Re-establishes the CDP connection to a still-alive Chrome after the
  // Playwright transport died mid-run (e.g. the Mac slept). launch() reuses
  // the saved CDP state, so Chrome is neither relaunched nor killed; an
  // existing tab on the preferred conversation is reused when available.
  async reconnect(preferredUrl = null) {
    await this.cdpChrome?.disconnect?.().catch(() => null);
    this.cdpChrome = null;
    this.context = null;
    this.page = null;
    await this.launch(preferredUrl);
  }

  // Bring the window forward (used before asking the user to log in or solve a
  // challenge). No-op when the window was never minimized.
  async restoreWindow() {
    if (this.minimized) {
      await this.cdpChrome?.restore?.();
    }
  }

  // Send the window back to minimized after the user is done. Only re-minimizes
  // when this run launched minimized in the first place.
  async minimizeWindow() {
    if (this.minimized) {
      await this.cdpChrome?.minimize?.();
    }
  }

  async getAuthState() {
    this.#requirePage();
    if (await this.#findLoginControl()) {
      return "unauthenticated";
    }

    const body = await this.page.locator("body").innerText().catch(() => "");
    if (
      /log in to get answers|log in or sign up|sign up for free|get responses tailored to you|登录或注册|登录以|免费注册/i
        .test(body)
    ) {
      return "unauthenticated";
    }

    return await this.#findComposer() ? "authenticated" : "unknown";
  }

  async waitForManualLogin({ timeoutMs }) {
    this.#requirePage();
    const deadline = Date.now() + timeoutMs;
    let consecutiveAuthenticatedChecks = 0;

    while (Date.now() < deadline) {
      if (await this.getAuthState() === "authenticated") {
        consecutiveAuthenticatedChecks += 1;
        if (consecutiveAuthenticatedChecks >= 5) {
          return;
        }
      } else {
        consecutiveAuthenticatedChecks = 0;
      }
      await this.page.waitForTimeout(1_000);
    }

    throw new BrowserAdapterError(
      `Login was not detected within ${Math.round(timeoutMs / 60_000)} minutes.`,
      { code: "LOGIN_TIMEOUT" },
    );
  }

  async startConversation(
    conversationUrl = null,
    { expectedAssistantMessageId = null } = {},
  ) {
    this.#requirePage();
    let target = this.baseUrl;
    if (conversationUrl) {
      const parsed = new URL(conversationUrl);
      const base = new URL(this.baseUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== base.hostname) {
        throw new BrowserAdapterError(
          `Refusing to open a conversation outside ${base.hostname}.`,
          { code: "INVALID_CONVERSATION_URL" },
        );
      }
      target = parsed.href;
    }

    const reuseCurrent = Boolean(
      conversationUrl
      && sameConversationUrl(this.page.url(), target),
    );
    if (!reuseCurrent) {
      await this.page.goto(target, { waitUntil: "domcontentloaded" });
    }
    const composer = await this.#waitForComposer(30_000);
    if (!composer) {
      throw new BrowserAdapterError(
        "ChatGPT composer was not found after opening a new conversation.",
        { code: "COMPOSER_NOT_FOUND" },
      );
    }

    if (conversationUrl) {
      await this.#waitForConversationHistory({
        expectedAssistantMessageId,
        expectedUrl: target,
      });
      return;
    }

    if (!conversationUrl && !await this.#isFreshConversation()) {
      await this.#openNewConversation();
      const freshComposer = await this.#waitForComposer(30_000);
      if (!freshComposer || !await this.#isFreshConversation()) {
        await this.#writeDiagnostics("conversation-not-fresh");
        throw new BrowserAdapterError(
          "ChatGPT did not open a verified empty conversation. "
            + "Refusing to send a new session prompt into an existing chat.",
          { code: "CONVERSATION_NOT_FRESH" },
        );
      }
    }
  }

  async selectMode(mode) {
    this.#requirePage();
    if (!mode) {
      return { status: "skipped", requested: mode, attempts: 0 };
    }

    const port = this.#modeSelectionPort();
    const result = await runModeSelection(port, mode);
    this.lastModeSelection = result;
    return result;
  }

  // DOM port for mode-selection.js. Stable attribute slugs are preferred;
  // exact visible labels are a fallback for current menus that omit those
  // attributes. Disabled state is still read from DOM state, never from text.
  #modeSelectionPort() {
    const page = this.page;
    return {
      alreadyOnMode: async (requested) => {
        const token = normalizeToken(requested);
        const switcher = await this.#findModelSwitcher();
        const switcherLabel = switcher
          ? await switcher.innerText().catch(() => "")
          : "";
        if (labelMatchesToken(switcherLabel, token)) {
          return true;
        }

        const messages = this.#assistantMessages();
        if (await messages.count() === 0) {
          return false;
        }
        const slug = await messages.last()
          .getAttribute("data-message-model-slug")
          .catch(() => null);
        return Boolean(slug) && slugMatchesToken(slug, token);
      },
      hasSwitcher: async () => Boolean(await this.#findModelSwitcher()),
      openMenu: async (requested) => {
        const switcher = await this.#findModelSwitcher();
        if (switcher) {
          const opened = await switcher.click({ timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          if (!opened) {
            await switcher.click({ force: true, timeout: 5_000 })
              .catch(() => null);
          }
          // Wait for the Radix menu portal to attach before reading options.
          await page.locator('[role="menu"]:visible [role="menuitem"]:visible, [role="menu"]:visible [role="menuitemradio"]:visible')
            .first().waitFor({ state: "visible", timeout: 5_000 })
            .catch(() => null);
          await this.#revealNestedModeOption(requested);
        }
      },
      readOptions: async () => this.#readModeOptions(),
      clickOption: async (index) => {
        const option = this.#modeOptionLocators().nth(index);
        try {
          await option.click({ timeout: 5_000 });
          return true;
        } catch {
          return false;
        }
      },
      waitClosed: async () => {
        const ok = await page.locator('[role="menu"]').first()
          .waitFor({ state: "hidden", timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        return ok;
      },
      waitSelected: async (requested) => {
        const token = normalizeToken(requested);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const switcher = await this.#findModelSwitcher(500);
          const label = switcher
            ? await switcher.innerText().catch(() => "")
            : "";
          if (labelMatchesToken(label, token)) {
            return true;
          }

          const selectedOption = (await this.#readModeOptions()).find(
            (option) => option.selected
              && (
                slugMatchesToken(option.slug, token)
                || labelMatchesToken(option.label, token)
              ),
          );
          if (selectedOption) {
            return true;
          }
          await page.waitForTimeout(100);
        }
        return false;
      },
      closeMenu: async () => {
        await page.keyboard.press("Escape").catch(() => null);
        await page.waitForTimeout(150);
      },
      writeDiagnostics: async (label) => this.#writeDiagnostics(label),
    };
  }

  #modeOptionLocators() {
    return this.page.locator(
      '[role="menu"]:visible [role="menuitemradio"]:visible, '
        + '[role="menu"]:visible [role="menuitem"]:visible',
    );
  }

  async #revealNestedModeOption(requested) {
    const present = (options) => {
      const choice = chooseModeOption(options, requested);
      return choice.status !== "unavailable";
    };

    let options = await this.#readModeOptions();
    if (present(options)) {
      return;
    }

    const submenuTriggers = this.page.locator(
      '[role="menu"]:visible [role="menuitem"][aria-haspopup="menu"]:visible',
    );
    const count = await submenuTriggers.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const trigger = submenuTriggers.nth(index);
      await trigger.dispatchEvent("pointermove", { pointerType: "mouse" })
        .catch(() => null);
      await this.page.waitForTimeout(250);
      options = await this.#readModeOptions();
      if (present(options)) {
        return;
      }
    }
  }

  // Enumerates the open menu's options into { index, slug, label, disabled }.
  // `slug` is the first stable attribute found and may be empty in current
  // ChatGPT menus; `disabled` is read from ARIA / data-state, never from text.
  async #readModeOptions() {
    const locator = this.#modeOptionLocators();
    const count = await locator.count().catch(() => 0);
    const options = [];
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const [testId, dataValue, dataTestValue, id, ariaDisabled, ariaChecked, dataDisabled, dataState, label] =
        await Promise.all([
          item.getAttribute("data-testid").catch(() => null),
          item.getAttribute("data-value").catch(() => null),
          item.getAttribute("data-test-value").catch(() => null),
          item.getAttribute("id").catch(() => null),
          item.getAttribute("aria-disabled").catch(() => null),
          item.getAttribute("aria-checked").catch(() => null),
          item.getAttribute("data-disabled").catch(() => null),
          item.getAttribute("data-state").catch(() => null),
          item.innerText().catch(() => ""),
        ]);
      const slug = [testId, dataValue, dataTestValue, id].find(Boolean) ?? "";
      const disabled = ariaDisabled === "true"
        || dataDisabled === "true"
        || dataDisabled === ""
        || dataState === "disabled"
        || !await item.isEnabled().catch(() => true);
      const selected = ariaChecked === "true" || dataState === "checked";
      options.push({
        index,
        slug,
        label: (label ?? "").trim(),
        disabled,
        selected,
      });
    }
    return options;
  }

  async getConversationUrl() {
    this.#requirePage();
    return this.page.url();
  }

  async getLastAssistantMessageId() {
    return this.lastAssistantMessageId;
  }

  async sendMessage(text, { files = [], maxBytes = null } = {}) {
    this.#requirePage();
    const messageBytes = Buffer.byteLength(String(text ?? ""), "utf8");
    if (maxBytes != null && messageBytes > maxBytes) {
      throw new BrowserAdapterError(
        `Outbound message is ${messageBytes} bytes; the limit is ${maxBytes} bytes.`,
        {
          code: "OUTBOUND_MESSAGE_TOO_LARGE",
          details: { messageBytes, maxBytes },
        },
      );
    }
    const urlBeforeSend = this.page.url();
    const composer = await this.#waitForComposer(30_000);
    if (!composer) {
      throw new BrowserAdapterError(
        "ChatGPT composer is unavailable.",
        { code: "COMPOSER_NOT_FOUND" },
      );
    }

    await this.#dismissTransientOverlays();

    // Attach any @file uploads before typing/sending. Upload is best-effort: a
    // failure is reported to the caller but does not block sending the text.
    let attachment = null;
    if (files.length > 0) {
      attachment = await this.attachFiles(files);
    }

    const assistantMessages = this.#assistantMessages();
    const assistantBaseline = await this.#captureMessageIdentities(
      assistantMessages,
    );
    const userBaseline = await this.#captureMessageIdentities(
      this.#userMessages(),
    );
    this.assistantIdsBeforeSend = assistantBaseline.ids;
    this.assistantMaxTurnBeforeSend = assistantBaseline.maxTurn;
    this.sentUserTurn = null;

    try {
      await composer.fill(text);
    } catch {
      await this.#dismissTransientOverlays();
      await composer.focus();
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+A" : "Control+A",
      );
      await this.page.keyboard.insertText(text);
    }

    const sendButton = await firstVisible([
      this.page.locator('[data-testid="send-button"]'),
      this.page.getByRole("button", { name: /send|发送/i }),
    ]);

    if (sendButton && await sendButton.isEnabled().catch(() => false)) {
      try {
        await sendButton.click();
      } catch {
        await this.#dismissTransientOverlays();
        await composer.press("Enter");
      }
    } else {
      await composer.press("Enter");
    }

    if (!/^\/c\//.test(new URL(urlBeforeSend).pathname)) {
      await this.page.waitForURL(
        (url) => /^\/c\//.test(url.pathname),
        { timeout: 5_000 },
      ).catch(() => null);
    }

    const sentMessage = await this.#waitForSentUserMessage(userBaseline);
    if (!sentMessage) {
      // ChatGPT never rendered the message: the send did not register (a
      // disabled send button, a missed Enter, or a transient UI state). Fail
      // loudly instead of pretending the message went out — otherwise the
      // runtime waits for a reply that ChatGPT never received.
      await this.#writeDiagnostics("send-not-detected");
      throw new BrowserAdapterError(
        "ChatGPT did not render the sent message; the send may have failed.",
        { code: "SEND_NOT_DETECTED" },
      );
    }
    return { attachment };
  }

  // Attaches local files to the composer via the hidden `#upload-files` input.
  // Playwright's setInputFiles drives the <input type=file> directly, so no
  // native OS file dialog is involved. Best-effort: returns which files were
  // attached and any failures without throwing, so a broken selector or a
  // rejected upload never aborts the turn.
  async attachFiles(files) {
    this.#requirePage();
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
      await this.#writeDiagnostics("attach-files-failed");
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

  async waitForTurnComplete({
    timeoutMs,
    stableWindowMs,
    staleStopWindowMs = 15_000,
    emptyResponseWindowMs = 10_000,
    deadRequestGraceMs = 60_000,
    onDelta,
  }) {
    this.#requirePage();
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let lastText = "";
    let stableSince = 0;
    let sawAssistant = false;
    let emptySince = 0;
    let emptyCandidate = null;
    let sawGenerationSignal = false;
    let lastGenerationSignalAt = 0;
    const detachEscCancel = this.#attachEscCancel();
    try {
      while (Date.now() < deadline) {
        await this.#throwIfBlockedPage();

        if (this.escCancelRequested) {
          // ESC = stop generating and hand control back to the user. Clicking
          // ChatGPT's stop button halts the in-flight reply; any partial text
          // stays in the conversation and counts as pre-existing for the next
          // send.
          await this.#clickStopButton();
          throw new BrowserAdapterError(
            "Turn cancelled by user.",
            { code: "TURN_CANCELLED" },
          );
        }

        const messages = this.#assistantMessages();
        const count = await messages.count();
        const lastMessage = count > 0 ? messages.last() : null;
        const candidateText = lastMessage
          ? await this.#assistantText(lastMessage)
          : "";
        const candidateId = lastMessage
          ? await lastMessage.getAttribute("data-message-id").catch(() => null)
          : null;
        const candidateTurn = lastMessage
          ? await this.#messageTurn(lastMessage)
          : null;
        let hasNewAssistant;
        if (this.sentUserTurn != null && candidateTurn != null) {
          // Strongest boundary: the answer must be a conversation turn after
          // the exact user message that sendMessage() observed in the DOM.
          hasNewAssistant = candidateTurn > this.sentUserTurn;
        } else if (candidateId) {
          // Stable ChatGPT message IDs are the next-best boundary. Never accept
          // an ID that existed before this send, even if its text or DOM position
          // changed during hydration.
          hasNewAssistant = !this.assistantIdsBeforeSend.has(candidateId);
        } else if (
          candidateTurn != null
          && this.assistantMaxTurnBeforeSend != null
        ) {
          hasNewAssistant = candidateTurn > this.assistantMaxTurnBeforeSend;
        } else {
          // Without a stable message ID or turn boundary we cannot prove this
          // reply belongs to the current send. Timing/count heuristics caused the
          // stale-answer bug, so fail closed and let the bounded wait time out.
          hasNewAssistant = false;
        }

        const stopVisible = await this.#isStopButtonVisible();
        if (hasNewAssistant || stopVisible) {
          // A reply node or a visible stop button proves ChatGPT started
          // generating; only a request with neither signal can be dead.
          sawGenerationSignal = true;
          lastGenerationSignalAt = Date.now();
        }

        if (hasNewAssistant) {
          sawAssistant = true;
          const text = candidateText;
          if (text !== lastText) {
            const delta = deltaFrom(lastText, text);
            lastText = text;
            stableSince = Date.now();
            if (delta) {
              await onDelta?.(delta);
            }
          }

          if (!text.trim() && !stopVisible) {
            // ChatGPT can create a real assistant turn and finish it without
            // rendering any content. Once that exact empty node remains stopped
            // for a short grace period, fail early instead of waiting for the
            // full model timeout. A different node restarts the grace period.
            const candidateIdentity = candidateId
              ?? (candidateTurn == null ? null : `turn:${candidateTurn}`);
            if (candidateIdentity !== emptyCandidate) {
              emptyCandidate = candidateIdentity;
              emptySince = Date.now();
            }
            if (
              emptySince > 0
              && Date.now() - emptySince >= emptyResponseWindowMs
            ) {
              this.lastAssistantMessageId = candidateId;
              throw new BrowserAdapterError(
                "ChatGPT completed an assistant turn without any content.",
                {
                  code: "EMPTY_ASSISTANT_RESPONSE",
                  details: {
                    assistantMessageId: candidateId,
                    assistantTurn: candidateTurn,
                  },
                },
              );
            }
          } else {
            // Generation is still active, or text has begun rendering. Only an
            // empty and stopped reply should consume the empty-response window.
            emptyCandidate = null;
            emptySince = 0;
          }
          // If the reply looks like protocol XML, never accept it until BOTH the
          // opening and closing tags are present. During streaming the text can
          // briefly go quiet (or the stop button flip off) after "<agent_response"
          // is painted but before "</agent_response>" arrives; accepting there
          // hands the parser a truncated envelope. Non-protocol chatter (no
          // "<agent_response") is unaffected and still completes on the stable
          // window below.
          const looksLikeProtocol = lastText.includes("<agent_response");
          const envelopeReady = !looksLikeProtocol
            || hasCompleteAgentEnvelope(lastText);
          if (
            lastText.trim()
            && stableSince > 0
            && envelopeReady
            && (
              (
                !stopVisible
                && Date.now() - stableSince >= stableWindowMs
              )
              || (
                stopVisible
                && hasCompleteAgentEnvelope(lastText)
                && Date.now() - stableSince >= staleStopWindowMs
              )
            )
          ) {
            this.lastAssistantMessageId = candidateId;
            const limitMarker = await this.#findUsageLimitMarker(lastMessage);
            if (limitMarker) {
              throw new BrowserAdapterError(
                `ChatGPT reported a usage limit (${limitMarker}).`,
                { code: "USAGE_LIMIT_REACHED" },
              );
            }
            return lastText.trim();
          }
        }

        // Dead-request detection: the user message was sent but ChatGPT stopped
        // producing signals — either it never started (no node, no stop button)
        // or a started generation went quiet for several grace periods (stream
        // dropped, server-side abort, usage limit). A node or visible stop
        // button means generation is alive and resets the clock. Recover with a
        // continuation nudge instead of waiting out the full model timeout.
        const generationActive = hasNewAssistant || stopVisible;
        const quietSince = sawGenerationSignal
          ? lastGenerationSignalAt
          : startedAt;
        const quietGraceMs = sawGenerationSignal
          ? deadRequestGraceMs * 3
          : deadRequestGraceMs;
        if (
          !generationActive
          && this.sentUserTurn != null
          && Date.now() - quietSince >= quietGraceMs
        ) {
          await this.#writeDiagnostics("dead-request");
          throw new BrowserAdapterError(
            "ChatGPT stopped responding without completing a reply.",
            {
              code: "DEAD_ASSISTANT_REQUEST",
              details: { sentUserTurn: this.sentUserTurn },
            },
          );
        }

        await this.page.waitForTimeout(sawAssistant ? 250 : 500);
      }

      await this.#writeDiagnostics("turn-timeout");
      throw new BrowserAdapterError(
        `ChatGPT turn did not complete within ${Math.round(timeoutMs / 1000)} seconds.`,
        { code: "TURN_TIMEOUT" },
      );
    } finally {
      detachEscCancel?.();
    }
  }

  async #findComposer() {
    return await firstVisible([
      this.page.locator("#prompt-textarea"),
      this.page.locator('textarea[placeholder*="Message" i]'),
      this.page.locator('textarea[placeholder*="消息"]'),
      this.page.locator('div[contenteditable="true"][data-lexical-editor="true"]'),
      this.page.locator('main div[contenteditable="true"]'),
    ]);
  }

  async #isFreshConversation() {
    const current = new URL(this.page.url());
    const base = new URL(this.baseUrl);
    if (current.hostname !== base.hostname || /^\/c\//.test(current.pathname)) {
      return false;
    }
    return await this.#conversationMessages().count() === 0;
  }

  async #openNewConversation() {
    const control = await firstVisible([
      this.page.locator('[data-testid="create-new-chat-button"]'),
      this.page.getByRole("button", { name: /^(new chat|新聊天|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新聊天|新对话)$/i }),
      this.page.locator('a[href="/"]'),
    ]);
    if (control) {
      await control.click().catch(() => null);
      await this.page.waitForTimeout(500);
    }
    if (!await this.#isFreshConversation()) {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  #conversationMessages() {
    return this.page.locator(
      '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    );
  }

  async #findLoginControl() {
    return await firstVisible([
      this.page.getByRole("button", {
        name: /^(log in|sign in|登录)$/i,
      }),
      this.page.getByRole("link", {
        name: /^(log in|sign in|登录)$/i,
      }),
    ]);
  }

  async #waitForComposer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const composer = await this.#findComposer();
      if (composer) return composer;
      await this.page.waitForTimeout(500);
    }
    return null;
  }

  #assistantMessages() {
    return this.page.locator('[data-message-author-role="assistant"]');
  }

  #userMessages() {
    return this.page.locator('[data-message-author-role="user"]');
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

  async #messageIdentity(message) {
    const [id, turn] = await Promise.all([
      message.getAttribute("data-message-id").catch(() => null),
      this.#messageTurn(message),
    ]);
    return { id, turn };
  }

  async #captureMessageIdentities(messages) {
    const count = await messages.count().catch(() => 0);
    const ids = new Set();
    let maxTurn = null;
    for (let index = 0; index < count; index += 1) {
      const identity = await this.#messageIdentity(messages.nth(index));
      if (identity.id) {
        ids.add(identity.id);
      }
      if (identity.turn != null) {
        maxTurn = maxTurn == null
          ? identity.turn
          : Math.max(maxTurn, identity.turn);
      }
    }
    return { count, ids, maxTurn };
  }

  // ChatGPT's thread list is virtualized: only the visible window is mounted.
  // Scrolls the thread container to the bottom so the latest replies mount.
  // Best-effort — any failure is swallowed.
  async #scrollConversationToBottom() {
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

  async #waitForSentUserMessage(baseline, attempts = 50) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const messages = this.#userMessages();
      const count = await messages.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const identity = await this.#messageIdentity(messages.nth(index));
        const newByTurn = identity.turn != null
          && (
            baseline.maxTurn == null
            || identity.turn > baseline.maxTurn
          );
        const newById = Boolean(
          identity.id
          && !baseline.ids.has(identity.id),
        );
        if (newByTurn || newById) {
          this.sentUserTurn = identity.turn;
          return identity;
        }
      }
      await this.page.waitForTimeout(100);
    }
    return null;
  }

  async #waitForConversationHistory({
    expectedAssistantMessageId = null,
    expectedUrl = null,
    attempts = 60,
  } = {}) {
    let previousSignature = null;
    let stableChecks = 0;
    let scrolledToBottom = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const assistant = await this.#captureMessageIdentities(
        this.#assistantMessages(),
      );
      if (
        expectedAssistantMessageId
        && assistant.ids.has(expectedAssistantMessageId)
      ) {
        return;
      }

      // The expected resume marker is the latest reply, near the bottom of a
      // virtualized thread: scroll down a few times to force the tail to mount.
      if (expectedAssistantMessageId && scrolledToBottom < 3) {
        await this.#scrollConversationToBottom();
        scrolledToBottom += 1;
      }

      const totalMessages = await this.#conversationMessages()
        .count()
        .catch(() => 0);
      const signature = [
        totalMessages,
        assistant.count,
        assistant.maxTurn ?? "",
        [...assistant.ids].join(","),
      ].join(":");
      if (totalMessages > 0 && signature === previousSignature) {
        stableChecks += 1;
        if (stableChecks >= 3) {
          // With an expected id we normally return as soon as it appears;
          // reaching stability instead means the id is not mounted or has been
          // deleted (ChatGPT removes transient error/limit cards, and the last
          // recorded reply can be one). Accept when the URL still proves this
          // is the expected conversation.
          if (
            !expectedAssistantMessageId
            || !expectedUrl
            || sameConversationUrl(this.page.url(), expectedUrl)
          ) {
            return;
          }
        }
      } else {
        stableChecks = 0;
        previousSignature = signature;
      }

      await this.page.waitForTimeout(250);
    }

    await this.#writeDiagnostics("conversation-history-mismatch");
    const detail = expectedAssistantMessageId
      ? ` Expected assistant message ${expectedAssistantMessageId} was not found.`
      : " Existing conversation history did not become stable.";
    throw new BrowserAdapterError(
      `ChatGPT conversation history could not be verified.${detail}`,
      { code: "CONVERSATION_HISTORY_MISMATCH" },
    );
  }

  async #assistantText(message) {
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

  async #findModelSwitcher(timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const direct = await firstVisible([
        this.page.locator('[data-testid="model-switcher-dropdown-button"]'),
        this.page.locator(
          'main button.__composer-pill[aria-haspopup="menu"]',
        ),
        this.page.locator('button[aria-label*="model" i]'),
        this.page.locator('button[aria-label*="模式"]'),
      ]);
      if (direct) {
        return direct;
      }

      const menuButtons = this.page.locator(
        'main button[aria-haspopup="menu"]:not([data-testid^="history-item-"])',
      );
      const count = await menuButtons.count();
      for (let index = 0; index < count; index += 1) {
        const button = menuButtons.nth(index);
        if (!await button.isVisible().catch(() => false)) continue;
        const text = (await button.innerText().catch(() => "")).trim();
        const label = await button.getAttribute("aria-label").catch(() => "");
        if (
          /^(chatgpt|gpt(?:-[\w.]+)?|auto|instant|thinking|pro)$/i.test(text)
          || /model|模型|模式/i.test(label ?? "")
        ) {
          return button;
        }
      }

      await this.page.waitForTimeout(250);
    }

    return null;
  }

  #stopButtonLocators() {
    return [
      this.page.locator('[data-testid="stop-button"]'),
      this.page.getByRole("button", {
        name: /stop generating|stop|停止生成|停止/i,
      }),
    ];
  }

  async #isStopButtonVisible() {
    return Boolean(await firstVisible(this.#stopButtonLocators()));
  }

  // A plan/usage limit renders as an error card: error-tinted token classes
  // (text-token-text-error / bg-token-surface-error) plus a regenerate button
  // (data-testid="regenerate-thread-error-button"). Protocol replies are plain
  // markdown and never contain those, so their presence confirms the matching
  // text is a real notice rather than a reply that mentions "limit" in its
  // content. Text stays the primary signal (a notice always says something
  // recognizable in the UI language); the DOM features guard against false
  // positives and future language additions.
  async #findUsageLimitMarker(message) {
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

  async #clickStopButton() {
    const stop = await firstVisible(this.#stopButtonLocators());
    if (stop) {
      await stop.click({ timeout: 3_000 }).catch(() => null);
    }
  }

  // While a turn is being processed, raw-mode stdin lets ESC cancel the wait
  // (like ChatGPT). Raw mode swallows Ctrl+C, so forward it as a real SIGINT
  // so the CLI's existing interrupt path still runs. The returned detach
  // restores the previous terminal mode, keeping approval prompts (which also
  // read stdin) working. Keys other than ESC/Ctrl+C are consumed and dropped.
  #attachEscCancel() {
    if (!this.cancelOnEsc || !this.stdinStream?.isTTY) {
      return null;
    }
    const stream = this.stdinStream;
    emitKeypressEvents(stream);
    const previousRaw = stream.isRaw;
    stream.setRawMode(true);
    this.escCancelRequested = false;
    const onKeypress = (_chunk, key) => {
      if (key?.name === "escape") {
        this.escCancelRequested = true;
      } else if (key?.ctrl && key?.name === "c") {
        process.kill(process.pid, "SIGINT");
      }
    };
    stream.on("keypress", onKeypress);
    return () => {
      stream.removeListener("keypress", onKeypress);
      stream.setRawMode(previousRaw);
    };
  }

  async #dismissTransientOverlays() {
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
      await this.#writeDiagnostics("blocking-modal");
      throw new BrowserAdapterError(
        "A ChatGPT modal is blocking the composer and could not be dismissed safely.",
        { code: "BLOCKING_MODAL" },
      );
    }
  }

  async #throwIfBlockedPage() {
    const title = await this.page.title().catch(() => "");
    const titleTokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const challengeTitle =
      (titleTokens.has("cloudflare") && titleTokens.has("attention")) ||
      (titleTokens.has("verify") && titleTokens.has("human")) ||
      (titleTokens.has("security") && titleTokens.has("check")) ||
      (titleTokens.has("just") && titleTokens.has("moment"));

    const challengeElement = await firstVisible([
      this.page.locator('iframe[src*="challenges.cloudflare.com"]'),
      this.page.locator('input[name="cf-turnstile-response"]'),
      this.page.locator('#challenge-stage'),
      this.page.locator('form[action*="/cdn-cgi/challenge-platform/"]'),
      this.page.locator('[data-testid="challenge-stage"]'),
    ]);

    if (!challengeTitle && !challengeElement) {
      return;
    }

    // A CAPTCHA/challenge needs the user's eyes and hands — surface the window
    // if it was minimized before reporting the block.
    await this.restoreWindow();
    throw new BrowserAdapterError("Browser access challenge detected.");
  }

  async #writeDiagnostics(label) {
    if (!this.debug || !this.page) {
      return;
    }
    const directory = path.join(this.profileDir, "..", "diagnostics");
    await ensureDirectory(directory);
    const stamp = Date.now();
    await Promise.all([
      this.page.screenshot({
        path: path.join(directory, `${stamp}-${label}.png`),
        fullPage: true,
      }).catch(() => null),
      fs.writeFile(
        path.join(directory, `${stamp}-${label}.html`),
        await this.page.content(),
        "utf8",
      ).catch(() => null),
    ]);
  }

  #requirePage() {
    if (!this.page) {
      throw new BrowserAdapterError("Browser has not been launched.");
    }
  }
}

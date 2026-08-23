import fs from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { launchAndConnectCdpChrome } from "./cdp-browser.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import { ensureDirectory } from "../platform/paths.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { runModeSelection } from "./mode-selection.js";

// Playwright error messages for a dead transport. The Chrome process itself is
// usually still alive (e.g. the connection died while the Mac slept); these
// errors mean "reconnect", not "the browser is gone". This is a transport-level
// concern shared by every provider, so it lives on the base module.
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

// Interstitial text of the common anti-bot challenges, across the locales the
// providers ship. Used ONLY on pages with no composer (see throwIfBlockedPage),
// so a model reply mentioning these phrases can never trigger it.
const CHALLENGE_BODY_PATTERN =
  /just a moment|verify you are human|checking your browser|security check|attention required|请稍候|安全验证|正在验证|人机验证|少々お待ち|セキュリティ|ご本人確認|認証|잠시만 기다려|보안 확인|인증|un instant|vérification|einen moment|sicherheitsprüfung|verificando|um momento/i;

export async function firstVisible(locators) {
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

export function hasCompleteAgentEnvelope(text) {
  const trimmed = String(text ?? "").trim();
  const start = trimmed.indexOf("<agent_response");
  const endTag = "</agent_response>";
  const end = trimmed.lastIndexOf(endTag);
  // The envelope is "complete" as soon as both the opening and closing tags
  // are present. The web model may append trailing text or render rich cards
  // after the XML, so we do not require the closing tag to be the last content.
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

// Provider-independent orchestration for a web-AI conversation driven over CDP.
//
// The runtime talks to this class only through its public methods; everything
// that varies between providers (ChatGPT, DeepSeek, …) is isolated behind the
// overridable "primitive" methods below. A concrete provider subclass supplies
// its base URL, DOM locators, message-identity extraction, and (optionally) a
// model-switcher port; it must NOT re-implement the turn-completion loop, the
// send/auth/reconnect flow, or the WTAgent <agent_response> protocol timing.
//
// IMPORTANT (JavaScript semantics): primitives that the base dispatches to a
// provider are declared as ordinary (non-#private) methods. `#private` methods
// are resolved lexically and are NOT overridable, so a base method calling
// `this.#foo()` would never reach a subclass override. Only truly base-internal
// helpers that no subclass overrides or calls stay `#private`.
export class BaseWebAdapter {
  constructor({
    profileDir,
    chromePath,
    baseUrl,
    providerName = "Web",
    debug = false,
    minimized = false,
    stdinStream = process.stdin,
    cancelOnEsc = false,
  }) {
    this.profileDir = path.resolve(profileDir);
    this.chromePath = chromePath;
    this.baseUrl = baseUrl;
    this.providerName = providerName;
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
    this.assistantCountBeforeSend = 0;
    this.sentUserTurn = null;
    this.lastAssistantMessageId = null;
    this.lastModeSelection = null;
  }

  // ---- provider primitives (override in subclasses) ----------------------
  // Defaults are deliberately inert: locator lists are empty, identity is
  // unknown, and optional UI steps are no-ops. A provider that leaves a
  // required primitive unimplemented simply never finds its controls, which
  // surfaces as a clear "not found" adapter error rather than a silent guess.

  conversationUrlPattern() {
    // RegExp tested against a URL pathname to tell a live conversation from the
    // provider's home/new-chat page. null means "no distinct conversation URL".
    return null;
  }

  composerLocators() {
    return [];
  }

  sendButtonLocators() {
    return [];
  }

  stopButtonLocators() {
    return [];
  }

  newConversationControls() {
    return [];
  }

  loginControlLocators() {
    return [];
  }

  authTextPattern() {
    // Body text that only a signed-out/guest shell renders. The default never
    // matches, so a provider that omits it relies on login controls + composer
    // presence alone.
    return /(?!)/;
  }

  // Pathname regex that only a signed-out page has (e.g. ChatGPT's /auth/…,
  // DeepSeek's /sign_in, GLM's /auth). URL checks are locale-independent, so a
  // provider that redirects logged-out visitors to a login path should override
  // this; getAuthState() consults it before any text pattern. null = no signal.
  authUrlPattern() {
    return null;
  }

  assistantMessages() {
    return this.page.locator("[data-web-adapter-unset-assistant]");
  }

  userMessages() {
    return this.page.locator("[data-web-adapter-unset-user]");
  }

  conversationMessages() {
    return this.page.locator("[data-web-adapter-unset-message]");
  }

  // Extract a provider's stable identity for one message node. `id` is a stable
  // per-message id when the DOM exposes one; `turn` is a monotonic ordinal for
  // the message's position in the thread. Either may be null.
  async messageIdentity(_message) {
    return { id: null, turn: null };
  }

  // Full assistant text for one message node, preserving a complete
  // <agent_response> envelope even when the provider splits it across nodes.
  async assistantText(message) {
    return await message.innerText().catch(() => "");
  }

  // Returns a short human string when the message is a plan/usage-limit notice,
  // or null when it is an ordinary reply. Default: never a limit.
  async findUsageLimitMarker(_message) {
    return null;
  }

  // Returns a short human string when the message is a provider-side
  // generation FAILURE card (e.g. ChatGPT's "Internal Server Error" with a
  // 重试 button) rather than a real answer, or null for ordinary replies.
  // Such cards must never be treated as a final plain answer — the runtime
  // nudges the model to regenerate instead. Default: never a failure card.
  async findGenerationErrorMarker(_message) {
    return null;
  }

  // Port consumed by runModeSelection(). Default reports no switcher, so
  // selectMode() resolves to "switcher_not_found" and never blocks a provider
  // that has no model picker.
  modeSelectionPort() {
    return {
      alreadyOnMode: async () => false,
      hasSwitcher: async () => false,
      openMenu: async () => {},
      readOptions: async () => [],
      clickOption: async () => false,
      waitClosed: async () => false,
      waitSelected: async () => false,
      closeMenu: async () => {},
      writeDiagnostics: async (label) => this.writeDiagnostics(label),
    };
  }

  // Best-effort composer file upload. Default: nothing attached.
  async attachFiles(_files) {
    return { attached: [], failed: [] };
  }

  // Dismiss a provider's transient modal that would block the composer. No-op
  // by default.
  async dismissTransientOverlays() {}

  // Put outbound text into the provider composer. Most sites accept
  // Locator.fill(); providers whose UI depends on native focus/pointer events
  // can override this primitive without duplicating sendMessage().
  async fillComposer(composer, text) {
    try {
      await composer.fill(text);
    } catch {
      await this.dismissTransientOverlays();
      await composer.focus();
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+A" : "Control+A",
      );
      await this.page.keyboard.insertText(text);
    }
  }

  // Submit the already-filled composer. Providers that need a native pointer
  // sequence may override this while retaining the shared post-send identity
  // checks and one-shot retry.
  async submitComposer(composer) {
    const sendButton = await firstVisible(this.sendButtonLocators());
    if (sendButton && await sendButton.isEnabled().catch(() => false)) {
      try {
        await sendButton.click();
        return;
      } catch {
        await this.dismissTransientOverlays();
      }
    }
    await composer.press("Enter");
  }

  // Scroll a virtualized thread so the latest replies mount. No-op by default.
  async scrollConversationToBottom() {}

  // True while the latest assistant turn is still working even if no labeled
  // stop button is visible. Default false. Providers that hide generation
  // behind native tool cards (Kimi) override this so the turn loop does not
  // complete on a mid-tool failure and then try to send into a live reply.
  async isAssistantGenerating(_message) {
    return false;
  }

  // Extra time the latest assistant text must stay unchanged before the turn
  // is accepted. Default 0. Used when a provider may still append a protocol
  // envelope after a native-tool card has already gone quiet.
  async extraStableWindowMs(_message, _text) {
    return 0;
  }

  // True when the provider exposes a STRUCTURAL signal that reliably
  // distinguishes "generating" from "finished" — a stop control present only
  // while generating, or an action bar rendered only after completion
  // (Kimi/GLM/DeepSeek).
  hasReliableCompletionSignal() {
    return false;
  }

  // How long an incomplete envelope must stay unchanged before it is accepted
  // as a truncated (finished) reply. Providers with a reliable completion
  // signal can use a short window; providers without one (ChatGPT's new UI
  // removed [data-testid="stop-button"] and has no other structural signal)
  // need a much longer window: a mid-stream pause must not be mistaken for a
  // finished reply, because the follow-up format nudge aborts ChatGPT's
  // in-flight generation. Genuine streaming pauses essentially never exceed
  // the long window, so a truly finished-but-truncated reply is still
  // recovered well before the turn timeout.
  truncatedEnvelopeGraceMs() {
    return this.hasReliableCompletionSignal() ? 10_000 : 90_000;
  }

  // How long sendMessage() waits for the user bubble to appear. GLM can take
  // several seconds to commit a filled textarea, especially after a long tool
  // result, so providers may widen this.
  sentUserWaitAttempts() {
    return 50;
  }

  // Decide whether `candidate` is a genuinely new assistant reply for the
  // current send. Default ladder: the user turn sendMessage() observed, then a
  // stable message id, then a turn high-water mark; fail closed when none is
  // available (never guess by count or text — see design doc §9.3). Providers
  // whose DOM lacks stable ids/turns may override this with a count baseline.
  isNewAssistantIdentity({ id, turn }) {
    if (this.sentUserTurn != null && turn != null) {
      return turn > this.sentUserTurn;
    }
    if (id) {
      return !this.assistantIdsBeforeSend.has(id);
    }
    if (turn != null && this.assistantMaxTurnBeforeSend != null) {
      return turn > this.assistantMaxTurnBeforeSend;
    }
    return false;
  }

  // Multiplier applied to the dead-request grace window. Dead-request detection
  // assumes a provider proves liveness with a visible stop button while it is
  // working; a provider that exposes NO such signal (so `stopButtonLocators`
  // never matches during generation) needs a wider window, or its long
  // "thinking" phase before the first token is misread as a dead request.
  // Default 1 (ChatGPT, which has a reliable stop button); providers without a
  // liveness signal override this. Applies to both the initial and the
  // post-signal grace.
  deadRequestGraceMultiplier() {
    return 1;
  }

  // ---- lifecycle ---------------------------------------------------------

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

  // Leave Chrome open for inspection, but drop the CDP transport and the
  // profile lock so this Node process can exit and the next wtagent can reuse
  // the same window. close() would quit Chrome; disconnect() would keep the
  // lock held by this process.
  async detach() {
    await this.cdpChrome?.detach?.().catch(() => null);
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
    this.requirePage();
    // Locale-independent first: a logged-out page on a known auth path is
    // unauthenticated no matter which language the UI renders in.
    const authUrl = this.authUrlPattern();
    if (authUrl) {
      try {
        if (authUrl.test(new URL(this.page.url()).pathname)) {
          return "unauthenticated";
        }
      } catch {
        // Non-URL states (about:blank etc.) fall through to the DOM checks.
      }
    }
    if (await this.#findLoginControl()) {
      return "unauthenticated";
    }

    const body = await this.page.locator("body").innerText().catch(() => "");
    if (this.authTextPattern().test(body)) {
      return "unauthenticated";
    }

    return await this.#findComposer() ? "authenticated" : "unknown";
  }

  async waitForManualLogin({ timeoutMs }) {
    this.requirePage();
    const deadline = Date.now() + timeoutMs;
    let consecutiveAuthenticatedChecks = 0;

    while (Date.now() < deadline) {
      this.#throwIfCancelRequested();
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
    this.requirePage();
    let target = this.baseUrl;
    let resumesExistingConversation = Boolean(conversationUrl);
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
      const conversationPattern = this.conversationUrlPattern();
      // A run can fail before the first message is committed. In that case its
      // saved URL is the provider's home/new-chat page, not a conversation to
      // hydrate. Resume it as a verified fresh chat instead of waiting forever
      // for history that cannot exist.
      if (conversationPattern && !conversationPattern.test(parsed.pathname)) {
        resumesExistingConversation = false;
      }
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
        `${this.providerName} composer was not found after opening a new conversation.`,
        { code: "COMPOSER_NOT_FOUND" },
      );
    }

    if (resumesExistingConversation) {
      await this.#waitForConversationHistory({
        expectedAssistantMessageId,
        expectedUrl: target,
      });
      return;
    }

    if (!resumesExistingConversation && !await this.#isFreshConversation()) {
      await this.#openNewConversation();
      const freshComposer = await this.#waitForComposer(30_000);
      if (!freshComposer || !await this.#isFreshConversation()) {
        await this.writeDiagnostics("conversation-not-fresh");
        throw new BrowserAdapterError(
          `${this.providerName} did not open a verified empty conversation. `
            + "Refusing to send a new session prompt into an existing chat.",
          { code: "CONVERSATION_NOT_FRESH" },
        );
      }
    }
  }

  async selectMode(mode) {
    this.requirePage();
    if (!mode) {
      return { status: "skipped", requested: mode, attempts: 0 };
    }

    const port = this.modeSelectionPort();
    const result = await runModeSelection(port, mode);
    this.lastModeSelection = result;
    return result;
  }

  async getConversationUrl() {
    this.requirePage();
    return this.page.url();
  }

  async getLastAssistantMessageId() {
    return this.lastAssistantMessageId;
  }

  async sendMessage(text, { files = [], maxBytes = null } = {}) {
    this.requirePage();
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
        `${this.providerName} composer is unavailable.`,
        { code: "COMPOSER_NOT_FOUND" },
      );
    }

    await this.dismissTransientOverlays();
    await this.#waitUntilReadyToSend();

    // Attach any @file uploads before typing/sending. Upload is best-effort: a
    // failure is reported to the caller but does not block sending the text.
    let attachment = null;
    if (files.length > 0) {
      attachment = await this.attachFiles(files);
    }

    const assistantMessages = this.assistantMessages();
    const assistantBaseline = await this.#captureMessageIdentities(
      assistantMessages,
    );
    const userBaseline = await this.#captureMessageIdentities(
      this.userMessages(),
    );
    this.assistantIdsBeforeSend = assistantBaseline.ids;
    this.assistantMaxTurnBeforeSend = assistantBaseline.maxTurn;
    // Count baseline for providers whose DOM exposes no stable per-message id
    // or turn ordinal (they override isNewAssistantIdentity to use it).
    this.assistantCountBeforeSend = assistantBaseline.count;
    this.lastAssistantTextBeforeSend = assistantBaseline.count > 0
      ? await this.assistantText(assistantMessages.last()).catch(() => "")
      : "";
    this.sentUserTurn = null;

    await this.fillComposer(composer, text);

    await this.submitComposer(composer);

    const conversationPattern = this.conversationUrlPattern();
    if (
      conversationPattern
      && !conversationPattern.test(new URL(urlBeforeSend).pathname)
    ) {
      await this.page.waitForURL(
        (url) => conversationPattern.test(url.pathname),
        { timeout: 5_000 },
      ).catch(() => null);
    }

    let sentMessage = await this.#waitForSentUserMessage(userBaseline);
    if (!sentMessage) {
      // A click/Enter can be ignored while a native-tool card is still open.
      // Retry once after the composer is idle again.
      await this.#waitUntilReadyToSend(5_000);
      await this.submitComposer(composer);
      sentMessage = await this.#waitForSentUserMessage(userBaseline);
    }
    if (!sentMessage) {
      // The model never rendered the message: the send did not register (a
      // disabled send button, a missed Enter, or a transient UI state). Fail
      // loudly instead of pretending the message went out — otherwise the
      // runtime waits for a reply that was never received.
      await this.writeDiagnostics("send-not-detected");
      throw new BrowserAdapterError(
        `${this.providerName} did not render the sent message; the send may have failed.`,
        { code: "SEND_NOT_DETECTED" },
      );
    }
    return { attachment };
  }

  async waitForTurnComplete({
    timeoutMs,
    stableWindowMs,
    staleStopWindowMs = 15_000,
    truncatedEnvelopeWindowMs = null,
    emptyResponseWindowMs = 10_000,
    deadRequestGraceMs = 60_000,
    onDelta,
  }) {
    this.requirePage();
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
    const truncatedGraceMs = truncatedEnvelopeWindowMs
      ?? this.truncatedEnvelopeGraceMs();
    try {
      while (Date.now() < deadline) {
        await this.throwIfBlockedPage();

        if (this.escCancelRequested) {
          // ESC or Ctrl+C during processing: stop generating and hand control
          // back. Clicking the provider's stop button halts the in-flight reply.
          await this.#clickStopButton();
          this.escCancelRequested = false;
          throw new BrowserAdapterError(
            "Turn cancelled by user.",
            { code: "TURN_CANCELLED" },
          );
        }

        const messages = this.assistantMessages();
        const count = await messages.count();
        const lastMessage = count > 0 ? messages.last() : null;
        const candidateText = lastMessage
          ? await this.assistantText(lastMessage)
          : "";
        const { id: candidateId, turn: candidateTurn } = lastMessage
          ? await this.messageIdentity(lastMessage)
          : { id: null, turn: null };
        const hasNewAssistant = this.isNewAssistantIdentity({
          id: candidateId,
          turn: candidateTurn,
          text: candidateText,
        });

        const stopVisible = await this.#isStopButtonVisible();
        const assistantGenerating = lastMessage
          ? await this.isAssistantGenerating(lastMessage)
          : false;
        const generating = stopVisible || assistantGenerating;
        if (hasNewAssistant || generating) {
          // A reply node or a visible stop button proves generation started;
          // only a request with neither signal can be dead.
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

          if (!text.trim() && !generating) {
            // The model can create a real assistant turn and finish it without
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
                `${this.providerName} completed an assistant turn without any content.`,
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
          const extraStableMs = lastMessage
            ? await this.extraStableWindowMs(lastMessage, lastText)
            : 0;
          if (
            lastText.trim()
            && stableSince > 0
            && envelopeReady
            && !assistantGenerating
            && (
              (
                !stopVisible
                && Date.now() - stableSince >= stableWindowMs + extraStableMs
              )
              || (
                stopVisible
                && hasCompleteAgentEnvelope(lastText)
                && Date.now() - stableSince >= staleStopWindowMs
              )
            )
          ) {
            this.lastAssistantMessageId = candidateId;
            const limitMarker = await this.findUsageLimitMarker(lastMessage);
            if (limitMarker) {
              throw new BrowserAdapterError(
                `${this.providerName} reported a usage limit (${limitMarker}).`,
                { code: "USAGE_LIMIT_REACHED" },
              );
            }
            const generationError = await this.findGenerationErrorMarker(lastMessage);
            if (generationError) {
              throw new BrowserAdapterError(
                `${this.providerName} generation failed (${generationError}).`,
                { code: "GENERATION_FAILED" },
              );
            }
            return lastText.trim();
          }

          // A reply that STARTED a protocol envelope but ended without its
          // closing tag. Once the text has been unchanged for the provider's
          // truncated-envelope grace window (short for providers with a
          // reliable completion signal, long otherwise), treat it as finished
          // — truncated, not paused mid-stream — and hand it back so the
          // runtime's protocol parser can nudge the model to continue instead
          // of waiting out the whole turn timeout.
          if (
            lastText.trim()
            && looksLikeProtocol
            && !envelopeReady
            && !stopVisible
            && !assistantGenerating
            && Date.now() - stableSince >= truncatedGraceMs
          ) {
            this.lastAssistantMessageId = candidateId;
            return lastText.trim();
          }
        }

        // Dead-request detection: the user message was sent but the model
        // stopped producing signals — either it never started (no node, no stop
        // button) or a started generation went quiet for several grace periods
        // (stream dropped, server-side abort, usage limit). A node or visible
        // stop button means generation is alive and resets the clock. Recover
        // with a continuation nudge instead of waiting out the full timeout.
        const generationActive = hasNewAssistant || generating;
        const quietSince = sawGenerationSignal
          ? lastGenerationSignalAt
          : startedAt;
        const graceMs = deadRequestGraceMs * this.deadRequestGraceMultiplier();
        const quietGraceMs = sawGenerationSignal
          ? graceMs * 3
          : graceMs;
        if (
          !generationActive
          && this.sentUserTurn != null
          && Date.now() - quietSince >= quietGraceMs
        ) {
          await this.writeDiagnostics("dead-request");
          throw new BrowserAdapterError(
            `${this.providerName} stopped responding without completing a reply.`,
            {
              code: "DEAD_ASSISTANT_REQUEST",
              details: { sentUserTurn: this.sentUserTurn },
            },
          );
        }

        await this.page.waitForTimeout(sawAssistant ? 250 : 500);
      }

      await this.writeDiagnostics("turn-timeout");
      throw new BrowserAdapterError(
        `${this.providerName} turn did not complete within ${Math.round(timeoutMs / 1000)} seconds.`,
        { code: "TURN_TIMEOUT" },
      );
    } finally {
      detachEscCancel?.();
    }
  }

  // ---- generic base-internal helpers (never overridden) ------------------

  async #findComposer() {
    return await firstVisible(this.composerLocators());
  }

  async #findLoginControl() {
    return await firstVisible(this.loginControlLocators());
  }

  async #isFreshConversation() {
    const current = new URL(this.page.url());
    const base = new URL(this.baseUrl);
    const pattern = this.conversationUrlPattern();
    if (
      current.hostname !== base.hostname
      || (pattern && pattern.test(current.pathname))
    ) {
      return false;
    }
    return await this.conversationMessages().count() === 0;
  }

  async #openNewConversation() {
    const control = await firstVisible(this.newConversationControls());
    if (control) {
      await control.click().catch(() => null);
      await this.page.waitForTimeout(500);
    }
    if (!await this.#isFreshConversation()) {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  async #waitForComposer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.#throwIfCancelRequested();
      const composer = await this.#findComposer();
      if (composer) return composer;
      await this.page.waitForTimeout(500);
    }
    return null;
  }

  async #waitUntilReadyToSend(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.#throwIfCancelRequested();
      const stopVisible = await this.#isStopButtonVisible();
      const messages = this.assistantMessages();
      const count = await messages.count().catch(() => 0);
      const lastAssistant = count > 0 ? messages.last() : null;
      const assistantGenerating = lastAssistant
        ? await this.isAssistantGenerating(lastAssistant)
        : false;
      if (!stopVisible && !assistantGenerating) {
        return;
      }
      await this.page.waitForTimeout(250);
    }
  }

  async #captureMessageIdentities(messages) {
    const count = await messages.count().catch(() => 0);
    const ids = new Set();
    let maxTurn = null;
    for (let index = 0; index < count; index += 1) {
      const identity = await this.messageIdentity(messages.nth(index));
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

  async #waitForSentUserMessage(baseline, attempts = this.sentUserWaitAttempts()) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.#throwIfCancelRequested();
      const messages = this.userMessages();
      const count = await messages.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const identity = await this.messageIdentity(messages.nth(index));
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
      this.#throwIfCancelRequested();
      const assistant = await this.#captureMessageIdentities(
        this.assistantMessages(),
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
        await this.scrollConversationToBottom();
        scrolledToBottom += 1;
      }

      const totalMessages = await this.conversationMessages()
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
          // deleted (providers remove transient error/limit cards, and the last
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

    await this.writeDiagnostics("conversation-history-mismatch");
    const detail = expectedAssistantMessageId
      ? ` Expected assistant message ${expectedAssistantMessageId} was not found.`
      : " Existing conversation history did not become stable.";
    throw new BrowserAdapterError(
      `${this.providerName} conversation history could not be verified.${detail}`,
      { code: "CONVERSATION_HISTORY_MISMATCH" },
    );
  }

  async #isStopButtonVisible() {
    return Boolean(await firstVisible(this.stopButtonLocators()));
  }

  async #clickStopButton() {
    const stop = await firstVisible(this.stopButtonLocators());
    if (stop) {
      await stop.click({ timeout: 3_000 }).catch(() => null);
    }
  }

  // While a turn is being processed, raw-mode stdin lets ESC cancel the wait.
  // Raw mode swallows Ctrl+C, so forward it as a real SIGINT so the CLI's
  // existing interrupt path still runs. The returned detach restores the
  // previous terminal mode, keeping approval prompts (which also read stdin)
  // working. Keys other than ESC/Ctrl+C are consumed and dropped.
  //
  // A pending cancel request (Ctrl+C pressed before this wait started, e.g.
  // while a tool was running) must cancel the wait immediately, so the flag is
  // deliberately NOT reset on attach.
  #attachEscCancel() {
    if (!this.cancelOnEsc || !this.stdinStream?.isTTY) {
      return null;
    }
    const stream = this.stdinStream;
    emitKeypressEvents(stream);
    const previousRaw = stream.isRaw;
    stream.setRawMode(true);
    const onKeypress = (_chunk, key) => {
      if (key?.name === "escape") {
        this.escCancelRequested = true;
      } else if (key?.ctrl && key?.name === "c") {
        process.kill(process.pid, "SIGINT");
      }
    };
    stream.on("keypress", onKeypress);
    // A previous detach may have left the stream paused; a paused stream never
    // delivers keypress events, so make sure reads are active.
    stream.resume();
    return () => {
      stream.removeListener("keypress", onKeypress);
      stream.setRawMode(previousRaw);
      // readline's emitKeypressEvents keeps its internal 'data' listener on the
      // stream even after the last 'keypress' listener is removed, which leaves
      // the TTY read active and pins the event loop open — the process would
      // never exit. Pause the stream so the loop can drain between turns and at
      // shutdown; the next attach resumes it.
      stream.pause();
    };
  }

  // Throws TURN_CANCELLED when a cancel was requested before or during a wait.
  // Called from the bounded polling loops below (send/login/composer waits) so
  // a Ctrl+C lands promptly even outside waitForTurnComplete.
  #throwIfCancelRequested() {
    if (this.escCancelRequested) {
      throw new BrowserAdapterError(
        "Turn cancelled by user.",
        { code: "TURN_CANCELLED" },
      );
    }
  }

  // Detects a CAPTCHA/anti-bot challenge (Cloudflare et al.) and surfaces the
  // window for the user. Provider-independent infrastructure; a provider with a
  // different challenge surface may override it.
  //
  // Detection is deliberately layered from most to least reliable:
  //   1. challenge URL (locale-independent),
  //   2. challenge DOM elements (locale-independent),
  //   3. title tokens (English titles only),
  //   4. a multilingual body-text pattern — but ONLY when no composer is on
  //      the page. A normal chat page always has its composer, so assistant
  //      text that merely mentions "安全验证" / "Just a moment" in a reply can
  //      never false-positive; a challenge page has no composer at all.
  async throwIfBlockedPage() {
    let pageUrl = "";
    try {
      pageUrl = this.page.url();
    } catch {
      // Fall through to the DOM checks below.
    }
    const challengeUrl = pageUrl.includes("challenges.cloudflare.com")
      || pageUrl.includes("/cdn-cgi/");

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

    if (!challengeUrl && !challengeTitle && !challengeElement) {
      // Only bother reading body text when the page has no composer — a
      // composer proves this is the normal chat UI, not an interstitial.
      const composer = await this.#findComposer();
      if (!composer) {
        const body = typeof this.page.evaluate === "function"
          ? await this.page
            .evaluate(() => (document.body.textContent ?? "").slice(0, 1500))
            .catch(() => "")
          : "";
        if (!CHALLENGE_BODY_PATTERN.test(body)) {
          return;
        }
      } else {
        return;
      }
    }

    // A CAPTCHA/challenge needs the user's eyes and hands — surface the window
    // if it was minimized before reporting the block.
    await this.restoreWindow();
    throw new BrowserAdapterError("Browser access challenge detected.");
  }

  async writeDiagnostics(label) {
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

  // Non-private so provider subclasses (e.g. attachFiles) can guard too.
  requirePage() {
    if (!this.page) {
      throw new BrowserAdapterError("Browser has not been launched.");
    }
  }
}

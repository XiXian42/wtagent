import fs from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { launchAndConnectCdpChrome } from "./cdp-browser.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import { ensureDirectory } from "../platform/paths.js";
import { BrowserAdapterError } from "../shared/errors.js";

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

// A composer can mount well before an existing SPA conversation finishes
// hydrating. Require several seconds of unchanged URL + DOM state before either
// restored history or an empty new-chat page is trusted.
const RESTORATION_STABLE_CHECKS = 12;
const RESTORATION_STABLE_WINDOW_MS = (RESTORATION_STABLE_CHECKS - 1) * 250;

function normalizedPathname(value) {
  const pathname = String(value || "/").replace(/\/+$/, "");
  return pathname || "/";
}

function normalizedConversationUrl(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    return `${parsed.origin}${normalizedPathname(parsed.pathname)}`;
  } catch {
    return null;
  }
}

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
  const normalizedLeft = normalizedConversationUrl(left);
  return normalizedLeft != null
    && normalizedLeft === normalizedConversationUrl(right);
}

function comparableMessageText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const OUTBOUND_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OUTBOUND_MARKER_PREFIX =
  "Opaque WTAgent transport correlation ID (do not repeat): ";

function renderedMessageContains(rendered, expected, outboundId = null) {
  const normalizedRendered = comparableMessageText(rendered);
  const normalizedExpected = comparableMessageText(expected);
  const reminderStart = normalizedExpected.lastIndexOf("<system_reminder>");
  const reminder = reminderStart < 0 ? "" : normalizedExpected.slice(reminderStart);
  const correlation = reminder.match(
    /(Opaque WTAgent transport correlation ID \(do not repeat\): ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.)<\/system_reminder>$/,
  );
  if (!correlation) {
    return outboundId == null
      && normalizedExpected.length > 0
      && normalizedRendered.includes(normalizedExpected);
  }
  if (outboundId != null && correlation[2] !== outboundId) {
    return false;
  }
  // Markdown can change the displayed payload. Correlate only the exact
  // per-send nonce from its final reminder; URL/history guards remain separate.
  const marker = correlation[1];
  const index = normalizedRendered.indexOf(marker);
  if (index < 0 || normalizedRendered.indexOf(marker, index + marker.length) !== -1) {
    return false;
  }
  const renderedReminderStart = normalizedRendered.lastIndexOf("<system_reminder>", index);
  if (
    renderedReminderStart < 0
    || normalizedRendered.slice(renderedReminderStart, index).includes("</system_reminder>")
  ) {
    return false;
  }
  const closingTag = "</system_reminder>";
  const renderedSuffix = normalizedRendered.slice(index + marker.length);
  if (!renderedSuffix.startsWith(closingTag)) {
    return false;
  }
  const trailing = renderedSuffix.slice(closingTag.length);
  return !trailing.includes("<system_reminder")
    && !trailing.includes("</system_reminder>");
}

export function isValidOutboundCorrelationId(value) {
  return typeof value === "string" && OUTBOUND_ID_PATTERN.test(value);
}

export function renderedMessageContainsOutboundMarker(rendered, outboundId) {
  if (!isValidOutboundCorrelationId(outboundId)) {
    return false;
  }
  const expected = `<system_reminder>${OUTBOUND_MARKER_PREFIX}${outboundId}.</system_reminder>`;
  return renderedMessageContains(rendered, expected, outboundId);
}

// Provider-independent orchestration for a web-AI conversation driven over CDP.
//
// The runtime talks to this class only through its public methods; everything
// that varies between providers (ChatGPT, DeepSeek, …) is isolated behind the
// overridable "primitive" methods below. A concrete provider subclass supplies
// its base URL, DOM locators, and message-identity extraction; it must NOT
// re-implement the turn-completion loop, send/auth/reconnect flow, or the
// WTAgent <agent_response> protocol timing. Model selection deliberately stays
// outside adapters: users choose their model directly on the provider website.
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
    this.preservedPreferredUrl = null;
    this.observedConversationUrl = null;
    this.observedConversationAliases = new Set();
    this.pendingFreshConversationAliases = new Set();
    this.pendingFreshEmptyAliases = new Map();
    this.conversationIdentityListener = null;
    this.pageNavigationListener = null;
    this.lastObservedPageUrl = null;
    this.pendingCanonicalUrl = null;
    this.pendingCanonicalSignature = null;
    this.pendingCanonicalStableSince = 0;
    this.pendingCanonicalVerificationQueue = Promise.resolve();
    this.conversationObservationArmed = false;
    this.freshSendConfirmed = false;
    this.navigationEpoch = 0;
    this.sendEpoch = 0;
    this.conversationScopeEpoch = 0;
    this.activeSendProof = null;
    this.activeTurnProof = null;
    this.activeTurnConversationUrl = null;
    this.allowInPlaceAssistantContinuation = false;
    this.inPlaceAssistantGenerationObserved = false;
    this.expectedRestorationAssistantId = null;
    this.expectedRestorationUserId = null;
    this.expectedAssistantCandidateId = null;
    this.expectedAssistantCandidateTurn = null;
    this.recoveredTurnTopologyRequired = false;
    this.preferredTabAmbiguous = false;
    this.assistantIdsBeforeSend = new Set();
    this.assistantMaxTurnBeforeSend = null;
    this.assistantCountBeforeSend = 0;
    this.sentUserTurn = null;
    this.lastUserMessageId = null;
    this.lastAssistantMessageId = null;
    this.lastAssistantTurn = null;
    this.lastSendStatus = "not-submitted";
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

  freshConversationUrlPattern() {
    // Optional extra provider routes that explicitly mean a blank new chat. The
    // baseUrl pathname is always accepted; arbitrary other same-origin routes are
    // not. For example, Claude exposes both / and /new.
    return null;
  }

  // Classifies saved/current URLs without navigating to them. Providers may
  // refine a matching conversation route into "provisional" when it is useful
  // only as a locator for an already-open tab, not as a durable navigation URL.
  // Only the provider's explicit base route is fresh; an arbitrary same-origin
  // settings/project/error route is unknown and must never receive a prompt.
  classifyConversationUrl(value) {
    let parsed;
    let base;
    try {
      parsed = value instanceof URL ? value : new URL(value);
      base = new URL(this.baseUrl);
    } catch {
      return "invalid";
    }
    if (parsed.protocol !== "https:" || parsed.origin !== base.origin) {
      return "invalid";
    }

    const pattern = this.conversationUrlPattern();
    if (pattern?.test(parsed.pathname)) {
      return "restorable";
    }
    const explicitFresh = normalizedPathname(parsed.pathname)
      === normalizedPathname(base.pathname)
      || this.freshConversationUrlPattern()?.test(parsed.pathname);
    return explicitFresh ? "fresh" : "unknown";
  }

  // Existing attachment previews in a reused tab may belong to an abandoned
  // draft. Providers with uploads override this with structural chip locators;
  // the base refuses to send until no stale chips remain.
  pendingAttachmentLocators() {
    return [];
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

  // Used only to correlate a post-submit bubble while the provider is assigning
  // a new conversation URL. Stable URL bindings remain the primary guard.
  async userMessageText(message) {
    return await message.innerText().catch(() => "");
  }

  // Providers with a shared user/assistant turn order return one atomic snapshot.
  // null keeps legacy normal-send behavior but cannot support ambiguous recovery.
  async orderedConversationSnapshot() {
    return null;
  }

  // Recovery-capable providers revalidate the correlated user/assistant suffix
  // from one atomic DOM snapshot while the generic completion loop is running.
  // The default is a no-op because providers without ordered snapshots never
  // enter pending-outbound reconciliation.
  async assertRecoveredTurnTopology(_candidate = {}) {}

  // Providers that expose a single shared user/assistant order can require that
  // atomic view when binding a fresh send. This prevents separately queried role
  // locators from being combined across SPA hydration frames.
  requiresOrderedConversationSnapshotForFreshSend() {
    return false;
  }

  supportsPendingOutboundRecovery() {
    return false;
  }

  async reconcilePendingOutbound() {
    throw new BrowserAdapterError(
      `${this.providerName} does not support pending outbound recovery.`,
      { code: "OUTBOUND_RECOVERY_UNSUPPORTED", recoverable: false },
    );
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

  // One monotonic deadline covers submit, URL allocation, user-bubble discovery,
  // and causal stabilization. Providers may widen it for unusually slow commits.
  sendConfirmationTimeoutMs() {
    return 20_000;
  }

  monotonicNow() {
    return performance.now();
  }

  async waitForPoll(ms) {
    await this.page.waitForTimeout(ms);
  }

  #sendDeadlineError() {
    return new BrowserAdapterError(
      `${this.providerName} did not confirm the submitted message before the causal deadline. `
        + "It was not sent again automatically.",
      { code: "SEND_COMMIT_UNKNOWN", recoverable: false },
    );
  }

  async #awaitWithinSendDeadline(promise, deadline) {
    const remaining = deadline - this.monotonicNow();
    if (remaining <= 0) {
      throw this.#sendDeadlineError();
    }
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(this.#sendDeadlineError()),
            Math.max(1, Math.ceil(remaining)),
          );
        }),
      ]);
      if (this.monotonicNow() >= deadline) {
        throw this.#sendDeadlineError();
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  // Real elapsed time required before a URL/DOM correlation becomes trusted.
  // Kept overridable only so deterministic adapter tests need not sleep.
  restorationCorrelationWindowMs() {
    return RESTORATION_STABLE_WINDOW_MS;
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

  acceptRecoveredOutboundAnchor({
    conversationUrl,
    conversationTargetId,
    userMessageId,
    userTurn = null,
    assistantBaseline = null,
    assistantCandidateMessageId = null,
    assistantCandidateTurn = null,
  }) {
    const normalizedUrl = normalizedConversationUrl(conversationUrl);
    const kind = normalizedUrl
      ? this.classifyConversationUrl(normalizedUrl)
      : "invalid";
    if (
      !this.page
      || !["restorable", "provisional"].includes(kind)
      || !sameConversationUrl(this.page.url(), normalizedUrl)
      || (conversationTargetId ?? null) !== (this.cdpChrome?.targetId ?? null)
    ) {
      throw new BrowserAdapterError(
        `${this.providerName} recovery anchor no longer matches the exact browser target.`,
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }

    const baselineIds = Array.isArray(assistantBaseline?.ids)
      ? assistantBaseline.ids.filter(Boolean)
      : [];
    this.#beginConversationObservation(normalizedUrl, {
      arm: false,
      reset: true,
    });
    this.assistantIdsBeforeSend = new Set(baselineIds);
    this.assistantMaxTurnBeforeSend = Number.isSafeInteger(
      assistantBaseline?.maxTurn,
    )
      ? assistantBaseline.maxTurn
      : null;
    this.assistantCountBeforeSend = Number.isSafeInteger(
      assistantBaseline?.count,
    )
      ? assistantBaseline.count
      : baselineIds.length;
    this.lastAssistantTextBeforeSend = String(
      assistantBaseline?.lastText ?? "",
    );
    this.sentUserTurn = Number.isSafeInteger(userTurn) ? userTurn : null;
    this.lastUserMessageId = userMessageId ?? null;
    this.expectedRestorationUserId = userMessageId ?? null;
    this.expectedRestorationAssistantId = baselineIds.at(-1) ?? null;
    this.expectedAssistantCandidateId = typeof assistantCandidateMessageId === "string"
      && assistantCandidateMessageId
      ? assistantCandidateMessageId
      : null;
    this.expectedAssistantCandidateTurn = Number.isSafeInteger(
      assistantCandidateTurn,
    )
      ? assistantCandidateTurn
      : null;
    this.recoveredTurnTopologyRequired = true;
    this.#captureActiveTurnProof(normalizedUrl);
    return this.#currentConversationIdentity();
  }

  setConversationIdentityListener(listener) {
    this.conversationIdentityListener = typeof listener === "function"
      ? listener
      : null;
  }

  async getConversationIdentity() {
    const currentUrl = this.page?.url?.() ?? null;
    if (
      currentUrl
      && normalizedConversationUrl(currentUrl) !== this.lastObservedPageUrl
    ) {
      this.#observeConversationNavigation(currentUrl);
    }
    await this.#verifyPendingCanonicalUrl();
    return this.#currentConversationIdentity();
  }

  #currentConversationIdentity() {
    const currentUrl = this.page?.url?.() ?? null;
    const currentKind = currentUrl
      ? this.classifyConversationUrl(currentUrl)
      : "invalid";
    const normalizedCurrent = normalizedConversationUrl(currentUrl);
    const currentIsTrusted = normalizedCurrent != null && (
      this.observedConversationAliases.has(normalizedCurrent)
      || (
        currentKind === "fresh"
        && normalizedCurrent === this.observedConversationUrl
      )
    );
    const conversationUrl = currentIsTrusted
      ? normalizedCurrent
      : this.observedConversationUrl;
    return {
      conversationUrl: conversationUrl ?? null,
      targetId: this.cdpChrome?.targetId ?? null,
      kind: conversationUrl
        ? this.classifyConversationUrl(conversationUrl)
        : "invalid",
    };
  }

  #isObservedConversationAlias(value) {
    const normalized = normalizedConversationUrl(value);
    return normalized != null && this.observedConversationAliases.has(normalized);
  }

  #activeSendProofIsIntact() {
    const proof = this.activeSendProof;
    if (!proof) {
      return true;
    }
    if (
      proof.invalidated
      || proof.sendEpoch !== this.sendEpoch
      || proof.page !== this.page
    ) {
      return false;
    }
    if (
      proof.mainFrame
      && typeof this.page?.mainFrame === "function"
      && this.page.mainFrame() !== proof.mainFrame
    ) {
      proof.invalidated = true;
      return false;
    }
    if ((proof.targetId ?? null) !== (this.cdpChrome?.targetId ?? null)) {
      proof.invalidated = true;
      return false;
    }
    if (
      proof.currentUrl
      && !sameConversationUrl(this.page?.url?.(), proof.currentUrl)
    ) {
      // Polling may observe a URL before Playwright dispatches its navigation
      // event. It can invalidate a proof, but it must never nominate a route.
      proof.invalidated = true;
      return false;
    }
    return true;
  }

  #captureActiveTurnProof(conversationUrl) {
    const normalizedUrl = normalizedConversationUrl(conversationUrl);
    this.activeTurnProof = {
      page: this.page,
      mainFrame: typeof this.page?.mainFrame === "function"
        ? this.page.mainFrame()
        : null,
      targetId: this.cdpChrome?.targetId ?? null,
      scopeEpoch: this.conversationScopeEpoch,
      conversationUrl: normalizedUrl,
      invalidated: false,
    };
    this.activeTurnConversationUrl = normalizedUrl;
  }

  #activeTurnProofIsIntact({ allowPendingCanonicalUrl = false } = {}) {
    const proof = this.activeTurnProof;
    if (!proof) {
      return this.activeTurnConversationUrl == null;
    }
    const currentUrl = normalizedConversationUrl(this.page?.url?.());
    if (
      proof.invalidated
      || proof.page !== this.page
      || proof.scopeEpoch !== this.conversationScopeEpoch
      || (proof.targetId ?? null) !== (this.cdpChrome?.targetId ?? null)
      || (
        proof.mainFrame
        && typeof this.page?.mainFrame === "function"
        && this.page.mainFrame() !== proof.mainFrame
      )
      || (
        !sameConversationUrl(currentUrl, proof.conversationUrl)
        && !this.#isObservedConversationAlias(currentUrl)
        && !(
          allowPendingCanonicalUrl
          && sameConversationUrl(currentUrl, this.pendingCanonicalUrl)
        )
      )
    ) {
      proof.invalidated = true;
      return false;
    }
    return true;
  }

  async #validateRecoveredTurnBoundary(candidate = {}) {
    if (!this.recoveredTurnTopologyRequired) {
      return;
    }
    const assertProof = () => {
      if (!this.#activeTurnProofIsIntact()) {
        throw new BrowserAdapterError(
          `${this.providerName} recovery boundary left its exact browser target. `
            + "No content from the changed conversation was accepted.",
          { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
        );
      }
    };
    assertProof();
    await this.assertRecoveredTurnTopology(candidate);
    assertProof();
  }

  #recordActiveSendCandidate(value, {
    previousUrl = null,
    allowCurrentNavigation = false,
  } = {}) {
    const proof = this.activeSendProof;
    if (!proof) {
      return true;
    }
    const candidate = normalizedConversationUrl(value);
    if (
      !candidate
      || proof.page !== this.page
      || proof.sendEpoch !== this.sendEpoch
      || (proof.invalidated && !allowCurrentNavigation)
      || !sameConversationUrl(previousUrl, proof.currentUrl)
    ) {
      return false;
    }
    proof.invalidated = false;
    proof.currentUrl = candidate;
    proof.candidateUrl = candidate;
    proof.candidateNavigationEpoch = this.navigationEpoch;
    proof.candidateBeforeSubmission = Boolean(
      proof.candidateBeforeSubmission || !proof.submissionStarted,
    );
    return true;
  }

  #resetPendingCanonicalVerification({ clearCandidate = false } = {}) {
    this.pendingCanonicalSignature = null;
    this.pendingCanonicalStableSince = 0;
    if (clearCandidate) {
      this.pendingCanonicalUrl = null;
    }
  }

  #stageCanonicalCandidate(value) {
    const normalized = normalizedConversationUrl(value);
    if (!normalized) {
      return false;
    }
    if (!sameConversationUrl(this.pendingCanonicalUrl, normalized)) {
      this.#resetPendingCanonicalVerification();
    }
    this.pendingCanonicalUrl = normalized;
    return true;
  }

  async #recordPendingFreshCandidateEmpty(value) {
    const candidate = normalizedConversationUrl(value);
    if (
      !candidate
      || !sameConversationUrl(this.page?.url?.(), candidate)
      || !this.pendingFreshConversationAliases.has(candidate)
    ) {
      return false;
    }
    if (await this.conversationMessages().count().catch(() => -1) !== 0) {
      this.pendingFreshEmptyAliases.set(candidate, {
        stableSince: 0,
        verified: false,
        poisoned: true,
      });
      return false;
    }
    if (
      !sameConversationUrl(this.page?.url?.(), candidate)
      || !this.pendingFreshConversationAliases.has(candidate)
    ) {
      this.pendingFreshEmptyAliases.delete(candidate);
      return false;
    }

    const observedAt = this.monotonicNow();
    const previous = this.pendingFreshEmptyAliases.get(candidate);
    const state = previous ?? {
      stableSince: observedAt,
      verified: false,
      poisoned: false,
    };
    if (state.poisoned) {
      return false;
    }
    state.verified = state.verified
      || observedAt - state.stableSince >= this.restorationCorrelationWindowMs();
    this.pendingFreshEmptyAliases.set(candidate, state);
    return state.verified;
  }

  async #waitForStablePendingFreshCandidate(candidate, {
    deadline = this.monotonicNow() + this.sendConfirmationTimeoutMs(),
  } = {}) {
    while (this.monotonicNow() < deadline) {
      if (await this.#recordPendingFreshCandidateEmpty(candidate)) {
        return true;
      }
      if (
        !sameConversationUrl(this.page?.url?.(), candidate)
        || !this.pendingFreshConversationAliases.has(candidate)
        || this.pendingFreshEmptyAliases.get(candidate)?.poisoned
      ) {
        return false;
      }
      await this.waitForPoll(Math.min(250, deadline - this.monotonicNow()));
    }
    return false;
  }

  #verifyPendingCanonicalUrl() {
    const operation = this.pendingCanonicalVerificationQueue
      .catch(() => false)
      .then(() => this.#verifyPendingCanonicalUrlNow());
    this.pendingCanonicalVerificationQueue = operation;
    return operation;
  }

  async #verifyPendingCanonicalUrlNow() {
    const candidate = this.pendingCanonicalUrl;
    const candidateKind = candidate
      ? this.classifyConversationUrl(candidate)
      : "invalid";
    if (
      !candidate
      || !sameConversationUrl(this.page?.url?.(), candidate)
      || !["restorable", "provisional"].includes(candidateKind)
    ) {
      this.#resetPendingCanonicalVerification();
      return false;
    }
    const [assistant, user] = await Promise.all([
      this.#captureMessageIdentities(this.assistantMessages()),
      this.#captureMessageIdentities(this.userMessages()),
    ]);
    const assistantMatched = Boolean(
      this.expectedRestorationAssistantId
      && assistant.ids.has(this.expectedRestorationAssistantId)
    );
    const userMatched = Boolean(
      this.expectedRestorationUserId
      && user.ids.has(this.expectedRestorationUserId)
    );
    if (!assistantMatched && !userMatched) {
      this.#resetPendingCanonicalVerification();
      return false;
    }

    const matchedMarker = assistantMatched
      ? `assistant:${this.expectedRestorationAssistantId}`
      : `user:${this.expectedRestorationUserId}`;
    const signature = [
      candidate,
      candidateKind,
      this.cdpChrome?.targetId ?? "",
      matchedMarker,
    ].join(":");
    const observedAt = this.monotonicNow();
    if (signature !== this.pendingCanonicalSignature) {
      this.pendingCanonicalSignature = signature;
      this.pendingCanonicalStableSince = observedAt;
      return false;
    }
    if (
      observedAt - this.pendingCanonicalStableSince
      < this.restorationCorrelationWindowMs()
    ) {
      return false;
    }
    if (
      !sameConversationUrl(this.pendingCanonicalUrl, candidate)
      || !sameConversationUrl(this.page?.url?.(), candidate)
    ) {
      this.#resetPendingCanonicalVerification();
      return false;
    }

    this.#trustConversationUrl(candidate);
    this.#resetPendingCanonicalVerification({ clearCandidate: true });
    this.#publishConversationIdentity();
    return true;
  }

  #publishConversationIdentity() {
    const identity = this.#currentConversationIdentity();
    if (
      !identity.conversationUrl
      || !["restorable", "provisional"].includes(identity.kind)
    ) {
      return;
    }
    Promise.resolve(this.conversationIdentityListener?.(identity)).catch(() => {});
  }

  #trustConversationUrl(value, { notify = false } = {}) {
    const normalized = normalizedConversationUrl(value);
    if (!normalized) {
      return false;
    }
    const kind = this.classifyConversationUrl(normalized);
    if (!["fresh", "restorable", "provisional"].includes(kind)) {
      return false;
    }
    this.observedConversationUrl = normalized;
    this.lastObservedPageUrl = normalized;
    if (["restorable", "provisional"].includes(kind)) {
      this.observedConversationAliases.add(normalized);
    }
    if (notify) {
      this.#publishConversationIdentity();
    }
    return true;
  }

  #observeConversationNavigation(value, { navigationEvent = false } = {}) {
    const normalized = normalizedConversationUrl(value);
    if (!normalized) {
      if (this.activeSendProof) {
        this.activeSendProof.invalidated = true;
      }
      return false;
    }
    const kind = this.classifyConversationUrl(normalized);
    const previous = this.lastObservedPageUrl;
    const previousKind = previous
      ? this.classifyConversationUrl(previous)
      : "invalid";
    const proofWasInvalidated = Boolean(this.activeSendProof?.invalidated);
    if (
      this.activeSendProof
      && !navigationEvent
      && !sameConversationUrl(normalized, this.activeSendProof.currentUrl)
    ) {
      // A polled URL change is not causal evidence. The matching top-frame event
      // must be observed first for this send epoch.
      this.activeSendProof.invalidated = true;
    }
    if (navigationEvent && this.activeSendProof) {
      // Every top-frame navigation invalidates the current proof until this exact
      // event is classified as an allowed causal transition below. A prior bad
      // transition is permanent; a later plausible route cannot rehabilitate it.
      this.activeSendProof.invalidated = true;
    }
    this.lastObservedPageUrl = normalized;

    if (this.#isObservedConversationAlias(normalized)) {
      this.observedConversationUrl = normalized;
      this.#publishConversationIdentity();
      return true;
    }
    const validNewConversation = navigationEvent
      && this.conversationObservationArmed
      && previousKind === "fresh"
      && ["provisional", "restorable"].includes(kind);
    const pendingCanonicalTransition = navigationEvent
      && previousKind === "provisional"
      && this.pendingFreshConversationAliases.has(previous)
      && kind === "restorable";
    const validCanonicalTransition = navigationEvent
      && previousKind === "provisional"
      && this.#isObservedConversationAlias(previous)
      && kind === "restorable";
    const activeTransitionCandidate = validNewConversation
      || pendingCanonicalTransition
      || validCanonicalTransition;
    const acceptedForActiveSend = !this.activeSendProof
      || (
        activeTransitionCandidate
        && this.#recordActiveSendCandidate(normalized, {
          previousUrl: previous,
          allowCurrentNavigation: navigationEvent && !proofWasInvalidated,
        })
      );

    if (
      (validNewConversation || pendingCanonicalTransition)
      && acceptedForActiveSend
    ) {
      this.pendingFreshConversationAliases.add(normalized);
      if (
        validNewConversation
        && this.activeSendProof?.candidateBeforeSubmission
      ) {
        void this.#recordPendingFreshCandidateEmpty(normalized).catch(() => null);
      }
      if (!this.freshSendConfirmed) {
        // Do not trust or publish a fresh-page transition before a new user bubble
        // proves this send. File upload can legitimately allocate /c/WEB: early,
        // while a user switching chats must remain untrusted.
        return false;
      }
      this.#stageCanonicalCandidate(normalized);
      return false;
    }
    if (validCanonicalTransition && acceptedForActiveSend) {
      // A top-frame event proves page continuity, not conversation identity: the
      // user could have navigated this tab. Promote only after a saved message id
      // is found on the candidate page.
      this.#stageCanonicalCandidate(normalized);
      return false;
    }
    return false;
  }

  #beginConversationObservation(seedUrl, { arm = false, reset = false } = {}) {
    if (reset) {
      this.conversationScopeEpoch += 1;
      this.activeTurnProof = null;
      this.observedConversationAliases.clear();
      this.pendingFreshConversationAliases.clear();
      this.pendingFreshEmptyAliases.clear();
      this.#resetPendingCanonicalVerification({ clearCandidate: true });
      this.observedConversationUrl = null;
      this.freshSendConfirmed = false;
    }
    if (seedUrl) {
      this.#trustConversationUrl(seedUrl);
    }
    if (arm) {
      this.pendingFreshConversationAliases.clear();
      this.pendingFreshEmptyAliases.clear();
      this.#resetPendingCanonicalVerification({ clearCandidate: true });
      this.freshSendConfirmed = false;
    }
    this.conversationObservationArmed = arm;
    if (this.pageNavigationListener || typeof this.page?.on !== "function") {
      return;
    }
    this.pageNavigationListener = (frame) => {
      try {
        if (
          typeof this.page.mainFrame === "function"
          && frame !== this.page.mainFrame()
        ) {
          return;
        }
        this.navigationEpoch += 1;
        this.#observeConversationNavigation(
          frame?.url?.() ?? this.page.url(),
          { navigationEvent: true },
        );
        void this.#verifyPendingCanonicalUrl().catch(() => null);
      } catch {
        // The transport may disappear while Playwright dispatches navigation.
      }
    };
    this.page.on("framenavigated", this.pageNavigationListener);
  }

  async #assertTrustedPageForSend(expectedUrl, {
    allowPendingFreshTransition = false,
  } = {}) {
    const currentUrl = normalizedConversationUrl(this.page.url());
    const turnBindingTrusted = !this.activeTurnConversationUrl
      || this.#activeTurnProofIsIntact();
    const directlyTrusted = turnBindingTrusted
      && this.#activeSendProofIsIntact()
      && (
        sameConversationUrl(currentUrl, expectedUrl)
        || this.#isObservedConversationAlias(currentUrl)
      );
    if (directlyTrusted) {
      return currentUrl;
    }
    if (
      allowPendingFreshTransition
      && turnBindingTrusted
      && this.#activeSendProofIsIntact()
      && this.pendingFreshConversationAliases.has(currentUrl)
      && await this.#waitForStablePendingFreshCandidate(currentUrl)
      && this.#activeSendProofIsIntact()
    ) {
      return currentUrl;
    }
    await this.writeDiagnostics("conversation-changed-before-send");
    throw new BrowserAdapterError(
      `${this.providerName} left the verified conversation before the message was submitted. `
        + "Nothing was sent.",
      { code: "CONVERSATION_CHANGED_BEFORE_SEND", recoverable: false },
    );
  }

  #isTrustedPageUrl(value) {
    const normalized = normalizedConversationUrl(value);
    const kind = normalized
      ? this.classifyConversationUrl(normalized)
      : "invalid";
    return Boolean(
      normalized
      && (
        this.#isObservedConversationAlias(normalized)
        || (
          kind === "fresh"
          && sameConversationUrl(normalized, this.observedConversationUrl)
        )
      )
    );
  }

  async #submittedPageState({ allowPendingFreshTransition = false } = {}) {
    const currentUrl = normalizedConversationUrl(this.page.url());
    if (!this.#activeSendProofIsIntact()) {
      return { status: "untrusted", conversationUrl: currentUrl };
    }
    if (sameConversationUrl(currentUrl, this.pendingCanonicalUrl)) {
      await this.#verifyPendingCanonicalUrl();
    }
    if (this.#isTrustedPageUrl(currentUrl)) {
      return { status: "trusted", conversationUrl: currentUrl };
    }
    if (
      sameConversationUrl(currentUrl, this.pendingCanonicalUrl)
      || (
        allowPendingFreshTransition
        && this.pendingFreshConversationAliases.has(currentUrl)
      )
    ) {
      return { status: "candidate", conversationUrl: currentUrl };
    }
    return { status: "untrusted", conversationUrl: currentUrl };
  }

  async #waitForCanonicalCandidate(candidate, {
    deadline = this.monotonicNow() + this.sendConfirmationTimeoutMs(),
  } = {}) {
    while (this.monotonicNow() < deadline) {
      const state = await this.#awaitWithinSendDeadline(
        this.#submittedPageState(),
        deadline,
      );
      if (state.status === "trusted") {
        return state.conversationUrl;
      }
      if (
        state.status !== "candidate"
        || !sameConversationUrl(state.conversationUrl, candidate)
      ) {
        return null;
      }
      const remaining = deadline - this.monotonicNow();
      if (remaining <= 0) {
        break;
      }
      await this.#awaitWithinSendDeadline(
        this.waitForPoll(Math.min(250, remaining)),
        deadline,
      );
    }
    return null;
  }

  #confirmFreshConversationSend() {
    this.freshSendConfirmed = true;
    const currentUrl = normalizedConversationUrl(this.page.url());
    const currentKind = currentUrl
      ? this.classifyConversationUrl(currentUrl)
      : "invalid";
    if (
      !["restorable", "provisional"].includes(currentKind)
      || !this.pendingFreshConversationAliases.has(currentUrl)
    ) {
      // Some providers keep the explicit fresh route until later in generation.
      // Leave observation armed; the confirmed user bubble now makes a later
      // fresh -> conversation transition eligible for marker verification.
      return;
    }
    // Only the page that contains this send's confirmed user bubble is trusted.
    // Earlier candidates may have been opened manually and must not become aliases.
    this.pendingFreshConversationAliases.clear();
    this.pendingFreshEmptyAliases.clear();
    this.#resetPendingCanonicalVerification({ clearCandidate: true });
    this.#trustConversationUrl(currentUrl, { notify: true });
    if (currentKind === "restorable") {
      this.conversationObservationArmed = false;
    }
  }

  #dropPageState({ clearObservation = true } = {}) {
    if (this.activeSendProof) {
      this.activeSendProof.invalidated = true;
      this.activeSendProof = null;
    }
    if (this.activeTurnProof) {
      this.activeTurnProof.invalidated = true;
      this.activeTurnProof = null;
    }
    if (this.pageNavigationListener && typeof this.page?.off === "function") {
      this.page.off("framenavigated", this.pageNavigationListener);
    }
    this.cdpChrome = null;
    this.context = null;
    this.page = null;
    this.preservedPreferredUrl = null;
    this.pageNavigationListener = null;
    this.preferredTabAmbiguous = false;
    this.conversationObservationArmed = false;
    this.freshSendConfirmed = false;
    this.pendingFreshConversationAliases.clear();
    this.pendingFreshEmptyAliases.clear();
    this.#resetPendingCanonicalVerification({ clearCandidate: true });
    this.expectedRestorationAssistantId = null;
    this.expectedRestorationUserId = null;
    this.expectedAssistantCandidateId = null;
    this.expectedAssistantCandidateTurn = null;
    this.recoveredTurnTopologyRequired = false;
    this.lastObservedPageUrl = null;
    if (clearObservation) {
      this.activeTurnConversationUrl = null;
      this.allowInPlaceAssistantContinuation = false;
      this.inPlaceAssistantGenerationObserved = false;
      this.observedConversationUrl = null;
      this.observedConversationAliases.clear();
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  // Kept overridable so lifecycle tests can supply a deterministic CDP
  // connection without launching a real browser.
  async launchCdpChrome(options) {
    return await launchAndConnectCdpChrome(options);
  }

  hasExactRecoveryTarget(targetId) {
    return Boolean(
      targetId
      && this.cdpChrome?.exactTargetOnly === true
      && this.cdpChrome.targetId === targetId
      && this.context
      && this.page,
    );
  }

  // Attach only the exact already-open Page used by an ambiguous outbound. This
  // recovery path never creates or navigates a target and never launches Chrome.
  async launchRecoveryTarget(targetId) {
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new BrowserAdapterError(
        "Pending outbound recovery requires a saved browser target ID.",
        { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
      );
    }
    if (this.context) {
      if (this.hasExactRecoveryTarget(targetId)) {
        return {
          conversationUrl: this.page.url(),
          targetId,
        };
      }
      if (this.cdpChrome?.targetId !== targetId || !this.page) {
        throw new BrowserAdapterError(
          "A different browser target is already attached; refusing recovery fallback.",
          { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
        );
      }
      if (typeof this.cdpChrome.detach !== "function") {
        throw new BrowserAdapterError(
          "The current browser transport cannot be safely promoted to exact-target recovery.",
          { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
        );
      }
      // A same-process /retry can still own a normal CDP connection. Release its
      // transport and profile lock, then reacquire the saved target through the
      // strict path so close() cannot terminate Chrome or remove recovery state.
      try {
        await this.cdpChrome.detach();
      } catch (error) {
        throw new BrowserAdapterError(
          "The current browser transport could not be detached for exact-target recovery.",
          {
            code: "RECOVERY_TARGET_UNAVAILABLE",
            recoverable: false,
            cause: error,
          },
        );
      }
      this.#dropPageState();
    }

    await ensureDirectory(this.profileDir);
    let connection = null;
    try {
      connection = await this.launchCdpChrome({
        profileDir: this.profileDir,
        preferredTargetId: targetId,
        exactTargetOnly: true,
      });
      if (
        connection?.exactTargetOnly !== true
        || !connection.preferredTargetMatched
        || connection.targetId !== targetId
        || !connection.page
        || !connection.context
      ) {
        throw new BrowserAdapterError(
          "Chrome did not expose the exact saved target for pending outbound recovery.",
          { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
        );
      }
      this.cdpChrome = connection;
      this.context = connection.context;
      this.page = connection.page;
      this.page.setDefaultTimeout(15_000);
      this.page.setDefaultNavigationTimeout(60_000);
      this.preservedPreferredUrl = null;
      this.preferredTabAmbiguous = false;
      return {
        conversationUrl: this.page.url(),
        targetId,
      };
    } catch (error) {
      await connection?.detach?.().catch(() => null);
      this.#dropPageState();
      if (error instanceof BrowserAdapterError) {
        throw error;
      }
      throw new BrowserAdapterError(
        "The exact saved browser target is unavailable for recovery.",
        {
          code: error?.code === "RECOVERY_TARGET_UNAVAILABLE"
            ? error.code
            : "RECOVERY_TARGET_UNAVAILABLE",
          recoverable: false,
          cause: error,
        },
      );
    }
  }

  // `preferredUrl` lets a reused Chrome pick an existing tab that already
  // shows the conversation (instead of opening a new tab per run).
  async launch(preferredUrl = null, { preferredTargetId = null } = {}) {
    if (this.context) {
      // A later turn can still hold the same Page after its provisional URL was
      // replaced. Arm that page's known alias instead of navigating it to root.
      if (preferredUrl && this.#isObservedConversationAlias(preferredUrl)) {
        this.preservedPreferredUrl = preferredUrl;
      }
      return;
    }
    await ensureDirectory(this.profileDir);
    const executablePath = discoverChromeExecutable(this.chromePath);

    const preferredKind = preferredUrl
      ? this.classifyConversationUrl(preferredUrl)
      : "fresh";
    const reusablePreferredUrl = ["restorable", "provisional"]
      .includes(preferredKind)
      ? String(preferredUrl)
      : null;

    this.cdpChrome = await this.launchCdpChrome({
      executablePath,
      profileDir: this.profileDir,
      minimized: this.minimized,
      preferredUrl: reusablePreferredUrl,
      preferredTargetId,
    });
    this.context = this.cdpChrome.context;
    this.page = this.cdpChrome.page;
    this.page.setDefaultTimeout(15_000);
    this.page.setDefaultNavigationTimeout(60_000);

    const preservedPreferredTab = Boolean(
      this.cdpChrome.preferredTargetMatched
      || (
        reusablePreferredUrl
        && this.cdpChrome.preferredTabMatched
      ),
    );
    this.preferredTabAmbiguous = Boolean(
      this.cdpChrome.preferredTabAmbiguous,
    );
    if (
      preferredKind === "provisional"
      && !preservedPreferredTab
      && (this.cdpChrome.existingPageUrls ?? []).some((value) =>
        ["restorable", "provisional"].includes(
          this.classifyConversationUrl(value),
        )
      )
    ) {
      // A legacy session has no target id, and its provisional path may already
      // have canonicalized in one of these tabs. Do not guess which conversation
      // belongs to it, and do not rebuild while a possible original is still open.
      this.preferredTabAmbiguous = true;
    }
    this.preservedPreferredUrl = preservedPreferredTab
      ? String(preferredUrl ?? this.baseUrl)
      : null;
    if (this.preferredTabAmbiguous) {
      throw new BrowserAdapterError(
        `${this.providerName} has multiple possible tabs for this provisional conversation. `
          + "Refusing to choose one or rebuild on a blank page.",
        { code: "CONVERSATION_TAB_AMBIGUOUS", recoverable: false },
      );
    }
    if (preservedPreferredTab) {
      this.#beginConversationObservation(this.preservedPreferredUrl);
    } else {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }


  async close() {
    await this.cdpChrome?.close();
    this.#dropPageState();
  }

  // Leave Chrome open for inspection, but drop the CDP transport and the
  // profile lock so this Node process can exit and the next wtagent can reuse
  // the same window. close() would quit Chrome; disconnect() would keep the
  // lock held by this process.
  async detach() {
    await this.cdpChrome?.detach?.().catch(() => null);
    this.#dropPageState();
  }

  // Re-establishes the CDP connection to a still-alive Chrome after the
  // Playwright transport died mid-run (e.g. the Mac slept). launch() reuses
  // the saved CDP state, so Chrome is neither relaunched nor killed; an
  // existing tab on the preferred conversation is reused when available.
  async reconnect(preferredUrl = null, { preferredTargetId = null } = {}) {
    // launch() acquires a new profile lock. Release this connection's ownership
    // first; if another CLI wins the lock, launch must respect that owner.
    await this.cdpChrome?.detach?.();
    this.#dropPageState({ clearObservation: false });
    await this.launch(preferredUrl, { preferredTargetId });
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
    {
      expectedAssistantMessageId = null,
      expectedUserMessageId = null,
    } = {},
  ) {
    this.requirePage();
    this.expectedRestorationAssistantId = expectedAssistantMessageId;
    this.expectedRestorationUserId = expectedUserMessageId;
    const base = new URL(this.baseUrl);
    const requestedUrl = conversationUrl
      ? normalizedConversationUrl(conversationUrl)
      : null;
    const requestedKind = requestedUrl
      ? this.classifyConversationUrl(requestedUrl)
      : "fresh";
    if (["invalid", "unknown"].includes(requestedKind)) {
      throw new BrowserAdapterError(
        requestedKind === "invalid"
          ? `Refusing to open a conversation outside ${base.origin}.`
          : `Refusing to treat an unknown ${base.hostname} route as a conversation.`,
        {
          code: requestedKind === "invalid"
            ? "INVALID_CONVERSATION_URL"
            : "UNKNOWN_CONVERSATION_URL",
        },
      );
    }
    if (this.preferredTabAmbiguous) {
      throw new BrowserAdapterError(
        `${this.providerName} has multiple possible tabs for this provisional conversation. `
          + "Refusing to choose one or rebuild on a blank page.",
        { code: "CONVERSATION_TAB_AMBIGUOUS", recoverable: false },
      );
    }

    const currentUrl = normalizedConversationUrl(this.page.url());
    const provisionalTabMatched = Boolean(
      requestedUrl
      && requestedKind === "provisional"
      && (
        sameConversationUrl(currentUrl, requestedUrl)
        || sameConversationUrl(this.preservedPreferredUrl, requestedUrl)
        || this.#isObservedConversationAlias(requestedUrl)
      )
    );
    const currentKind = currentUrl
      ? this.classifyConversationUrl(currentUrl)
      : "invalid";
    const freshTargetConversationCandidate = Boolean(
      requestedKind === "fresh"
      && this.cdpChrome?.preferredTargetMatched
      && currentKind === "restorable"
    );
    const resumesExistingConversation = requestedKind === "restorable"
      || provisionalTabMatched
      || freshTargetConversationCandidate;

    // A provisional URL can locate a live tab, but must never be navigated to.
    // A matched page may canonicalize while we observe it; Page continuity alone
    // is insufficient, so a saved user/assistant marker must remain on the new
    // route throughout the restoration stability window.
    const target = requestedKind === "provisional"
      ? (provisionalTabMatched ? currentUrl : normalizedConversationUrl(this.baseUrl))
      : freshTargetConversationCandidate
        ? currentUrl
        : (requestedUrl ?? normalizedConversationUrl(this.baseUrl));

    try {
      if (!sameConversationUrl(this.page.url(), target)) {
        await this.page.goto(String(target), { waitUntil: "domcontentloaded" });
      }
      const composer = await this.#waitForComposer(30_000);
      if (!composer) {
        throw new BrowserAdapterError(
          `${this.providerName} composer was not found after opening a conversation.`,
          { code: "COMPOSER_NOT_FOUND" },
        );
      }

      if (resumesExistingConversation) {
        return await this.#waitForConversationHistory({
          expectedAssistantMessageId,
          expectedUserMessageId,
          expectedUrl: requestedUrl,
          allowCanonicalTransition: requestedKind === "provisional"
            || freshTargetConversationCandidate,
        });
      }

      if (!await this.#isFreshConversation()) {
        await this.#openNewConversation();
        const freshComposer = await this.#waitForComposer(30_000);
        if (!freshComposer) {
          await this.writeDiagnostics("conversation-not-fresh");
          throw new BrowserAdapterError(
            `${this.providerName} did not expose a composer on its new-chat page.`,
            { code: "CONVERSATION_NOT_FRESH" },
          );
        }
      }
      const freshUrl = await this.#waitForStableFreshConversation();
      if (!freshUrl) {
        await this.writeDiagnostics("conversation-not-fresh");
        throw new BrowserAdapterError(
          `${this.providerName} did not open a stable, verified empty conversation. `
            + "Refusing to send a new session prompt into an existing chat.",
          { code: "CONVERSATION_NOT_FRESH" },
        );
      }
      this.expectedRestorationAssistantId = null;
      this.expectedRestorationUserId = null;
      this.lastAssistantMessageId = null;
      this.lastAssistantTurn = null;
      this.lastUserMessageId = null;
      this.activeTurnConversationUrl = null;
      this.#beginConversationObservation(freshUrl, { arm: false, reset: true });
      return {
        status: "verified-fresh",
        conversationUrl: freshUrl,
        ...(this.cdpChrome?.targetId
          ? { targetId: this.cdpChrome.targetId }
          : {}),
      };
    } finally {
      // A CDP selection proves only this single restoration attempt. Long-lived
      // page aliases continue to be tracked separately by navigation events.
      this.preservedPreferredUrl = null;
    }
  }

  async getConversationUrl() {
    this.requirePage();
    return this.page.url();
  }

  async getLastUserMessageId() {
    return this.lastUserMessageId;
  }

  async getLastAssistantMessageId() {
    return this.lastAssistantMessageId;
  }

  async getLastAssistantTurn() {
    return this.lastAssistantTurn;
  }

  getLastSendStatus() {
    return this.lastSendStatus;
  }

  async sendMessage(text, {
    files = [],
    maxBytes = null,
    outboundId = null,
    allowAssistantContinuation = false,
  } = {}) {
    this.requirePage();
    this.lastSendStatus = "not-submitted";
    this.expectedAssistantCandidateId = null;
    this.expectedAssistantCandidateTurn = null;
    this.recoveredTurnTopologyRequired = false;
    this.allowInPlaceAssistantContinuation = Boolean(
      allowAssistantContinuation,
    );
    this.inPlaceAssistantGenerationObserved = false;
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
    if (
      outboundId != null
      && (
        !isValidOutboundCorrelationId(outboundId)
        || !renderedMessageContainsOutboundMarker(text, outboundId)
      )
    ) {
      throw new BrowserAdapterError(
        "The outbound transport correlation marker is malformed. Nothing was sent.",
        { code: "INVALID_OUTBOUND_CORRELATION_ID", recoverable: false },
      );
    }

    let sendProof = null;
    try {
    const sendIdentity = await this.getConversationIdentity();
    const urlBeforeSend = sendIdentity.conversationUrl;
    const sendStartedFresh = sendIdentity.kind === "fresh";
    await this.#assertTrustedPageForSend(urlBeforeSend);
    const composer = await this.#waitForComposer(30_000);
    if (!composer) {
      throw new BrowserAdapterError(
        `${this.providerName} composer is unavailable.`,
        { code: "COMPOSER_NOT_FOUND" },
      );
    }

    await this.dismissTransientOverlays();
    await this.#waitUntilReadyToSend();

    if (await firstVisible(this.pendingAttachmentLocators())) {
      throw new BrowserAdapterError(
        `${this.providerName} composer contains attachments from an earlier draft. `
          + "Remove them in the browser before resuming.",
        { code: "STALE_COMPOSER_ATTACHMENTS", recoverable: false },
      );
    }

    await this.#assertTrustedPageForSend(urlBeforeSend);
    this.sendEpoch += 1;
    sendProof = {
      sendEpoch: this.sendEpoch,
      outboundId,
      page: this.page,
      mainFrame: typeof this.page?.mainFrame === "function"
        ? this.page.mainFrame()
        : null,
      targetId: this.cdpChrome?.targetId ?? null,
      sourceUrl: normalizedConversationUrl(urlBeforeSend),
      currentUrl: normalizedConversationUrl(urlBeforeSend),
      startedNavigationEpoch: this.navigationEpoch,
      candidateUrl: null,
      candidateNavigationEpoch: null,
      candidateBeforeSubmission: false,
      submissionStarted: false,
      submittedAt: null,
      deadline: null,
      orderedBaseline: null,
      freshCandidateUserId: null,
      freshCandidateUserTurn: null,
      invalidated: false,
    };
    this.activeSendProof = sendProof;
    this.#beginConversationObservation(urlBeforeSend, {
      arm: sendStartedFresh,
    });

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
    this.expectedRestorationAssistantId ??= [...assistantBaseline.ids].at(-1) ?? null;
    this.expectedRestorationUserId ??= [...userBaseline.ids].at(-1) ?? null;
    const hasPreTransitionMarker = Boolean(
      this.expectedRestorationAssistantId
      || this.expectedRestorationUserId,
    );
    // Count baseline for providers whose DOM exposes no stable per-message id
    // or turn ordinal (they override isNewAssistantIdentity to use it).
    this.assistantCountBeforeSend = assistantBaseline.count;
    this.lastAssistantTextBeforeSend = assistantBaseline.count > 0
      ? await this.assistantText(assistantMessages.last()).catch(() => "")
      : "";
    this.sentUserTurn = null;

    await this.#assertTrustedPageForSend(urlBeforeSend, {
      allowPendingFreshTransition: sendStartedFresh,
    });
    if (
      sendStartedFresh
      && (assistantBaseline.count !== 0 || userBaseline.count !== 0)
    ) {
      await this.writeDiagnostics("conversation-changed-before-send");
      throw new BrowserAdapterError(
        `${this.providerName} exposed conversation history before submission. Nothing was sent.`,
        { code: "CONVERSATION_CHANGED_BEFORE_SEND", recoverable: false },
      );
    }
    await this.fillComposer(composer, text);
    await this.#assertTrustedPageForSend(urlBeforeSend, {
      allowPendingFreshTransition: sendStartedFresh,
    });

    if (
      sendStartedFresh
      && this.requiresOrderedConversationSnapshotForFreshSend()
    ) {
      const orderedBaseline = this.#validatedOrderedConversationSnapshot(
        await this.orderedConversationSnapshot().catch(() => null),
      );
      if (
        !orderedBaseline
        || orderedBaseline.entries.length !== 0
        || !sameConversationUrl(orderedBaseline.url, this.page.url())
        || !this.#activeSendProofIsIntact()
      ) {
        await this.writeDiagnostics("conversation-changed-before-send");
        throw new BrowserAdapterError(
          `${this.providerName} could not verify an empty ordered conversation before submission. `
            + "Nothing was sent.",
          { code: "CONVERSATION_CHANGED_BEFORE_SEND", recoverable: false },
        );
      }
      sendProof.orderedBaseline = {
        url: orderedBaseline.url,
        entries: [],
      };
    }

    // From this point onward a transport failure cannot prove whether the
    // provider committed the message. Runtime must never resend it blindly. One
    // monotonic deadline includes the submission itself and every proof sample.
    sendProof.submissionStarted = true;
    sendProof.submittedAt = this.monotonicNow();
    sendProof.deadline = sendProof.submittedAt
      + this.sendConfirmationTimeoutMs();
    this.lastSendStatus = "commit-unknown";
    await this.#awaitWithinSendDeadline(
      this.submitComposer(composer),
      sendProof.deadline,
    );

    const sentMessage = await this.#waitForSentUserMessage(userBaseline, {
      deadline: sendProof.deadline,
      expectedText: text,
      outboundId,
      allowPendingFreshTransition: sendStartedFresh,
      hasPreTransitionMarker,
    });
    if (!sentMessage) {
      // Submission already happened. A missing bubble is ambiguous: retrying can
      // duplicate a committed message whose DOM confirmation was delayed/lost.
      await this.writeDiagnostics("send-not-detected");
      throw new BrowserAdapterError(
        `${this.providerName} did not confirm whether the sent message committed. `
          + "It was not sent again automatically.",
        { code: "SEND_COMMIT_UNKNOWN", recoverable: false },
      );
    }
    this.lastUserMessageId = sentMessage.id ?? null;
    if (sendStartedFresh) {
      this.#confirmFreshConversationSend();
    } else {
      this.#observeConversationNavigation(this.page.url());
    }

    let submittedPage = await this.#awaitWithinSendDeadline(
      this.#submittedPageState(),
      sendProof.deadline,
    );
    if (submittedPage.status === "candidate") {
      const verifiedUrl = await this.#waitForCanonicalCandidate(
        submittedPage.conversationUrl,
        { deadline: sendProof.deadline },
      );
      submittedPage = verifiedUrl
        ? { status: "trusted", conversationUrl: verifiedUrl }
        : { status: "untrusted", conversationUrl: this.page.url() };
    }
    if (submittedPage.status !== "trusted") {
      await this.writeDiagnostics("conversation-changed-after-submit");
      throw new BrowserAdapterError(
        `${this.providerName} changed conversations after submission, so the sent `
          + "message could not be bound to the verified page. It was not sent again.",
        { code: "SEND_COMMIT_UNKNOWN", recoverable: false },
      );
    }

    if (this.lastUserMessageId) {
      this.expectedRestorationUserId = this.lastUserMessageId;
    }
    this.#captureActiveTurnProof(submittedPage.conversationUrl);
    this.lastSendStatus = "confirmed";
    return {
      attachment,
      userMessageId: this.lastUserMessageId,
      userTurn: sentMessage.turn ?? null,
      conversationUrl: submittedPage.conversationUrl,
      conversationTargetId: this.cdpChrome?.targetId ?? null,
      assistantBaseline: {
        ids: [...assistantBaseline.ids],
        count: assistantBaseline.count,
        maxTurn: assistantBaseline.maxTurn,
        lastText: this.lastAssistantTextBeforeSend,
      },
      preOutboundMarkerIds: [
        ...userBaseline.ids,
        ...assistantBaseline.ids,
      ],
    };
    } finally {
      if (sendProof && this.activeSendProof === sendProof) {
        sendProof.invalidated = true;
        this.activeSendProof = null;
      }
      if (this.lastSendStatus !== "confirmed") {
        this.allowInPlaceAssistantContinuation = false;
        this.inPlaceAssistantGenerationObserved = false;
        this.#resetPendingCanonicalVerification({ clearCandidate: true });
      }
    }
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
    let unverifiedPageChecks = 0;
    const detachEscCancel = this.#attachEscCancel();
    const truncatedGraceMs = truncatedEnvelopeWindowMs
      ?? this.truncatedEnvelopeGraceMs();
    try {
      while (Date.now() < deadline) {
        if (this.activeTurnConversationUrl) {
          // A main-frame navigation may nominate a provisional-to-canonical
          // transition before its saved message marker has remained stable.
          // Preserve the exact page/frame/target binding while the page-state
          // verifier below waits; no reply is read until that URL is trusted.
          if (!this.#activeTurnProofIsIntact({ allowPendingCanonicalUrl: true })) {
            await this.writeDiagnostics("conversation-changed-during-turn");
            throw new BrowserAdapterError(
              `${this.providerName} browser target changed while waiting for its reply. `
                + "No content from the substitute page was accepted.",
              {
                code: "CONVERSATION_CHANGED_DURING_TURN",
                recoverable: false,
              },
            );
          }
          const pageState = await this.#submittedPageState();
          if (pageState.status === "candidate") {
            unverifiedPageChecks += 1;
            if (unverifiedPageChecks >= 60) {
              await this.writeDiagnostics("conversation-changed-during-turn");
              throw new BrowserAdapterError(
                `${this.providerName} could not correlate the conversation URL `
                  + "that appeared while waiting for the reply.",
                {
                  code: "CONVERSATION_CHANGED_DURING_TURN",
                  recoverable: false,
                },
              );
            }
            await this.page.waitForTimeout(250);
            continue;
          }
          if (pageState.status !== "trusted") {
            await this.writeDiagnostics("conversation-changed-during-turn");
            throw new BrowserAdapterError(
              `${this.providerName} left the verified conversation while waiting `
                + "for its reply. No content from the other page was accepted.",
              {
                code: "CONVERSATION_CHANGED_DURING_TURN",
                recoverable: false,
              },
            );
          }
          unverifiedPageChecks = 0;
          this.activeTurnConversationUrl = pageState.conversationUrl;
          if (this.activeTurnProof) {
            this.activeTurnProof.conversationUrl = pageState.conversationUrl;
          }
        }

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
        const { id: candidateId, turn: candidateTurn } = lastMessage
          ? await this.messageIdentity(lastMessage)
          : { id: null, turn: null };
        await this.#validateRecoveredTurnBoundary();
        if (
          (this.expectedAssistantCandidateId != null
            || this.expectedAssistantCandidateTurn != null)
          && (
            !lastMessage
            || (
              this.expectedAssistantCandidateId != null
              && candidateId !== this.expectedAssistantCandidateId
            )
            || (
              this.expectedAssistantCandidateTurn != null
              && candidateTurn !== this.expectedAssistantCandidateTurn
            )
          )
        ) {
          await this.writeDiagnostics("recovered-assistant-boundary-changed");
          throw new BrowserAdapterError(
            `${this.providerName} assistant boundary changed after recovery. `
              + "No content from the replacement reply was accepted.",
            { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
          );
        }
        const candidateText = lastMessage
          ? await this.assistantText(lastMessage)
          : "";
        const stopVisible = await this.#isStopButtonVisible();
        const assistantGenerating = lastMessage
          ? await this.isAssistantGenerating(lastMessage)
          : false;
        const generating = stopVisible || assistantGenerating;
        if (generating && this.allowInPlaceAssistantContinuation) {
          this.inPlaceAssistantGenerationObserved = true;
        }
        const hasNewAssistant = this.isNewAssistantIdentity({
          id: candidateId,
          turn: candidateTurn,
          text: candidateText,
          generating,
        });
        if (hasNewAssistant) {
          await this.#validateRecoveredTurnBoundary({
            assistantPresent: true,
            assistantMessageId: candidateId,
            assistantTurn: candidateTurn,
          });
        }
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
              await this.#validateRecoveredTurnBoundary({
                assistantPresent: true,
                assistantMessageId: candidateId,
                assistantTurn: candidateTurn,
              });
              this.lastAssistantMessageId = candidateId;
              this.lastAssistantTurn = candidateTurn;
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
            const limitMarker = await this.findUsageLimitMarker(lastMessage);
            const generationError = await this.findGenerationErrorMarker(lastMessage);
            await this.#validateRecoveredTurnBoundary({
              assistantPresent: true,
              assistantMessageId: candidateId,
              assistantTurn: candidateTurn,
            });
            this.lastAssistantMessageId = candidateId;
            this.lastAssistantTurn = candidateTurn;
            if (limitMarker) {
              throw new BrowserAdapterError(
                `${this.providerName} reported a usage limit (${limitMarker}).`,
                { code: "USAGE_LIMIT_REACHED" },
              );
            }
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
            await this.#validateRecoveredTurnBoundary({
              assistantPresent: true,
              assistantMessageId: candidateId,
              assistantTurn: candidateTurn,
            });
            this.lastAssistantMessageId = candidateId;
            this.lastAssistantTurn = candidateTurn;
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
          await this.#validateRecoveredTurnBoundary({
            assistantPresent: hasNewAssistant,
            assistantMessageId: candidateId,
            assistantTurn: candidateTurn,
          });
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
      this.allowInPlaceAssistantContinuation = false;
      this.inPlaceAssistantGenerationObserved = false;
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
    return this.classifyConversationUrl(this.page.url()) === "fresh"
      && await this.conversationMessages().count().catch(() => -1) === 0;
  }

  async #waitForStableFreshConversation({ attempts = 60 } = {}) {
    let previousSignature = null;
    let stableChecks = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.#throwIfCancelRequested();
      const currentUrl = normalizedConversationUrl(this.page.url());
      const kind = currentUrl
        ? this.classifyConversationUrl(currentUrl)
        : "invalid";
      const totalMessages = await this.conversationMessages()
        .count()
        .catch(() => -1);
      const signature = `${currentUrl ?? ""}:${kind}:${totalMessages}`;
      if (kind !== "fresh" || totalMessages !== 0) {
        return null;
      }
      stableChecks = signature === previousSignature ? stableChecks + 1 : 1;
      previousSignature = signature;
      if (stableChecks >= RESTORATION_STABLE_CHECKS) {
        return currentUrl;
      }
      await this.page.waitForTimeout(250);
    }
    return null;
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

  #validatedOrderedConversationSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.entries)) {
      return null;
    }
    const url = normalizedConversationUrl(snapshot.url);
    if (!url) {
      return null;
    }

    const ids = new Set();
    const turns = new Set();
    const entries = [];
    let previousDomIndex = -1;
    let previousTurn = -1;
    for (const entry of snapshot.entries) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const turn = entry?.turn;
      const domIndex = entry?.domIndex;
      if (
        !["user", "assistant"].includes(entry?.role)
        || !id
        || !Number.isSafeInteger(turn)
        || turn < 0
        || !Number.isSafeInteger(domIndex)
        || domIndex <= previousDomIndex
        || turn <= previousTurn
        || ids.has(id)
        || turns.has(turn)
      ) {
        return null;
      }
      ids.add(id);
      turns.add(turn);
      previousDomIndex = domIndex;
      previousTurn = turn;
      entries.push({
        domIndex,
        role: entry.role,
        id,
        turn,
        renderedText: String(entry.renderedText ?? ""),
      });
    }
    return { url, entries };
  }

  #freshUserFromOrderedSnapshot(snapshot, {
    baseline,
    pageState,
    expectedText,
    outboundId,
  }) {
    const proof = this.activeSendProof;
    if (!proof || !this.#activeSendProofIsIntact()) {
      return null;
    }
    if (!sameConversationUrl(pageState.conversationUrl, proof.currentUrl)) {
      // A permitted main-frame transition can complete while the asynchronous
      // DOM snapshot is being read. Its navigation event has already advanced
      // the intact send proof, so this page-state/snapshot pair is stale, not
      // evidence of a substituted conversation. Discard the sample and verify
      // the same outbound/user again on the new route for a full stable window.
      return null;
    }
    const ordered = this.#validatedOrderedConversationSnapshot(snapshot);
    if (!ordered) {
      // A real assistant row can be inserted over more than one render frame.
      // An incomplete atomic sample neither proves nor disproves the user bubble;
      // a later valid sample must still pass the full structural checks.
      return null;
    }
    if (
      !sameConversationUrl(ordered.url, pageState.conversationUrl)
      || baseline.count !== 0
    ) {
      proof.invalidated = true;
      return null;
    }
    if (ordered.entries.length === 0) {
      if (proof.freshCandidateUserId != null) {
        proof.invalidated = true;
      }
      return null;
    }

    const users = ordered.entries.filter((entry) => entry.role === "user");
    const matchingUsers = users.filter((entry) => (
      renderedMessageContains(entry.renderedText, expectedText, outboundId)
    ));
    const validFreshTopology = users.length === 1
      && ordered.entries[0] === users[0];
    if (!validFreshTopology || matchingUsers.length > 1) {
      proof.invalidated = true;
      return null;
    }
    if (matchingUsers.length === 0) {
      // The committed bubble may mount before its rendered text. Once its marker
      // has been observed, however, losing it is an identity change, not loading.
      if (proof.freshCandidateUserId != null) {
        proof.invalidated = true;
      }
      return null;
    }

    const user = matchingUsers[0];
    const newByTurn = baseline.maxTurn == null || user.turn > baseline.maxTurn;
    const newById = !baseline.ids.has(user.id);
    if (!newByTurn || !newById) {
      proof.invalidated = true;
      return null;
    }
    if (
      (proof.freshCandidateUserId != null
        && proof.freshCandidateUserId !== user.id)
      || (proof.freshCandidateUserTurn != null
        && proof.freshCandidateUserTurn !== user.turn)
      || (
        !sameConversationUrl(pageState.conversationUrl, proof.sourceUrl)
        && !sameConversationUrl(pageState.conversationUrl, proof.candidateUrl)
      )
    ) {
      proof.invalidated = true;
      return null;
    }
    proof.freshCandidateUserId = user.id;
    proof.freshCandidateUserTurn = user.turn;

    const correlationIdentity = outboundId == null
      ? comparableMessageText(expectedText)
      : `${OUTBOUND_MARKER_PREFIX}${outboundId}.`;
    return {
      id: user.id,
      turn: user.turn,
      signature: [
        proof.sendEpoch,
        proof.candidateNavigationEpoch ?? proof.startedNavigationEpoch,
        pageState.conversationUrl,
        proof.targetId ?? "",
        user.id,
        user.turn,
        correlationIdentity,
      ].join(":"),
    };
  }

  async #waitBeforeSendDeadline(deadline, ms = 100) {
    const remaining = deadline - this.monotonicNow();
    if (remaining <= 0) {
      return false;
    }
    await this.#awaitWithinSendDeadline(
      this.waitForPoll(Math.min(ms, remaining)),
      deadline,
    );
    return true;
  }

  async #throwCommitUnknownForPageChange() {
    await this.writeDiagnostics("conversation-changed-after-submit");
    throw new BrowserAdapterError(
      `${this.providerName} changed conversations after submission, so commit `
        + "could not be verified. The message was not sent again.",
      { code: "SEND_COMMIT_UNKNOWN", recoverable: false },
    );
  }

  async #waitForSentUserMessage(baseline, {
    deadline = this.monotonicNow() + this.sendConfirmationTimeoutMs(),
    expectedText = "",
    outboundId = null,
    allowPendingFreshTransition = false,
    hasPreTransitionMarker = false,
  } = {}) {
    let candidateBubbleSignature = null;
    let candidateBubbleStableSince = 0;
    const requireFreshCorrelation = allowPendingFreshTransition;
    const requireOrderedSnapshot = requireFreshCorrelation
      && this.requiresOrderedConversationSnapshotForFreshSend();
    const withinDeadline = (promise) => this.#awaitWithinSendDeadline(
      promise,
      deadline,
    );

    while (this.monotonicNow() < deadline) {
      this.#throwIfCancelRequested();
      const pageState = await withinDeadline(this.#submittedPageState({
        allowPendingFreshTransition,
      }));
      if (pageState.status === "untrusted") {
        await this.#throwCommitUnknownForPageChange();
      }
      if (pageState.status === "candidate" && hasPreTransitionMarker) {
        // Existing conversations must first carry a stable pre-navigation marker.
        // Never bootstrap candidate trust from a message found on the candidate.
        candidateBubbleSignature = null;
        candidateBubbleStableSince = 0;
        await this.#waitBeforeSendDeadline(deadline);
        continue;
      }

      const proofNavigated = this.activeSendProof?.candidateNavigationEpoch != null;
      const requireCorrelation = outboundId != null
        || requireFreshCorrelation
        || proofNavigated;
      let candidate = null;
      let orderedSnapshot = null;
      if (requireOrderedSnapshot) {
        orderedSnapshot = await withinDeadline(
          this.orderedConversationSnapshot().catch(() => null),
        );
        candidate = this.#freshUserFromOrderedSnapshot(orderedSnapshot, {
          baseline,
          pageState,
          expectedText,
          outboundId,
        });
      } else {
        const messages = this.userMessages();
        const count = await withinDeadline(messages.count().catch(() => 0));
        for (let index = count - 1; index >= 0; index -= 1) {
          const message = messages.nth(index);
          const identity = await withinDeadline(
            this.messageIdentity(message),
          );
          const newByTurn = identity.turn != null
            && (baseline.maxTurn == null || identity.turn > baseline.maxTurn);
          const newById = Boolean(
            identity.id && !baseline.ids.has(identity.id),
          );
          if (!newByTurn && !newById) {
            continue;
          }

          if (requireCorrelation) {
            // A context-dependent send that crossed a route boundary needs the
            // transport nonce; equal human text is not a conversation identity.
            if (!requireFreshCorrelation && outboundId == null) {
              continue;
            }
            const renderedText = await withinDeadline(
              this.userMessageText(message),
            );
            if (
              index !== count - 1
              || !renderedMessageContains(renderedText, expectedText, outboundId)
            ) {
              continue;
            }
            if (requireFreshCorrelation) {
              const totalMessages = await withinDeadline(
                this.conversationMessages().count().catch(() => -1),
              );
              if (
                baseline.count !== 0
                || count !== 1
                || totalMessages < 1
                || totalMessages > 2
              ) {
                continue;
              }
            }
          }
          const proof = this.activeSendProof;
          candidate = {
            ...identity,
            signature: requireCorrelation
              ? [
                proof?.sendEpoch ?? "",
                proof?.candidateNavigationEpoch ?? proof?.startedNavigationEpoch ?? "",
                pageState.conversationUrl,
                proof?.targetId ?? "",
                identity.id ?? "",
                identity.turn ?? "",
                outboundId == null
                  ? comparableMessageText(expectedText)
                  : `${OUTBOUND_MARKER_PREFIX}${outboundId}.`,
              ].join(":")
              : null,
          };
          break;
        }
      }

      if (!candidate) {
        if (
          !requireOrderedSnapshot
          || candidateBubbleSignature == null
          || this.activeSendProof?.invalidated
        ) {
          candidateBubbleSignature = null;
          candidateBubbleStableSince = 0;
        }
        await this.#waitBeforeSendDeadline(deadline);
        continue;
      }

      if (requireCorrelation) {
        const observedAt = this.monotonicNow();
        if (candidate.signature !== candidateBubbleSignature) {
          candidateBubbleSignature = candidate.signature;
          candidateBubbleStableSince = observedAt;
          if (this.restorationCorrelationWindowMs() > 0) {
            await this.#waitBeforeSendDeadline(deadline);
            continue;
          }
        }
        if (
          observedAt - candidateBubbleStableSince
          < this.restorationCorrelationWindowMs()
        ) {
          await this.#waitBeforeSendDeadline(deadline);
          continue;
        }

        if (requireOrderedSnapshot) {
          const finalSnapshot = await withinDeadline(
            this.orderedConversationSnapshot().catch(() => null),
          );
          const finalCandidate = this.#freshUserFromOrderedSnapshot(finalSnapshot, {
            baseline,
            pageState,
            expectedText,
            outboundId,
          });
          if (!finalCandidate || finalCandidate.signature !== candidate.signature) {
            if (this.activeSendProof?.invalidated) {
              candidateBubbleSignature = null;
              candidateBubbleStableSince = 0;
            }
            await this.#waitBeforeSendDeadline(deadline);
            continue;
          }
        }
      }

      const confirmedPage = await withinDeadline(this.#submittedPageState({
        allowPendingFreshTransition,
      }));
      if (confirmedPage.status === "untrusted") {
        await this.#throwCommitUnknownForPageChange();
      }
      if (
        !sameConversationUrl(
          confirmedPage.conversationUrl,
          pageState.conversationUrl,
        )
        || (
          pageState.status === "trusted"
          && confirmedPage.status !== "trusted"
        )
      ) {
        // The DOM may have been read across a SPA navigation. Retry against one
        // stable URL rather than binding that mixed snapshot to this send.
        candidateBubbleSignature = null;
        candidateBubbleStableSince = 0;
        await this.#waitBeforeSendDeadline(deadline);
        continue;
      }
      this.sentUserTurn = candidate.turn;
      return {
        id: candidate.id ?? null,
        turn: candidate.turn ?? null,
        conversationUrl: confirmedPage.conversationUrl,
      };
    }
    return null;
  }

  async #waitForConversationHistory({
    expectedAssistantMessageId = null,
    expectedUserMessageId = null,
    expectedUrl = null,
    allowCanonicalTransition = false,
    attempts = 60,
  } = {}) {
    let previousSignature = null;
    let stableChecks = 0;
    let scrolledToBottom = 0;
    const normalizedExpected = normalizedConversationUrl(expectedUrl);

    if (
      allowCanonicalTransition
      && sameConversationUrl(this.page.url(), normalizedExpected)
    ) {
      this.#beginConversationObservation(normalizedExpected);
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.#throwIfCancelRequested();
      const currentUrl = normalizedConversationUrl(this.page.url());
      const currentKind = currentUrl
        ? this.classifyConversationUrl(currentUrl)
        : "invalid";
      const [assistant, user] = await Promise.all([
        this.#captureMessageIdentities(this.assistantMessages()),
        this.#captureMessageIdentities(this.userMessages()),
      ]);
      const totalMessages = await this.conversationMessages()
        .count()
        .catch(() => -1);
      const assistantMarkerFound = Boolean(
        expectedAssistantMessageId
        && assistant.ids.has(expectedAssistantMessageId)
      );
      const userMarkerFound = Boolean(
        expectedUserMessageId
        && user.ids.has(expectedUserMessageId)
      );
      const markerFound = assistantMarkerFound || userMarkerFound;

      // Page/target continuity does not prove conversation continuity: a user can
      // navigate that tab. A provisional route's canonical candidate therefore
      // needs a persisted message id on every sample in the stability window. A
      // single stale React snapshot must never latch an unrelated canonical URL.
      const markerCorrelatedTransition = Boolean(
        allowCanonicalTransition
        && currentKind === "restorable"
        && markerFound
      );
      const expectedConversation = Boolean(
        normalizedExpected
        && (
          sameConversationUrl(currentUrl, normalizedExpected)
          || markerCorrelatedTransition
        )
      );

      // The expected assistant marker is near the virtualized tail. Scroll a few
      // times before falling back to stable URL + non-empty history.
      if (
        expectedAssistantMessageId
        && !assistantMarkerFound
        && scrolledToBottom < 3
      ) {
        await this.scrollConversationToBottom();
        scrolledToBottom += 1;
      }

      const signature = [
        currentUrl ?? "",
        currentKind,
        expectedConversation,
        totalMessages,
        assistant.count,
        assistant.maxTurn ?? "",
        [...assistant.ids].join(","),
        user.count,
        user.maxTurn ?? "",
        [...user.ids].join(","),
      ].join(":");
      stableChecks = signature === previousSignature ? stableChecks + 1 : 1;
      previousSignature = signature;

      if (stableChecks >= RESTORATION_STABLE_CHECKS) {
        if (expectedConversation && totalMessages > 0) {
          const rebindActiveTurn = this.activeTurnConversationUrl != null;
          this.#beginConversationObservation(currentUrl, {
            arm: false,
            reset: true,
          });
          if (rebindActiveTurn) {
            this.#captureActiveTurnProof(currentUrl);
          }
          this.#publishConversationIdentity();
          return {
            status: "restored-existing",
            conversationUrl: currentUrl,
            ...(this.cdpChrome?.targetId
              ? { targetId: this.cdpChrome.targetId }
              : {}),
          };
        }
        if (currentKind === "fresh" && totalMessages === 0) {
          // A durable/provisional route may have expired and redirected to the
          // provider's explicit empty new-chat route. The prolonged stable check
          // prevents an early composer mount from masquerading as lost history.
          this.expectedRestorationAssistantId = null;
          this.expectedRestorationUserId = null;
          this.lastAssistantMessageId = null;
          this.lastUserMessageId = null;
          this.activeTurnConversationUrl = null;
          this.#beginConversationObservation(currentUrl, {
            arm: false,
            reset: true,
          });
          return {
            status: "verified-fresh",
            conversationUrl: currentUrl,
            ...(this.cdpChrome?.targetId
              ? { targetId: this.cdpChrome.targetId }
              : {}),
          };
        }
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
  // Raw mode swallows Ctrl+C, so dispatch the CLI's SIGINT event internally.
  // process.kill(self, "SIGINT") would terminate Windows without cleanup.
  // The returned detach restores the
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
        process.emit("SIGINT", "SIGINT");
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

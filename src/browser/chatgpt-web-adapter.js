import { createHash } from "node:crypto";
import {
  BaseWebAdapter,
  firstVisible,
  hasCompleteAgentEnvelope,
  isValidOutboundCorrelationId,
  renderedMessageContainsOutboundMarker,
} from "./base-web-adapter.js";
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

function normalizedConversationUrl(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

function validatedOrderedSnapshot(snapshot) {
  const url = normalizedConversationUrl(snapshot?.url);
  if (!url || !Array.isArray(snapshot?.entries)) {
    return null;
  }
  const ids = new Set();
  const turns = new Set();
  const entries = [];
  let previousDomIndex = -1;
  let previousTurn = -1;
  for (const entry of snapshot.entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (
      !["user", "assistant"].includes(entry?.role)
      || !id
      || !Number.isSafeInteger(entry.turn)
      || entry.turn < 0
      || !Number.isSafeInteger(entry.domIndex)
      || entry.domIndex <= previousDomIndex
      || entry.turn <= previousTurn
      || ids.has(id)
      || turns.has(entry.turn)
    ) {
      return null;
    }
    ids.add(id);
    turns.add(entry.turn);
    previousDomIndex = entry.domIndex;
    previousTurn = entry.turn;
    entries.push({
      domIndex: entry.domIndex,
      role: entry.role,
      id,
      turn: entry.turn,
      renderedText: String(entry.renderedText ?? ""),
    });
  }
  return { url, entries };
}

function sameIdentity(entry, { id, turn }) {
  return entry?.id === id && entry?.turn === turn;
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

  classifyConversationUrl(value) {
    const kind = super.classifyConversationUrl(value);
    if (kind !== "restorable") {
      return kind;
    }
    const parsed = value instanceof URL ? value : new URL(value);
    return /^\/c\/WEB:/.test(parsed.pathname)
      ? "provisional"
      : "restorable";
  }

  pendingAttachmentLocators() {
    return [
      this.page.locator(
        'form [data-testid$="-file-thumbnail"], '
          + 'form [data-testid^="file-thumbnail"], '
          + 'form button[aria-label*="remove file" i], '
          + 'form button[aria-label*="删除文件"]',
      ),
    ];
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

  requiresOrderedConversationSnapshotForFreshSend() {
    return true;
  }

  async orderedConversationSnapshot() {
    if (typeof this.page?.evaluate !== "function") {
      return null;
    }
    return await this.page.evaluate(() => {
      const entries = [
        ...document.querySelectorAll(
          '[data-message-author-role="user"], [data-message-author-role="assistant"]',
        ),
      ].filter((element) => {
        const role = element.getAttribute("data-message-author-role");
        return role === "user"
          || (role === "assistant" && !element.id.startsWith("request-placeholder-"));
      }).map((element, domIndex) => {
        const role = element.getAttribute("data-message-author-role");
        const wrapper = element.closest('[data-testid^="conversation-turn-"]');
        const turnMatch = wrapper?.getAttribute("data-testid")
          ?.match(/^conversation-turn-(\d+)$/);
        let renderedText = element.innerText ?? element.textContent ?? "";
        if (role === "assistant" && !renderedText.includes("<agent_response")) {
          const codeTexts = [...element.querySelectorAll("pre code")]
            .map((code) => code.innerText ?? code.textContent ?? "");
          const completeEnvelope = codeTexts.find((text) => {
            const start = text.trim().indexOf("<agent_response");
            const end = text.trim().lastIndexOf("</agent_response>");
            return start >= 0 && end >= start;
          });
          const partialEnvelope = codeTexts.find(
            (text) => text.includes("<agent_response"),
          );
          if (completeEnvelope) {
            renderedText = completeEnvelope;
          } else if (partialEnvelope) {
            renderedText = partialEnvelope;
          } else {
            const markdown = [...element.querySelectorAll(".markdown")];
            if (markdown.length > 0) {
              const last = markdown.at(-1);
              renderedText = last.innerText ?? last.textContent ?? "";
            }
          }
        }
        return {
          domIndex,
          role,
          id: element.getAttribute("data-message-id"),
          turn: turnMatch ? Number.parseInt(turnMatch[1], 10) : null,
          renderedText,
        };
      });
      return { url: window.location.href, entries };
    }).catch(() => null);
  }

  async assertRecoveredTurnTopology({
    assistantPresent = false,
    assistantMessageId = null,
    assistantTurn = null,
  } = {}) {
    if (!this.recoveredTurnTopologyRequired) {
      return;
    }
    const snapshot = validatedOrderedSnapshot(
      await this.orderedConversationSnapshot(),
    );
    const currentUrl = normalizedConversationUrl(this.page?.url?.());
    if (!snapshot || !currentUrl || snapshot.url !== currentUrl) {
      throw this.#pendingOutboundUncertain(
        "ChatGPT could not atomically revalidate the recovered conversation boundary.",
      );
    }
    if (
      typeof this.lastUserMessageId !== "string"
      || !this.lastUserMessageId
      || !Number.isSafeInteger(this.sentUserTurn)
    ) {
      throw this.#pendingOutboundUncertain(
        "The recovered ChatGPT user-turn identity is incomplete.",
      );
    }

    const matchingUsers = snapshot.entries.filter((entry) => (
      entry.role === "user"
      && sameIdentity(entry, {
        id: this.lastUserMessageId,
        turn: this.sentUserTurn,
      })
    ));
    if (matchingUsers.length !== 1) {
      throw this.#pendingOutboundUncertain(
        "The correlated ChatGPT user turn disappeared or changed after recovery.",
      );
    }
    const user = matchingUsers[0];
    const suffix = snapshot.entries.slice(snapshot.entries.indexOf(user) + 1);
    if (suffix.some((entry) => entry.role === "user")) {
      throw this.#pendingOutboundUncertain(
        "A later ChatGPT user turn invalidated the recovered assistant boundary.",
      );
    }
    if (suffix.length > 1 || suffix.some((entry) => entry.role !== "assistant")) {
      throw this.#pendingOutboundUncertain(
        "ChatGPT assistant chronology changed after recovery.",
      );
    }

    const assistant = suffix[0] ?? null;
    if (assistant && assistant.turn !== user.turn + 1) {
      throw this.#pendingOutboundUncertain(
        "The recovered ChatGPT assistant successor is no longer adjacent.",
      );
    }
    if (
      (this.expectedAssistantCandidateId != null
        || this.expectedAssistantCandidateTurn != null)
      && (
        !assistant
        || (
          this.expectedAssistantCandidateId != null
          && assistant.id !== this.expectedAssistantCandidateId
        )
        || (
          this.expectedAssistantCandidateTurn != null
          && assistant.turn !== this.expectedAssistantCandidateTurn
        )
      )
    ) {
      throw this.#pendingOutboundUncertain(
        "The persisted ChatGPT assistant successor changed after recovery.",
      );
    }
    if (
      assistantPresent
      && (
        !assistant
        || assistant.id !== assistantMessageId
        || assistant.turn !== assistantTurn
      )
    ) {
      throw this.#pendingOutboundUncertain(
        "The ChatGPT assistant node being processed is outside the recovered boundary.",
      );
    }
  }

  supportsPendingOutboundRecovery() {
    return true;
  }

  #pendingOutboundUncertain(message, details = {}) {
    return new BrowserAdapterError(message, {
      code: "OUTBOUND_COMMIT_UNCERTAIN",
      recoverable: false,
      details,
    });
  }

  #assertRecoveryTarget({ page, mainFrame, targetId, initialUrl, navigated }) {
    if (
      navigated
      || this.page !== page
      || (typeof page.mainFrame === "function" && page.mainFrame() !== mainFrame)
      || !this.hasExactRecoveryTarget(targetId)
      || normalizedConversationUrl(page.url()) !== initialUrl
    ) {
      throw this.#pendingOutboundUncertain(
        "The exact ChatGPT target changed while reconciling the pending outbound.",
      );
    }
  }

  #recoveryDeadlineError() {
    return this.#pendingOutboundUncertain(
      "ChatGPT could not reconcile the pending outbound before the recovery deadline.",
    );
  }

  async #awaitWithinRecoveryDeadline(operation, deadline) {
    const remaining = deadline - this.monotonicNow();
    if (remaining <= 0) {
      throw this.#recoveryDeadlineError();
    }
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(this.#recoveryDeadlineError()),
            remaining,
          );
        }),
      ]);
      if (this.monotonicNow() >= deadline) {
        throw this.#recoveryDeadlineError();
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async #waitRecoveryPoll(deadline) {
    const remaining = deadline - this.monotonicNow();
    await this.#awaitWithinRecoveryDeadline(
      () => this.waitForPoll(Math.min(100, Math.max(1, remaining))),
      deadline,
    );
  }

  #recoveryBoundary(snapshot, {
    initialUrl,
    outboundId,
    observedUser,
    expectedUser,
    requiresEmptyPrefix,
    expectedPreOutboundIds,
    expectedWaitingAssistant,
  }) {
    if (snapshot.url !== initialUrl) {
      throw this.#pendingOutboundUncertain(
        "ChatGPT returned a mixed-URL conversation snapshot during recovery.",
      );
    }
    const matchingEntries = snapshot.entries.filter((entry) => (
      renderedMessageContainsOutboundMarker(entry.renderedText, outboundId)
    ));
    if (
      matchingEntries.length !== 1
      || matchingEntries[0].role !== "user"
    ) {
      throw this.#pendingOutboundUncertain(
        "The pending outbound marker is not unique to one ChatGPT user turn.",
      );
    }

    const user = matchingEntries[0];
    if (
      (observedUser && !sameIdentity(user, observedUser))
      || (expectedUser && !sameIdentity(user, expectedUser))
    ) {
      throw this.#pendingOutboundUncertain(
        "The correlated ChatGPT user-turn identity changed during recovery.",
      );
    }
    const userIndex = snapshot.entries.indexOf(user);
    const prefix = snapshot.entries.slice(0, userIndex);
    const suffix = snapshot.entries.slice(userIndex + 1);
    if (suffix.some((entry) => entry.role === "user")) {
      throw this.#pendingOutboundUncertain(
        "A later ChatGPT user turn exists after the pending outbound.",
      );
    }
    if (requiresEmptyPrefix) {
      if (prefix.length !== 0 || user.turn !== 1) {
        throw this.#pendingOutboundUncertain(
          "Fresh pending outbound recovery found unexpected conversation history.",
        );
      }
    } else if (
      expectedPreOutboundIds.size === 0
      || !prefix.some((entry) => expectedPreOutboundIds.has(entry.id))
    ) {
      throw this.#pendingOutboundUncertain(
        "Existing-conversation recovery could not verify a pre-outbound marker.",
      );
    }

    const successors = suffix.filter((entry) => entry.role === "assistant");
    if (successors.length > 1 || successors.length !== suffix.length) {
      throw this.#pendingOutboundUncertain(
        "ChatGPT assistant chronology is ambiguous after the pending outbound.",
      );
    }
    const assistant = successors[0] ?? null;
    if (assistant && assistant.turn !== user.turn + 1) {
      throw this.#pendingOutboundUncertain(
        "Pending outbound recovery found a discontinuous assistant turn.",
      );
    }
    if (
      expectedWaitingAssistant
      && assistant
      && !sameIdentity(assistant, expectedWaitingAssistant)
    ) {
      throw this.#pendingOutboundUncertain(
        "The assistant successor changed after the recovery handoff.",
      );
    }

    const assistantBaselineEntries = prefix.filter(
      (entry) => entry.role === "assistant",
    );
    const preOutboundMarkerIds = prefix
      .filter((entry) => expectedPreOutboundIds.has(entry.id))
      .map((entry) => entry.id);
    return {
      user,
      assistant,
      assistantBaselineEntries,
      preOutboundMarkerIds,
    };
  }

  async #assistantLocatorFor(entry) {
    const messages = this.assistantMessages();
    const count = await messages.count().catch(() => 0);
    let found = null;
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      const identity = await this.messageIdentity(message);
      if (!sameIdentity(entry, identity)) {
        continue;
      }
      if (found) {
        return null;
      }
      found = message;
    }
    return found;
  }

  async reconcilePendingOutbound({
    pendingOutbound = null,
    conversationTargetId = null,
    lastUserMessageId = null,
    lastAssistantMessageId = null,
    priorHandoff = null,
    timeoutMs = this.sendConfirmationTimeoutMs(),
    stableWindowMs = this.restorationCorrelationWindowMs(),
  } = {}) {
    this.requirePage();
    const outboundId = pendingOutbound?.outboundId
      ?? priorHandoff?.sourceOutboundId
      ?? null;
    if (!isValidOutboundCorrelationId(outboundId)) {
      throw this.#pendingOutboundUncertain(
        "The pending outbound has no valid transport correlation ID.",
      );
    }
    if (
      typeof conversationTargetId !== "string"
      || conversationTargetId.length === 0
      || !this.hasExactRecoveryTarget(conversationTargetId)
    ) {
      throw new BrowserAdapterError(
        "The exact saved ChatGPT target is unavailable for pending outbound recovery.",
        { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
      );
    }

    const page = this.page;
    const mainFrame = typeof page.mainFrame === "function"
      ? page.mainFrame()
      : null;
    const initialUrl = normalizedConversationUrl(page.url());
    const initialKind = initialUrl
      ? this.classifyConversationUrl(initialUrl)
      : "invalid";
    if (!["restorable", "provisional"].includes(initialKind)) {
      throw this.#pendingOutboundUncertain(
        "The exact ChatGPT target is not on a recognized conversation route.",
        { currentUrl: initialUrl },
      );
    }

    let navigated = false;
    const navigationListener = (frame) => {
      if (
        !mainFrame
        || frame === mainFrame
        || (typeof page.mainFrame === "function" && frame === page.mainFrame())
      ) {
        navigated = true;
      }
    };
    page.on?.("framenavigated", navigationListener);

    const outboundKind = pendingOutbound?.kind
      ?? priorHandoff?.outboundKind
      ?? "runtime_message";
    const requiresEmptyPrefix = ["bootstrap", "fresh_rebuild"]
      .includes(outboundKind);
    const expectedPreOutboundIds = new Set([
      lastUserMessageId,
      lastAssistantMessageId,
      ...(priorHandoff?.preOutboundMarkerIds ?? []),
      ...(priorHandoff?.assistantBaseline?.ids ?? []),
    ].filter(Boolean));
    const expectedUser = priorHandoff
      ? {
        id: priorHandoff.userMessageId ?? null,
        turn: priorHandoff.userTurn ?? null,
      }
      : null;
    const expectedAssistant = priorHandoff?.status === "complete"
      ? {
        id: priorHandoff.assistantMessageId ?? null,
        turn: priorHandoff.assistantTurn ?? null,
        responseHash: priorHandoff.responseHash ?? null,
      }
      : null;
    const expectedWaitingAssistant = priorHandoff?.status === "waiting"
      && priorHandoff.assistantCandidateMessageId
      ? {
        id: priorHandoff.assistantCandidateMessageId,
        turn: priorHandoff.assistantCandidateTurn ?? null,
      }
      : null;
    const deadline = this.monotonicNow() + timeoutMs;
    let stableSignature = null;
    let stableSince = 0;
    let observedUser = null;
    let observedAssistant = expectedWaitingAssistant ?? expectedAssistant ?? null;

    try {
      while (this.monotonicNow() < deadline) {
        this.#assertRecoveryTarget({
          page,
          mainFrame,
          targetId: conversationTargetId,
          initialUrl,
          navigated,
        });
        const snapshot = validatedOrderedSnapshot(
          await this.#awaitWithinRecoveryDeadline(
            () => this.orderedConversationSnapshot().catch(() => null),
            deadline,
          ),
        );
        if (!snapshot) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        this.#assertRecoveryTarget({
          page,
          mainFrame,
          targetId: conversationTargetId,
          initialUrl,
          navigated,
        });
        const hasOutboundMarker = snapshot.entries.some((entry) => (
          renderedMessageContainsOutboundMarker(entry.renderedText, outboundId)
        ));
        if (!hasOutboundMarker) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        const {
          user,
          assistant,
          assistantBaselineEntries,
          preOutboundMarkerIds,
        } = this.#recoveryBoundary(snapshot, {
          initialUrl,
          outboundId,
          observedUser,
          expectedUser,
          requiresEmptyPrefix,
          expectedPreOutboundIds,
          expectedWaitingAssistant,
        });
        observedUser = { id: user.id, turn: user.turn };
        if (
          assistant
          && observedAssistant
          && !sameIdentity(assistant, observedAssistant)
        ) {
          throw this.#pendingOutboundUncertain(
            "The ChatGPT assistant successor changed during recovery.",
          );
        }
        if (assistant && !observedAssistant) {
          observedAssistant = { id: assistant.id, turn: assistant.turn };
        }
        if (observedAssistant && !assistant) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        let status = "waiting";
        let rawResponse = null;
        let responseHash = null;
        if (assistant) {
          const locator = await this.#awaitWithinRecoveryDeadline(
            () => this.#assistantLocatorFor(assistant),
            deadline,
          );
          if (!locator) {
            stableSignature = null;
            stableSince = 0;
            await this.#waitRecoveryPoll(deadline);
            continue;
          }
          const stopVisible = Boolean(await this.#awaitWithinRecoveryDeadline(
            () => firstVisible(this.stopButtonLocators()),
            deadline,
          ));
          const generating = stopVisible || await this.#awaitWithinRecoveryDeadline(
            () => this.isAssistantGenerating(locator),
            deadline,
          );
          if (!generating) {
            const [generationError, usageLimit] = await this.#awaitWithinRecoveryDeadline(
              () => Promise.all([
                this.findGenerationErrorMarker(locator),
                this.findUsageLimitMarker(locator),
              ]),
              deadline,
            );
            if (!generationError && !usageLimit) {
              rawResponse = assistant.renderedText;
              if (rawResponse.trim()) {
                responseHash = createHash("sha256")
                  .update(rawResponse)
                  .digest("hex");
                status = "complete";
              }
            }
          }
        }
        if (expectedAssistant) {
          if (
            status !== "complete"
            || !sameIdentity(assistant, expectedAssistant)
            || responseHash !== expectedAssistant.responseHash
          ) {
            throw this.#pendingOutboundUncertain(
              "The completed assistant handoff no longer matches the browser reply.",
            );
          }
        }

        const signature = [
          initialUrl,
          conversationTargetId,
          user.id,
          user.turn,
          preOutboundMarkerIds.join(","),
          assistant?.id ?? "",
          assistant?.turn ?? "",
          status,
          responseHash ?? "",
        ].join(":");
        const observedAt = this.monotonicNow();
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = observedAt;
        }
        if (observedAt - stableSince < stableWindowMs) {
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        if (this.monotonicNow() >= deadline) {
          throw this.#recoveryDeadlineError();
        }

        const finalSnapshot = validatedOrderedSnapshot(
          await this.#awaitWithinRecoveryDeadline(
            () => this.orderedConversationSnapshot().catch(() => null),
            deadline,
          ),
        );
        if (
          !finalSnapshot
          || !finalSnapshot.entries.some((entry) => (
            renderedMessageContainsOutboundMarker(entry.renderedText, outboundId)
          ))
        ) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        this.#assertRecoveryTarget({
          page,
          mainFrame,
          targetId: conversationTargetId,
          initialUrl,
          navigated,
        });
        const finalBoundary = this.#recoveryBoundary(finalSnapshot, {
          initialUrl,
          outboundId,
          observedUser,
          expectedUser,
          requiresEmptyPrefix,
          expectedPreOutboundIds,
          expectedWaitingAssistant,
        });
        if (expectedWaitingAssistant && !finalBoundary.assistant) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        if (
          Boolean(finalBoundary.assistant) !== Boolean(assistant)
          || (
            assistant
            && !sameIdentity(finalBoundary.assistant, assistant)
          )
        ) {
          if (!assistant && finalBoundary.assistant) {
            stableSignature = null;
            stableSince = 0;
            await this.#waitRecoveryPoll(deadline);
            continue;
          }
          throw this.#pendingOutboundUncertain(
            "The ChatGPT assistant boundary changed during recovery verification.",
          );
        }
        if (
          finalBoundary.preOutboundMarkerIds.join(",")
          !== preOutboundMarkerIds.join(",")
        ) {
          stableSignature = null;
          stableSince = 0;
          await this.#waitRecoveryPoll(deadline);
          continue;
        }
        if (status === "complete") {
          const finalRawResponse = finalBoundary.assistant?.renderedText ?? "";
          const finalResponseHash = createHash("sha256")
            .update(finalRawResponse)
            .digest("hex");
          if (finalResponseHash !== responseHash) {
            stableSignature = null;
            stableSince = 0;
            await this.#waitRecoveryPoll(deadline);
            continue;
          }
          rawResponse = finalRawResponse;
        }

        const assistantBaseline = {
          ids: assistantBaselineEntries.map((entry) => entry.id),
          count: assistantBaselineEntries.length,
          maxTurn: assistantBaselineEntries.at(-1)?.turn ?? null,
          lastText: assistantBaselineEntries.at(-1)?.renderedText ?? "",
        };
        this.acceptRecoveredOutboundAnchor({
          conversationUrl: initialUrl,
          conversationTargetId,
          userMessageId: user.id,
          userTurn: user.turn,
          assistantBaseline,
          assistantCandidateMessageId: assistant?.id ?? null,
          assistantCandidateTurn: assistant?.turn ?? null,
        });
        if (status === "complete") {
          this.lastAssistantMessageId = assistant.id;
          this.lastAssistantTurn = assistant.turn;
        }
        if (this.monotonicNow() >= deadline) {
          throw this.#recoveryDeadlineError();
        }
        this.#assertRecoveryTarget({
          page,
          mainFrame,
          targetId: conversationTargetId,
          initialUrl,
          navigated,
        });
        return {
          status,
          conversationUrl: initialUrl,
          conversationTargetId,
          userMessageId: user.id,
          userTurn: user.turn,
          preOutboundMarkerIds,
          assistantBaseline,
          ...(assistant
            ? {
              assistantCandidateMessageId: assistant.id,
              assistantCandidateTurn: assistant.turn,
            }
            : {}),
          ...(status === "complete"
            ? {
              assistantMessageId: assistant.id,
              assistantTurn: assistant.turn,
              rawResponse,
              responseHash,
            }
            : {}),
        };
      }
      throw this.#pendingOutboundUncertain(
        "ChatGPT could not stably reconcile the pending outbound on its exact target.",
      );
    } finally {
      page.off?.("framenavigated", navigationListener);
    }
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
    if (
      !this.allowInPlaceAssistantContinuation
      || !this.inPlaceAssistantGenerationObserved
      || this.sentUserTurn == null
      || !id
      || !this.assistantIdsBeforeSend.has(id)
    ) {
      return false;
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

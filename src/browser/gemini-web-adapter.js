import { createHash } from "node:crypto";
import path from "node:path";
import {
  BaseWebAdapter,
  firstVisible,
  isValidOutboundCorrelationId,
  normalizedConversationUrl,
  renderedMessageContainsOutboundMarker,
} from "./base-web-adapter.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";
import { readRenderedBlocks } from "./rendered-text.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_PENDING_USER_ID = "user-query-content-undefined";
const GEMINI_MESSAGE_CONTENT = {
  user: `.query-content[id^="user-query-content-"]:not([id="${GEMINI_PENDING_USER_ID}"])`,
  assistant: 'message-content[id^="message-content-id-"]',
};

function readGeminiRows(rows, selectors) {
  return {
    url: globalThis.location?.href,
    entries: rows.map((row) => {
      const user = row.tagName === "USER-QUERY";
      const content = row.querySelector(user ? selectors.user : selectors.assistant);
      return {
        role: user ? "user" : "assistant",
        id: content?.id ?? null,
        turn: null,
        renderedText: user ? row.innerText : "",
      };
    }),
  };
}

function uncertainGeminiOutbound(message) {
  return new BrowserAdapterError(message, {
    code: "OUTBOUND_COMMIT_UNCERTAIN",
    recoverable: false,
  });
}

// Gemini Web adapter. The live application exposes stable custom elements for
// user and model turns. Each model response also owns a response-specific
// message-content id and structural response actions that appear only after the
// turn is complete, so the shared runtime does not depend on translated prose.
export class GeminiWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? GEMINI_URL,
      providerName: "Gemini",
    });
  }

  conversationUrlPattern() {
    // /app is a blank chat; a sent/saved conversation adds one id segment.
    return /^\/app\/[^/]+/;
  }

  pendingAttachmentLocators() {
    return [
      this.page.locator(
        '[data-test-id="textarea-wrapper"] .attachment-container, '
          + '[data-test-id="textarea-wrapper"] '
          + 'button[aria-label*="remove" i]',
      ),
    ];
  }

  composerLocators() {
    return [
      this.page.locator(
        '[data-test-id="textarea-wrapper"] .ql-editor[contenteditable="true"][role="textbox"]',
      ),
      this.page.locator('div.ql-editor[contenteditable="true"][role="textbox"]'),
      this.page.getByRole("textbox", { name: /Gemini|prompt|提示/i }),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator(
        'button[aria-label="发送"], button[aria-label="Send"], '
          + 'button[aria-label="Send message"]',
      ),
      this.page.getByRole("button", { name: /^(发送|Send(?: message)?)$/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator(
        'button[aria-label="停止回答"], button[aria-label="Stop response"]',
      ),
      this.page.getByRole("button", { name: /^(停止回答|Stop response)$/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('a[href="/app"]'),
      this.page.getByRole("button", { name: /^(发起新对话|新对话|New chat)$/i }),
      this.page.getByRole("link", { name: /^(发起新对话|新对话|New chat)$/i }),
    ];
  }

  authUrlPattern() {
    return /^\/(?:v\d+\/)?signin(?:\/|$)|^\/ServiceLogin(?:\/|$)|^\/o\/oauth2\//;
  }

  loginControlLocators() {
    return [
      this.page.locator("#identifierId"),
      this.page.locator('input[type="email"][autocomplete="username"]'),
      this.page.getByRole("button", { name: /^(登录|Sign in)$/i }),
      this.page.getByRole("link", { name: /^(登录|Sign in)$/i }),
    ];
  }

  assistantMessages() {
    return this.page.locator("model-response");
  }

  userMessages() {
    return this.page.locator("user-query");
  }

  conversationMessages() {
    return this.page.locator("user-query, model-response");
  }

  async userMessageSnapshot() {
    const users = this.userMessages();
    if (typeof users.evaluateAll !== "function") return super.userMessageSnapshot();
    // Capture the ID and its text together, even if Gemini remounts rows while
    // the send is being confirmed.
    return await users.evaluateAll(readGeminiRows, GEMINI_MESSAGE_CONTENT).then(({ entries }) => entries)
      .catch(() => null);
  }

  supportsPendingOutboundRecovery() {
    return true;
  }

  sendConfirmationTimeoutMs() {
    // Gemini can take several minutes to assign a durable user-message ID.
    return 10 * 60_000;
  }

  async reopenSavedToolResultConversation({ conversationUrl, lastUserMessageId, lastAssistantMessageId, responseHash }) {
    const url = normalizedConversationUrl(conversationUrl);
    if (this.classifyConversationUrl(url) !== "restorable" || !lastUserMessageId || !lastAssistantMessageId || !responseHash) {
      throw uncertainGeminiOutbound("The saved Gemini conversation lacks a durable archive boundary for recovery.");
    }
    await this.launch();
    const restored = await this.startConversation(url, {
      expectedUserMessageId: lastUserMessageId, expectedAssistantMessageId: lastAssistantMessageId,
    });
    if (restored.status !== "restored-existing" || !restored.targetId) {
      throw uncertainGeminiOutbound("Gemini could not reopen the saved conversation for tool result recovery.");
    }
    await this.launchRecoveryTarget(restored.targetId);
    const { url: sampledUrl, entries } = await this.conversationMessages().evaluateAll(readGeminiRows, GEMINI_MESSAGE_CONTENT);
    const replyIndex = entries.findIndex((entry) => entry.role === "assistant" && entry.id === lastAssistantMessageId);
    const user = entries[replyIndex - 1];
    if (normalizedConversationUrl(sampledUrl) !== url || user?.role !== "user" || user.id !== lastUserMessageId
      || entries.filter((entry) => entry.id === lastAssistantMessageId).length !== 1) {
      throw uncertainGeminiOutbound("Gemini's archived conversation does not contain the saved tool call boundary.");
    }
    const assistantIndex = entries.slice(0, replyIndex).filter((entry) => entry.role === "assistant").length;
    const reply = this.assistantMessages().nth(assistantIndex);
    const identity = await this.messageIdentity(reply);
    if (identity.id !== lastAssistantMessageId || createHash("sha256").update((await this.assistantText(reply)).trimEnd()).digest("hex") !== responseHash
      || normalizedConversationUrl(this.page.url()) !== url) {
      throw uncertainGeminiOutbound("Gemini's archived reply no longer matches the saved tool call.");
    }
    return restored.targetId;
  }

  async #readToolResultRetryHistory(anchor) {
    const { url, entries } = await this.conversationMessages().evaluateAll(readGeminiRows, GEMINI_MESSAGE_CONTENT);
    const priorUser = entries.at(-2);
    const priorReply = entries.at(-1);
    if (!this.hasExactRecoveryTarget(anchor.conversationTargetId)
      || normalizedConversationUrl(url) !== anchor.conversationUrl
      || normalizedConversationUrl(this.page.url()) !== anchor.conversationUrl
      || priorUser?.role !== "user" || priorUser.id !== anchor.lastUserMessageId
      || priorReply?.role !== "assistant" || priorReply.id !== anchor.lastAssistantMessageId
      || entries.some((entry) => !entry.id || renderedMessageContainsOutboundMarker(entry.renderedText, anchor.outboundId))
      || await this.page.locator("pending-request").count() > 0
      || await firstVisible(this.stopButtonLocators())) {
      throw uncertainGeminiOutbound("Gemini's original conversation is no longer at the saved tool call. Review the tab before continuing.");
    }
    if (anchor.responseHash) {
      const reply = await this.assistantText(this.assistantMessages().last());
      if (createHash("sha256").update(reply.trimEnd()).digest("hex") !== anchor.responseHash) {
        throw uncertainGeminiOutbound("Gemini's previous reply no longer matches the saved tool call.");
      }
    }
    return entries.filter((entry) => entry.role === "assistant").map((entry) => entry.id);
  }

  async prepareToolResultRetry({ pendingOutbound, conversationTargetId, lastUserMessageId, lastAssistantMessageId, responseHash }) {
    const anchor = {
      conversationUrl: normalizedConversationUrl(pendingOutbound.conversationUrl),
      conversationTargetId, outboundId: pendingOutbound.outboundId, lastUserMessageId, lastAssistantMessageId, responseHash,
    };
    const ids = await this.#readToolResultRetryHistory(anchor);
    const composer = await firstVisible(this.composerLocators());
    const draft = composer ? await this.#readComposerText(composer) : null;
    if (draft == null || await firstVisible(this.pendingAttachmentLocators())
      || (draft.trim() && !await this.#matchesSavedDraft(anchor, pendingOutbound.messageHash))) {
      throw uncertainGeminiOutbound("Gemini's composer contains another draft or attachments. Check the original tab before retrying the saved result.");
    }
    this.acceptRecoveredOutboundAnchor({
      conversationUrl: anchor.conversationUrl, conversationTargetId,
      userMessageId: lastUserMessageId, assistantBaseline: { ids, count: ids.length },
    });
    return async (message, options) => {
      this.toolResultRetryAnchor = anchor;
      try {
        return await this.sendMessage(message, options);
      } finally {
        this.toolResultRetryAnchor = null;
      }
    };
  }

  async #matchesSavedDraft(anchor, messageHash) {
    const composer = await firstVisible(this.composerLocators());
    if (!composer) return false;
    const draft = await this.#readComposerText(composer);
    if (draft == null || !renderedMessageContainsOutboundMarker(draft, anchor.outboundId)) return false;
    // Quill can substitute nonbreaking spaces and append one layout newline.
    // Accept those representations only when the result matches the saved hash.
    const plainSpaces = draft.replaceAll("\u00a0", " ");
    return [draft, plainSpaces].some((text) => [text, text.replace(/\n$/, "")]
      .some((value) => createHash("sha256").update(value).digest("hex") === messageHash));
  }

  async #readRecoveredBoundary(anchor, { waitForIdentity = false, draftHash = null } = {}) {
    const snapshot = await this.conversationMessages().evaluateAll(readGeminiRows, GEMINI_MESSAGE_CONTENT);
    const { entries } = snapshot;
    if (!this.hasExactRecoveryTarget(anchor.conversationTargetId)
      || normalizedConversationUrl(snapshot.url) !== anchor.conversationUrl
      || normalizedConversationUrl(this.page.url()) !== anchor.conversationUrl) {
      throw uncertainGeminiOutbound("Gemini could not verify the saved target and conversation URL.");
    }
    const matching = entries.filter((entry) => entry.role === "user"
      && renderedMessageContainsOutboundMarker(entry.renderedText, anchor.outboundId));
    if (matching.length === 0 && draftHash && anchor.lastUserMessageId && anchor.lastAssistantMessageId
      && entries.at(-2)?.id === anchor.lastUserMessageId
      && entries.at(-1)?.id === anchor.lastAssistantMessageId
      && await this.#matchesSavedDraft(anchor, draftHash)
      && this.hasExactRecoveryTarget(anchor.conversationTargetId)
      && normalizedConversationUrl(this.page.url()) === anchor.conversationUrl) {
      throw new BrowserAdapterError(
        "Gemini still has the exact saved draft in the original tab. Check the conversation, send that draft once in the browser, then resume this session.",
        { code: "OUTBOUND_DRAFT_PRESENT", recoverable: false },
      );
    }
    const user = matching[0];
    if (matching.length === 0) {
      throw new BrowserAdapterError("Gemini has no sent message matching the pending outbound in the saved conversation.", {
        code: "OUTBOUND_TRACE_MISSING", recoverable: false,
      });
    }
    if (matching.length !== 1 || (anchor.userMessageId && user.id !== anchor.userMessageId)) {
      throw uncertainGeminiOutbound("Gemini could not identify exactly one user message for the pending send.");
    }
    const index = entries.indexOf(user);
    const prefix = entries.slice(0, index);
    const suffix = entries.slice(index + 1);
    const assistant = suffix[0] ?? null;
    const ids = entries.map((entry) => entry.id).filter(Boolean);
    if (prefix.some((entry) => !entry.id) || new Set(ids).size !== ids.length
      || (anchor.requiresEmptyPrefix ? prefix.length !== 0 : !prefix.some((entry) => anchor.preOutboundIds.has(entry.id)))
      || suffix.length > 1
      || (assistant && assistant.role !== "assistant")
      || (anchor.assistantCandidateMessageId && assistant?.id !== anchor.assistantCandidateMessageId)) {
      throw uncertainGeminiOutbound("Gemini's conversation history or adjacent reply changed during recovery.");
    }
    if (!user.id || (assistant && !assistant.id)) {
      if (waitForIdentity) return null;
      throw uncertainGeminiOutbound("Gemini has not assigned stable identities to the recovered turn.");
    }
    return { user, assistant, prefix };
  }

  async reconcilePendingOutbound({
    pendingOutbound = null,
    priorHandoff = null,
    conversationTargetId,
    lastUserMessageId = null,
    lastAssistantMessageId = null,
    timeoutMs = this.sendConfirmationTimeoutMs(),
    stableWindowMs = this.restorationCorrelationWindowMs(),
  } = {}) {
    this.requirePage();
    const page = this.page;
    const outboundId = pendingOutbound?.outboundId ?? priorHandoff?.sourceOutboundId;
    const kind = pendingOutbound?.kind ?? priorHandoff?.outboundKind;
    const savedUrl = normalizedConversationUrl(pendingOutbound?.conversationUrl ?? priorHandoff?.conversationUrl);
    const conversationUrl = normalizedConversationUrl(page.url());
    const requiresEmptyPrefix = ["bootstrap", "fresh_rebuild"].includes(kind);
    if (!this.hasExactRecoveryTarget(conversationTargetId)
      || !isValidOutboundCorrelationId(outboundId)
      || this.classifyConversationUrl(conversationUrl) !== "restorable"
      || (conversationUrl !== savedUrl && !(requiresEmptyPrefix && this.classifyConversationUrl(savedUrl) === "fresh"))) {
      throw uncertainGeminiOutbound("Gemini recovery requires the exact saved browser target and conversation.");
    }
    // Older versions could persist the optimistic Angular row identity.
    // Rebind it only with the nonce and verified preceding messages.
    const savedUserId = priorHandoff?.userMessageId;
    const userMessageId = savedUserId && savedUserId !== GEMINI_PENDING_USER_ID ? savedUserId : null;
    const assistantCandidateMessageId = priorHandoff?.assistantMessageId
      ?? priorHandoff?.assistantCandidateMessageId ?? null;
    if (priorHandoff?.status === "complete" && (!priorHandoff.assistantMessageId || !priorHandoff.responseHash)) {
      throw uncertainGeminiOutbound("Gemini's completed handoff is missing its reply identity or hash.");
    }
    const preOutboundIds = new Set([
      lastUserMessageId, lastAssistantMessageId,
      ...(priorHandoff?.preOutboundMarkerIds ?? []),
      ...(priorHandoff?.assistantBaseline?.ids ?? []),
    ].filter((id) => id && id !== GEMINI_PENDING_USER_ID
      && id !== userMessageId && id !== assistantCandidateMessageId));
    const anchor = {
      conversationUrl, conversationTargetId, outboundId, requiresEmptyPrefix,
      preOutboundIds, userMessageId, assistantCandidateMessageId, lastUserMessageId, lastAssistantMessageId,
    };
    const initialReadOptions = {
      waitForIdentity: true,
      draftHash: priorHandoff ? null : pendingOutbound?.messageHash,
    };
    let invalidated = false;
    let timer;
    const onNavigation = (frame) => {
      if (frame === page.mainFrame()) invalidated = true;
    };
    page.on("framenavigated", onNavigation);
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            invalidated = true;
            reject(uncertainGeminiOutbound("Gemini could not verify the pending send before the recovery deadline."));
          }, timeoutMs);
        }),
        (async () => {
          let first = await this.#readRecoveredBoundary(anchor, initialReadOptions);
          while (!first && !invalidated && this.page === page) {
            await this.waitForPoll(250);
            if (!invalidated && this.page === page) {
              first = await this.#readRecoveredBoundary(anchor, initialReadOptions);
            }
          }
          if (!first || invalidated || this.page !== page) {
            throw uncertainGeminiOutbound("Gemini's pending turn could not be bound to the saved conversation.");
          }
          anchor.userMessageId = first.user.id;
          anchor.assistantCandidateMessageId = first.assistant?.id ?? null;
          await this.waitForPoll(stableWindowMs);
          let complete = null;
          if (priorHandoff?.status === "complete") {
            const reply = this.assistantMessages().last();
            const rawResponse = await this.assistantText(reply);
            const responseHash = createHash("sha256").update(rawResponse).digest("hex");
            if (responseHash !== priorHandoff.responseHash
              || await this.isAssistantGenerating(reply)) {
              throw uncertainGeminiOutbound("Gemini's saved reply changed before recovery.");
            }
            complete = { assistantMessageId: first.assistant?.id, rawResponse, responseHash };
          }
          const { assistant, prefix } = await this.#readRecoveredBoundary(anchor);
          if (invalidated || this.page !== page) {
            throw uncertainGeminiOutbound("Gemini navigated while verifying the pending send.");
          }
          anchor.assistantCandidateMessageId = assistant?.id ?? null;
          const ids = prefix.filter((entry) => entry.role === "assistant").map((entry) => entry.id);
          const outcome = {
            status: complete ? "complete" : "waiting",
            conversationUrl,
            conversationTargetId,
            userMessageId: anchor.userMessageId,
            assistantCandidateMessageId: anchor.assistantCandidateMessageId,
            assistantBaseline: { ids, count: ids.length },
            preOutboundMarkerIds: prefix.filter((entry) => preOutboundIds.has(entry.id)).map((entry) => entry.id),
            ...complete,
          };
          this.acceptRecoveredOutboundAnchor(outcome);
          this.recoveredGeminiAnchor = anchor;
          return outcome;
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      page.off("framenavigated", onNavigation);
    }
  }

  async assertRecoveredTurnTopology({ assistantPresent = false, assistantMessageId = null } = {}) {
    const anchor = this.recoveredGeminiAnchor;
    if (!anchor) return;
    const { assistant } = await this.#readRecoveredBoundary(anchor);
    if (assistantPresent && assistant?.id !== assistantMessageId) {
      throw uncertainGeminiOutbound("Gemini's response is outside the recovered user turn.");
    }
    anchor.assistantCandidateMessageId ??= assistant?.id ?? null;
  }

  async messageIdentity(message) {
    const modelContent = message.locator(
      GEMINI_MESSAGE_CONTENT.assistant,
    ).first();
    // `getAttribute()` waits for the locator by default. User rows never have
    // message-content, so probing it directly added one full 15-second timeout
    // for every user message captured before and after a send.
    if (await modelContent.count().catch(() => 0) > 0) {
      const modelId = await modelContent.getAttribute("id").catch(() => null);
      if (modelId) {
        return { id: modelId, turn: null };
      }
    }

    const userContent = message.locator(
      GEMINI_MESSAGE_CONTENT.user,
    ).first();
    const userId = await userContent.count().catch(() => 0) > 0
      ? await userContent.getAttribute("id").catch(() => null)
      : null;
    return { id: userId || null, turn: null };
  }

  async assistantText(message) {
    // Read Gemini's rendered answer body before falling back to the enclosing
    // message-content. Attachment/source chips (for example a trailing "TXT")
    // live beside `.markdown` and are UI chrome, not model output.
    const markdown = message.locator("message-content .markdown");
    if (await markdown.count().catch(() => 0) > 0) {
      return await markdown.evaluateAll(readRenderedBlocks);
    }
    const content = message.locator("message-content");
    if (await content.count().catch(() => 0) > 0) {
      return await content.evaluateAll(readRenderedBlocks);
    }
    return await message.innerText().catch(() => "");
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating(message) {
    const busy = message.locator('[aria-busy="true"]').first();
    if (await busy.isVisible().catch(() => false)) {
      return true;
    }

    // Gemini mounts the response action icons only after the stream is
    // finished. Test the icon itself: the enclosing `.response-footer.complete`
    // currently has rendered dimensions but Playwright still reports it as
    // hidden, while the Regenerate/Redo control is reliably visible.
    const completed = await firstVisible([
      message.locator('[data-test-id="regenerate-button"]'),
      message.getByRole("button", { name: /^(Redo|Regenerate|重做)$/i }),
    ]);
    return !completed;
  }

  async attachFiles(files) {
    this.requirePage();
    const paths = (files ?? [])
      .map((file) => (typeof file === "string" ? file : file?.path))
      .filter(Boolean);
    if (paths.length === 0) {
      return { attached: [], failed: [] };
    }

    try {
      const input = this.page.locator('input[type="file"]').first();
      if (await input.count().catch(() => 0) > 0) {
        await input.setInputFiles(paths, { timeout: 15_000 });
      } else {
        // Follow Gemini's visible two-step path: open Upload & tools, then click
        // the Upload files menu item. The latter emits a real filechooser event.
        const uploadMenus = [
          this.page.locator(
            'button[aria-label="Upload & tools"], '
              + 'button[aria-label="上传和工具"]',
          ),
          this.page.getByRole("button", {
            name: /^(Upload & tools|上传和工具|上传.*工具)$/i,
          }),
        ];
        let uploadMenu = null;
        const menuDeadline = Date.now() + 10_000;
        while (!uploadMenu && Date.now() < menuDeadline) {
          uploadMenu = await firstVisible(uploadMenus);
          if (!uploadMenu) {
            await this.page.waitForTimeout(250);
          }
        }
        if (!uploadMenu) {
          throw new Error("Gemini Upload & tools control was not found");
        }
        if (!await this.#clickWithNativePointer(uploadMenu)) {
          await uploadMenu.click();
        }

        const uploadFiles = this.page.locator(
          '[data-test-id="local-images-files-uploader-button"]',
        ).first();
        await uploadFiles.waitFor({ state: "visible", timeout: 10_000 });
        const chooserPromise = this.page.waitForEvent("filechooser", {
          timeout: 15_000,
        });
        if (!await this.#clickWithNativePointer(uploadFiles)) {
          await uploadFiles.click();
        }
        const chooser = await chooserPromise;
        await chooser.setFiles(paths);
      }
    } catch (error) {
      await this.writeDiagnostics("gemini-attach-files-failed");
      return {
        attached: [],
        failed: paths.map((filePath) => ({ path: filePath, message: error.message })),
      };
    }

    // Wait for the final filename to appear in the composer before sending.
    const finalName = path.basename(paths.at(-1));
    await this.page.locator('[data-test-id="textarea-wrapper"]')
      .filter({ hasText: finalName })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => null);
    return { attached: [...paths], failed: [] };
  }

  async fillComposer(composer, text) {
    this.requirePage();
    const expected = String(text ?? "");
    let clipboardUsed = false;

    try {
      const activated = await this.#clickWithNativePointer(composer);
      if (!activated) {
        await super.fillComposer(composer, expected);
      } else {
        const active = await composer.evaluate(
          (element) => document.activeElement === element,
        ).catch(() => false);
        if (!active) {
          await composer.focus().catch(() => null);
        }

        const currentValue = await this.#readComposerText(composer);
        if (currentValue) {
          await this.page.keyboard.press(
            process.platform === "darwin" ? "Meta+A" : "Control+A",
          );
          await this.page.keyboard.press("Backspace");
        }

        // Preserve the requested human-like order: click, a short pause, paste,
        // then another short pause before the pointer clicks Send.
        await this.page.waitForTimeout(Math.floor(Math.random() * 1_001));
        clipboardUsed = await this.#pasteWithClipboard(expected);
        if (!clipboardUsed) {
          await this.page.keyboard.insertText(expected);
        }
      }

      let actual = await this.#readComposerText(composer, expected);
      if (actual !== expected) {
        // Quill's contenteditable `fill()` can append when its internal
        // selection is stale. Clear through the focused keyboard path first so
        // a recovery attempt can never duplicate the full protocol prompt.
        await composer.focus().catch(() => null);
        await this.page.keyboard.press(
          process.platform === "darwin" ? "Meta+A" : "Control+A",
        ).catch(() => null);
        await this.page.keyboard.press("Backspace").catch(() => null);
        await this.page.waitForTimeout(50);
        await composer.fill(expected).catch(() => null);
        actual = await this.#readComposerText(composer, expected);
      }
      if (actual !== expected) {
        throw new BrowserAdapterError(
          `${this.providerName} did not commit the complete prompt text.`,
          {
            code: "COMPOSER_FILL_FAILED",
            details: {
              expectedLength: expected.length,
              actualLength: actual?.length ?? null,
            },
          },
        );
      }

      await this.page.waitForTimeout(Math.floor(Math.random() * 2_001));
    } finally {
      if (clipboardUsed) {
        await this.#restoreClipboard();
      }
    }
  }

  async prepareComposerSubmission(composer, { text } = {}) {
    const deadline = this.monotonicNow() + 10_000;
    while (this.monotonicNow() < deadline) {
      const button = await firstVisible(this.sendButtonLocators());
      if (button && await button.isEnabled()
        && await this.page.locator("pending-request").count() === 0) {
        if (text != null && await this.#readComposerText(composer, text) !== text) {
          throw new BrowserAdapterError("Gemini's draft changed before submission. Check the composer before continuing.", {
            code: "COMPOSER_CHANGED_BEFORE_SEND", recoverable: false,
          });
        }
        if (this.toolResultRetryAnchor) await this.#readToolResultRetryHistory(this.toolResultRetryAnchor);
        return button;
      }
      await this.waitForPoll(100);
    }
    throw new BrowserAdapterError("Gemini did not enable its Send button. The draft remains in the composer.", {
      code: "SEND_BUTTON_NOT_READY", recoverable: false,
    });
  }

  async submitComposer(composer, { assertActive = () => {}, timeoutMs, preparedSubmission } = {}) {
    const button = preparedSubmission ?? await this.prepareComposerSubmission(composer);
    assertActive();
    const options = { timeout: Math.min(timeoutMs ?? 10_000, 10_000) };
    try {
      if (this.musicGeneration) {
        await button.press("Space", options);
      } else {
        await button.click(options);
      }
    } catch (cause) {
      throw new BrowserAdapterError("Gemini's Send action ended without confirmation. Check the original tab before retrying.", {
        code: "SEND_COMMIT_UNKNOWN", recoverable: false, cause,
      });
    }
  }

  async prepareMusicGeneration() {
    this.requirePage();
    // Gemini may move Music from the regular chat tool menu to a dedicated
    // creation screen. Its old tool chip then exists only in a hidden composer.
    const prepareCreationPage = async () => {
      if (typeof this.page.getByText !== "function") return false;
      const heading = this.page.getByText("Create music", { exact: true });
      if (!await heading.isVisible().catch(() => false)) return false;
      const editor = this.page.locator('div.ql-editor[contenteditable="true"][role="textbox"]');
      const template = this.page.getByRole("button", { name: "Background music", exact: true });
      if (await template.isVisible().catch(() => false)) {
        const placeholder = await editor.getAttribute("data-placeholder").catch(() => "");
        if (!/background music/i.test(placeholder)) await template.click();
      }
      await editor.waitFor({ state: "visible", timeout: 15_000 });
      this.musicGeneration = true;
      return true;
    };
    if (await prepareCreationPage()) return;
    try {
      const selected = this.page.getByRole("button", {
        name: /^(Deselect Music|取消选择音乐|取消選取音樂)$/i,
      });
      if (!await selected.isVisible().catch(() => false)) {
        const tools = this.page.getByRole("button", { name: /^(Upload & tools|上传和工具|上傳和工具)$/i });
        if (await tools.getAttribute("aria-expanded") !== "true") await tools.press("Space");
        const music = this.page.locator('button[role="menuitemcheckbox"]:has([data-mat-icon-name="music"])');
        await music.waitFor({ state: "visible", timeout: 10_000 });
        if (await music.getAttribute("aria-disabled") === "true") {
          throw new BrowserAdapterError("Gemini Music is unavailable for this account.", { code: "MUSIC_UNAVAILABLE", recoverable: false });
        }
        await music.press("Space");
        await selected.waitFor({ state: "visible", timeout: 10_000 });
      }
    } catch (error) {
      // Selecting Music in the old menu can navigate to the new screen before
      // the old menu item appears. Reconcile the UI without sending twice.
      if (await prepareCreationPage()) return;
      throw error;
    }
    this.musicGeneration = true;
  }

  async dismissTransientOverlays() {
    const consent = await firstVisible([
      this.page.getByRole("button", { name: /^(Accept all|全部接受|同意)$/i }),
    ]);
    await consent?.click().catch(() => null);
  }

  async scrollConversationToBottom() {
    const last = this.conversationMessages().last();
    await last.scrollIntoViewIfNeeded().catch(() => null);
  }

  async findUsageLimitMarker(message) {
    const alert = this.page.locator('[role="alert"], [data-test-id*="toast"]')
      .last();
    // An absent alert is the normal case. Calling innerText() directly on that
    // empty locator consumes the page's full 15-second default timeout after
    // every otherwise-complete Gemini response.
    const alertText = await alert.count().catch(() => 0) > 0
      && await alert.isVisible().catch(() => false)
      ? await alert.innerText().catch(() => "")
      : "";
    if (isUsageLimitNotice(alertText)) return alertText.trim().slice(0, 160);
    const rowText = await message.innerText().catch(() => "");
    return !rowText.includes("<agent_response") && isUsageLimitNotice(rowText)
      ? rowText.trim().slice(0, 160) : null;
  }

  async findGenerationErrorMarker(message) {
    const error = message.locator(
      '[role="alert"], [data-test-id*="error"], .error-message, .response-error',
    ).first();
    if (!await error.isVisible().catch(() => false)) {
      return null;
    }
    const text = await error.innerText().catch(() => "");
    return text.trim().slice(0, 160) || "model error";
  }

  hasStructuralDiagnostics() {
    return typeof this.page?.evaluate === "function";
  }

  async structuralDiagnostics() {
    const dom = await this.page.evaluate((selectors) => {
      const visible = (node) => node.getClientRects().length > 0;
      const all = (selector) => [...document.querySelectorAll(selector)];
      const send = all('button[aria-label="发送"],button[aria-label="Send"],button[aria-label="Send message"]').filter(visible);
      return {
        userRows: all("user-query").length,
        stableUserIds: all(`user-query ${selectors.user}`).length,
        assistantRows: all("model-response").length,
        pendingRows: all("pending-request").length,
        composerHasDraft: all('.ql-editor[contenteditable="true"]').some((node) => visible(node) && node.textContent.trim()),
        sendVisible: send.length > 0,
        sendEnabled: send.some((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true"),
        visibleAlerts: all('[role="alert"],[data-test-id*="toast"]').filter(visible).length,
      };
    }, GEMINI_MESSAGE_CONTENT);
    const sample = this.activeSendProof?.sample;
    const issues = [];
    if (dom.pendingRows && dom.userRows > dom.stableUserIds) {
      issues.push("Gemini is still showing an unconfirmed temporary message");
    }
    if (dom.composerHasDraft && dom.sendVisible && !dom.sendEnabled) {
      issues.push("Gemini's Send button is disabled with a draft in the composer");
    }
    return {
      status: "captured", issues, ...dom,
      sawMatchingUnnumberedUser: this.activeSendProof?.sawMatchingUnnumberedUser === true,
      candidateMarkerMatched: sample?.markerMatched ?? null,
    };
  }

  async #readComposerText(composer, expected = null) {
    const raw = await composer.evaluate((element) => {
      if (typeof element.value === "string") {
        return element.value;
      }
      // Gemini uses Quill: every pasted plain-text line becomes a direct <p>,
      // and an empty line becomes <p><br></p>. `innerText` inserts an extra
      // layout newline between those blocks, while `textContent` removes all
      // line breaks. Reconstructing the direct blocks recovers the exact text
      // that was committed, including long multi-line protocol prompts.
      if (element.isContentEditable) {
        return [...element.childNodes].map((node) => {
          const value = node.nodeType === Node.TEXT_NODE
            ? node.textContent
            : (node.innerText ?? node.textContent ?? "");
          return value === "\n" ? "" : value;
        }).join("\n");
      }
      return element.innerText ?? element.textContent ?? "";
    }).catch(() => null);
    if (raw == null) {
      return null;
    }
    let normalized = String(raw).replaceAll("\r\n", "\n");
    if (expected != null) {
      const normalizedExpected = String(expected).replaceAll("\r\n", "\n");
      // Quill serializes the first leading ASCII space of an indented line as
      // &nbsp; (U+00A0). It is the same committed prompt text, so canonicalize
      // only when the expected character at that exact position is a space.
      normalized = normalized.replace(/\u00a0/g, (character, index) => (
        normalizedExpected[index] === " " ? " " : character
      ));
    }
    // Quill may expose one layout newline after the last paragraph even when
    // the committed text itself has no trailing newline.
    if (expected != null && !expected.endsWith("\n") && normalized.endsWith("\n")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  async #clickWithNativePointer(locator, assertActive = () => {}) {
    assertActive();
    await locator.scrollIntoViewIfNeeded().catch(() => null);
    const box = await locator.boundingBox().catch(() => null);
    if (!box || !this.page.mouse) {
      return false;
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y, { steps: 8 });
    await this.page.waitForTimeout(75);
    assertActive();
    await this.page.mouse.down();
    await this.page.waitForTimeout(80);
    await this.page.mouse.up();
    await this.page.waitForTimeout(200);
    return true;
  }

  async #pasteWithClipboard(text) {
    if (!this.context) {
      return false;
    }
    const origin = new URL(this.page.url()).origin;
    await this.context.grantPermissions(
      ["clipboard-read", "clipboard-write"],
      { origin },
    ).catch(() => null);

    const copied = await this.page.evaluate(async (value) => {
      if (!navigator.clipboard?.read || !navigator.clipboard?.writeText) {
        return false;
      }
      try {
        window.__wtagentPreviousClipboard = await navigator.clipboard.read();
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        delete window.__wtagentPreviousClipboard;
        return false;
      }
    }, text).catch(() => false);
    if (!copied) {
      return false;
    }

    try {
      await this.page.keyboard.press(
        process.platform === "darwin" ? "Meta+V" : "Control+V",
      );
      return true;
    } catch {
      await this.#restoreClipboard();
      return false;
    }
  }

  async #restoreClipboard() {
    if (typeof this.page.evaluate !== "function") {
      return;
    }
    await this.page.evaluate(async () => {
      const previous = window.__wtagentPreviousClipboard;
      delete window.__wtagentPreviousClipboard;
      if (!previous || !navigator.clipboard?.write) {
        return;
      }
      try {
        await navigator.clipboard.write(previous);
      } catch {
        // Best effort only: do not fail a correctly committed prompt if the OS
        // revokes clipboard permission after the paste.
      }
    }).catch(() => null);
  }
}

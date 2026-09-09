import path from "node:path";
import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const GEMINI_URL = "https://gemini.google.com/app";

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

  async messageIdentity(message) {
    const modelContent = message.locator(
      'message-content[id^="message-content-id-"]',
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
      '.query-content[id^="user-query-content-"]',
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
    const markdown = message.locator("message-content .markdown").last();
    if (await markdown.count().catch(() => 0) > 0) {
      const cleaned = await markdown.evaluate((element) => {
        const clone = element.cloneNode(true);
        clone.querySelectorAll(
          "sources-carousel-inline, source-inline-chip, source-footnote, "
            + ".hide-from-message-actions",
        ).forEach((item) => item.remove());
        return clone.innerText;
      }).catch(() => null);
      if (cleaned != null) {
        return cleaned;
      }
      return await markdown.innerText().catch(() => "");
    }
    const content = message.locator("message-content").last();
    if (await content.count().catch(() => 0) > 0) {
      return await content.innerText().catch(() => "");
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
      message.getByRole("button", { name: /^(Copy|复制)$/i }),
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

  async submitComposer(composer) {
    const sendButton = await firstVisible(this.sendButtonLocators());
    if (
      sendButton
      && await sendButton.isEnabled().catch(() => false)
      && await this.#clickWithNativePointer(sendButton)
    ) {
      return;
    }
    await super.submitComposer(composer);
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
    const rowText = await message.innerText().catch(() => "");
    const alert = this.page.locator('[role="alert"], [data-test-id*="toast"]')
      .last();
    // An absent alert is the normal case. Calling innerText() directly on that
    // empty locator consumes the page's full 15-second default timeout after
    // every otherwise-complete Gemini response.
    const alertText = await alert.count().catch(() => 0) > 0
      && await alert.isVisible().catch(() => false)
      ? await alert.innerText().catch(() => "")
      : "";
    const text = [alertText, rowText].filter(Boolean).join(" ");
    return isUsageLimitNotice(text) ? text.trim().slice(0, 160) : null;
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

  async #clickWithNativePointer(locator) {
    await locator.scrollIntoViewIfNeeded().catch(() => null);
    const box = await locator.boundingBox().catch(() => null);
    if (!box || !this.page.mouse) {
      return false;
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y, { steps: 8 });
    await this.page.waitForTimeout(75);
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

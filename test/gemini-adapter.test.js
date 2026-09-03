import test from "node:test";
import assert from "node:assert/strict";
import { GeminiWebAdapter, isConnectionLostError } from "../src/browser/gemini-web-adapter.js";

class EmptyLocator {
  async count() { return 0; }
  nth() { return this; }
  first() { return this; }
  last() { return this; }
  filter() { return this; }
  async isVisible() { return false; }
  async isEnabled() { return true; }
  async innerText() { return ""; }
  async getAttribute() { return null; }
  async waitFor() {}
  async evaluate() { return null; }
  async scrollIntoViewIfNeeded() {}
  locator() { return this; }
  getByRole() { return new EmptyLocator(); }
}

class TextLocator extends EmptyLocator {
  constructor(text, { id = null, visible = true } = {}) {
    super();
    this.text = text;
    this.id = id;
    this.visible = visible;
  }
  async count() { return 1; }
  async isVisible() { return this.visible; }
  async innerText() { return this.text; }
  async getAttribute(name) { return name === "id" ? this.id : null; }
}

class RowCollection extends EmptyLocator {
  constructor(rows) { super(); this.rows = rows; }
  async count() { return this.rows.length; }
  nth(index) { return this.rows[index] ?? new EmptyLocator(); }
  last() { return this.rows.at(-1) ?? new EmptyLocator(); }
}

class GeminiRow extends EmptyLocator {
  constructor({ id, role, text, generating = false, error = null }) {
    super();
    this.id = id;
    this.role = role;
    this.text = text;
    this.generating = generating;
    this.error = error;
  }

  async count() { return 1; }
  async innerText() { return this.text; }

  locator(selector) {
    if (selector === "message-content .markdown") {
      return this.role === "model"
        ? new TextLocator(this.text)
        : new EmptyLocator();
    }
    if (selector.includes("message-content")) {
      return this.role === "model"
        ? new TextLocator(this.text, { id: this.id })
        : new EmptyLocator();
    }
    if (selector.includes("user-query-content")) {
      return this.role === "user"
        ? new TextLocator(this.text, { id: this.id })
        : new EmptyLocator();
    }
    if (selector === '[aria-busy="true"]') {
      return new TextLocator("", { visible: this.generating });
    }
    if (selector.includes("response-footer.complete")
      || selector.includes("regenerate-button")) {
      return new TextLocator("", { visible: !this.generating });
    }
    if (selector.includes("error")) {
      return this.error
        ? new TextLocator(this.error)
        : new EmptyLocator();
    }
    return new EmptyLocator();
  }

  getByRole() {
    return new EmptyLocator();
  }
}

function createGeminiPage(rows, { alert = "" } = {}) {
  const assistant = rows.filter((row) => row.role === "model");
  const user = rows.filter((row) => row.role === "user");
  return {
    async title() { return "Google Gemini"; },
    url() { return "https://gemini.google.com/app/thread-1"; },
    locator(selector) {
      if (selector === "model-response") return new RowCollection(assistant);
      if (selector === "user-query") return new RowCollection(user);
      if (selector === "user-query, model-response") return new RowCollection(rows);
      if (selector.includes('[role="alert"]')) {
        return alert ? new TextLocator(alert) : new EmptyLocator();
      }
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
    async waitForTimeout() {},
  };
}

test("re-exports the shared connection-lost detector", () => {
  assert.equal(
    isConnectionLostError(new Error("Target page, context or browser has been closed")),
    true,
  );
  assert.equal(isConnectionLostError(new Error("nope")), false);
});

test("exposes Gemini's new-chat and saved-conversation URLs", () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Gemini");
  assert.equal(adapter.baseUrl, "https://gemini.google.com/app");
  assert.equal(adapter.conversationUrlPattern().test("/app"), false);
  assert.ok(adapter.conversationUrlPattern().test("/app/38f5d1b168f9c3c5"));
});

test("uses Gemini's content ids as stable message identities", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const model = new GeminiRow({
    id: "message-content-id-r_abcd",
    role: "model",
    text: "hello",
  });
  const user = new GeminiRow({
    id: "user-query-content-0",
    role: "user",
    text: "hi",
  });
  assert.deepEqual(await adapter.messageIdentity(model), {
    id: "message-content-id-r_abcd",
    turn: null,
  });
  assert.deepEqual(await adapter.messageIdentity(user), {
    id: "user-query-content-0",
    turn: null,
  });
});

test("does not wait on an assistant-only selector when identifying a user row", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const user = new GeminiRow({
    id: "user-query-content-7",
    role: "user",
    text: "tool result",
  });
  const originalLocator = user.locator.bind(user);
  user.locator = (selector) => {
    if (selector.includes("message-content")) {
      return {
        first() { return this; },
        async count() { return 0; },
        async getAttribute() {
          assert.fail("getAttribute must not run for an absent model node");
        },
      };
    }
    return originalLocator(selector);
  };

  assert.deepEqual(await adapter.messageIdentity(user), {
    id: "user-query-content-7",
    turn: null,
  });
});

test("reads only Gemini's model message content", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const row = new GeminiRow({
    id: "message-content-id-r_1",
    role: "model",
    text: "<agent_response><done>true</done><message>ok</message></agent_response>",
  });
  assert.equal(
    await adapter.assistantText(row),
    "<agent_response><done>true</done><message>ok</message></agent_response>",
  );
});

test("uses Gemini's busy state and response action icon as completion signals", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(await adapter.isAssistantGenerating(new GeminiRow({
    id: "streaming",
    role: "model",
    text: "partial",
    generating: true,
  })), true);
  assert.equal(await adapter.isAssistantGenerating(new GeminiRow({
    id: "done",
    role: "model",
    text: "complete",
  })), false);
});

test("completes a Gemini turn once the new model row is finished", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const envelope = "<agent_response><done>true</done><message>gemini done</message></agent_response>";
  adapter.page = createGeminiPage([
    new GeminiRow({ id: "user-query-content-0", role: "user", text: "task" }),
    new GeminiRow({ id: "message-content-id-r_1", role: "model", text: envelope }),
  ]);

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });
  assert.equal(result, envelope);
  assert.equal(await adapter.getLastAssistantMessageId(), "message-content-id-r_1");
});

test("does not accept a model row captured before the send", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  adapter.page = createGeminiPage([
    new GeminiRow({ id: "message-content-id-r_old", role: "model", text: "old answer" }),
  ]);
  adapter.assistantIdsBeforeSend = new Set(["message-content-id-r_old"]);

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 40,
      stableWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("detects Google Accounts sign-in paths without matching Gemini chat", () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  assert.ok(adapter.authUrlPattern().test("/v3/signin/identifier"));
  assert.ok(adapter.authUrlPattern().test("/ServiceLogin"));
  assert.equal(adapter.authUrlPattern().test("/app"), false);
});

test("surfaces a structural Gemini generation error", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const row = new GeminiRow({
    id: "message-content-id-r_error",
    role: "model",
    text: "Something went wrong",
    error: "Something went wrong. Try again.",
  });
  adapter.page = createGeminiPage([row]);

  assert.equal(
    await adapter.findGenerationErrorMarker(row),
    "Something went wrong. Try again.",
  );
});

test("does not read innerText from an absent Gemini alert", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const absentAlert = {
    last() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async innerText() {
      assert.fail("innerText must not run for an absent alert");
    },
  };
  adapter.page = { locator() { return absentAlert; } };
  const row = new GeminiRow({
    id: "message-content-id-r_1",
    role: "model",
    text: "normal response",
  });

  assert.equal(await adapter.findUsageLimitMarker(row), null);
});

test("rejects a completed Gemini error turn instead of returning it", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const row = new GeminiRow({
    id: "message-content-id-r_error",
    role: "model",
    text: "Something went wrong",
    error: "Something went wrong. Try again.",
  });
  adapter.page = createGeminiPage([row]);

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 2_000,
      stableWindowMs: 0,
      staleStopWindowMs: 0,
    }),
    (error) => error.code === "GENERATION_FAILED"
      && /Something went wrong/i.test(error.message),
  );
});

test("uploads attachments through Gemini's file input", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  let uploaded = null;
  let waited = false;
  const input = {
    first() { return this; },
    async count() { return 1; },
    async setInputFiles(paths) { uploaded = paths; },
  };
  const marker = {
    async count() { return 0; },
    nth() { return this; },
    async isVisible() { return false; },
    filter() { return this; },
    first() { return this; },
    async waitFor() { waited = true; },
  };
  adapter.page = {
    locator(selector) {
      if (selector === 'input[type="file"]') return input;
      return marker;
    },
  };

  const result = await adapter.attachFiles([
    "/tmp/gemini-a.txt",
    { path: "/tmp/gemini-b.png" },
  ]);
  assert.deepEqual(uploaded, ["/tmp/gemini-a.txt", "/tmp/gemini-b.png"]);
  assert.equal(waited, true);
  assert.deepEqual(result, {
    attached: ["/tmp/gemini-a.txt", "/tmp/gemini-b.png"],
    failed: [],
  });
});

test("clicks Gemini's visible Upload files menu item and handles its filechooser", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const events = [];
  let menuOpened = false;
  const emptyInput = new EmptyLocator();
  const menu = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return true; },
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return null; },
    async click() {
      menuOpened = true;
      events.push("menu-click");
    },
  };
  const uploadFiles = {
    first() { return this; },
    async waitFor() { events.push("upload-files-visible"); },
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return null; },
    async click() { events.push("upload-files-click"); },
  };
  const marker = {
    async count() { return 0; },
    nth() { return this; },
    async isVisible() { return false; },
    filter() { return this; },
    first() { return this; },
    async waitFor() { events.push("filename-visible"); },
  };
  adapter.page = {
    locator(selector) {
      if (selector === 'input[type="file"]') return emptyInput;
      if (selector.includes("local-images-files-uploader-button")) {
        assert.equal(menuOpened, true);
        return uploadFiles;
      }
      return marker;
    },
    getByRole() { return menu; },
    async waitForEvent(name) {
      assert.equal(name, "filechooser");
      return {
        async setFiles(paths) { events.push(["set-files", paths]); },
      };
    },
  };

  const result = await adapter.attachFiles(["/tmp/gemini-note.txt"]);
  assert.deepEqual(result, {
    attached: ["/tmp/gemini-note.txt"],
    failed: [],
  });
  assert.deepEqual(events, [
    "menu-click",
    "upload-files-visible",
    "upload-files-click",
    ["set-files", ["/tmp/gemini-note.txt"]],
    "filename-visible",
  ]);
});

test("uses native pointer focus and keyboard input for Gemini sends", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const events = [];
  let currentValue = "";
  const composer = {
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return { x: 10, y: 20, width: 100, height: 40 }; },
    async evaluate(callback) {
      return String(callback).includes("document.activeElement")
        ? true
        : currentValue;
    },
    async focus() {},
    async fill(text) { currentValue = text; },
  };
  const sendButton = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return { x: 200, y: 40, width: 60, height: 30 }; },
  };
  adapter.page = {
    url() { return "https://gemini.google.com/app"; },
    locator(selector) {
      if (selector.includes('button[aria-label="发送"]')) return sendButton;
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
    keyboard: {
      async press(key) { events.push(["press", key]); },
      async insertText(text) {
        currentValue = text;
        events.push(["insertText", text]);
      },
    },
    mouse: {
      async move(x, y, options) { events.push(["move", x, y, options.steps]); },
      async down() { events.push(["down"]); },
      async up() { events.push(["up"]); },
    },
    async evaluate() { return false; },
    async waitForTimeout(ms) { events.push(["wait", ms]); },
  };

  await adapter.fillComposer(composer, "hello");
  await adapter.submitComposer(composer);

  assert.deepEqual(events.filter(([type]) => type === "insertText"), [
    ["insertText", "hello"],
  ]);
  assert.equal(events.filter(([type]) => type === "down").length, 2);
  assert.equal(events.filter(([type]) => type === "up").length, 2);
  assert.deepEqual(events.filter(([type]) => type === "move"), [
    ["move", 60, 40, 8],
    ["move", 230, 55, 8],
  ]);
  const insertIndex = events.findIndex(([type]) => type === "insertText");
  assert.equal(events[insertIndex - 1][0], "wait");
  assert.ok(events[insertIndex - 1][1] >= 0 && events[insertIndex - 1][1] <= 1_000);
  assert.equal(events[insertIndex + 1][0], "wait");
  assert.ok(events[insertIndex + 1][1] >= 0 && events[insertIndex + 1][1] <= 2_000);
});

test("accepts Quill's NBSP representation of leading indentation", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  // Include a surrogate pair before the indentation so the position check is
  // verified in JavaScript string indexes, not code-point-array indexes.
  const expected = "🚀<agent_response>\n  <done>true</done>\n</agent_response>";
  let currentValue = "";
  let fillCalls = 0;
  const composer = {
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return { x: 0, y: 0, width: 100, height: 40 }; },
    async evaluate(callback) {
      return String(callback).includes("document.activeElement")
        ? true
        : currentValue;
    },
    async focus() {},
    async fill(text) {
      fillCalls += 1;
      currentValue += text;
    },
  };
  adapter.page = {
    url() { return "https://gemini.google.com/app"; },
    keyboard: {
      async press() {},
      async insertText(text) {
        currentValue = text.replace("\n  <done>", "\n\u00a0 <done>");
      },
    },
    mouse: {
      async move() {},
      async down() {},
      async up() {},
    },
    async evaluate() { return false; },
    async waitForTimeout() {},
  };

  await adapter.fillComposer(composer, expected);
  assert.equal(fillCalls, 0);
  assert.equal(currentValue.includes("\u00a0"), true);
});

test("clears Gemini's composer before a fallback fill", async () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  const expected = "complete prompt";
  let currentValue = "";
  let selectAll = false;
  const events = [];
  const composer = {
    async scrollIntoViewIfNeeded() {},
    async boundingBox() { return { x: 0, y: 0, width: 100, height: 40 }; },
    async evaluate(callback) {
      return String(callback).includes("document.activeElement")
        ? true
        : currentValue;
    },
    async focus() { events.push("focus"); },
    async fill(text) {
      currentValue += text;
      events.push("fill");
    },
  };
  adapter.page = {
    url() { return "https://gemini.google.com/app"; },
    keyboard: {
      async press(key) {
        events.push(key);
        if (key === "Meta+A" || key === "Control+A") selectAll = true;
        if (key === "Backspace" && selectAll) {
          currentValue = "";
          selectAll = false;
        }
      },
      async insertText() { currentValue = "partial"; },
    },
    mouse: {
      async move() {},
      async down() {},
      async up() {},
    },
    async evaluate() { return false; },
    async waitForTimeout() {},
  };

  await adapter.fillComposer(composer, expected);
  assert.equal(currentValue, expected);
  assert.ok(events.includes("Backspace"));
  assert.ok(events.includes("fill"));
});

test("Gemini adapter never selects a model automatically", () => {
  const adapter = new GeminiWebAdapter({ profileDir: "." });
  assert.equal(typeof adapter.selectMode, "undefined");
});

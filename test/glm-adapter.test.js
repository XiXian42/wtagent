import test from "node:test";
import assert from "node:assert/strict";
import { GLMWebAdapter } from "../src/browser/glm-web-adapter.js";
import { isConnectionLostError } from "../src/browser/glm-web-adapter.js";

// Minimal Playwright-locator doubles, mirroring test/kimi-adapter.test.js.
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
  locator() { return this; }
  getByRole() { return new EmptyLocator(); }
}

// One GLM (Open WebUI) message row: id="message-<uuid>", user rows carry the
// user-message class. `generating` models the action bar: GLM renders
// .copy-response-button / .regenerate-response-button under an assistant reply
// only after it has fully finished streaming; completed rows default to
// generating=false (bar present).
class GLMRow extends EmptyLocator {
  constructor({ id, role, text, generating = false }) {
    super();
    this.id = id;
    this.role = role;
    this.text = text;
    this.generating = generating;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    return name === "id" ? `message-${this.id}` : null;
  }

  locator(selector) {
    if (selector === ".copy-response-button, .regenerate-response-button") {
      const generating = this.generating;
      return {
        async count() { return generating ? 0 : 1; },
      };
    }
    return new EmptyLocator();
  }
}

class RowCollection extends EmptyLocator {
  constructor(rows) { super(); this.rows = rows; }
  async count() { return this.rows.length; }
  nth(index) { return this.rows[index] ?? new EmptyLocator(); }
  last() { return this.rows.at(-1) ?? new EmptyLocator(); }
}

function createGLMPage(rows) {
  const assistant = rows.filter((r) => r.role === "assistant");
  const user = rows.filter((r) => r.role === "user");
  return {
    async title() { return "GLM"; },
    locator(selector) {
      if (selector.includes(":not(.user-message)")) return new RowCollection(assistant);
      if (selector.includes(".user-message")) return new RowCollection(user);
      if (selector.includes('[id^="message-"]')) return new RowCollection(rows);
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

test("exposes GLM's base URL and conversation URL pattern", () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "GLM");
  assert.equal(adapter.baseUrl, "https://chat.z.ai/");
  assert.ok(adapter.conversationUrlPattern().test("/c/5d0e8c71-uuid"));
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("reads a stable per-message id from the message- element id", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  const row = new GLMRow({ id: "abc-123", role: "assistant", text: "hi" });
  assert.deepEqual(await adapter.messageIdentity(row), { id: "abc-123", turn: null });
});

test("assistantText returns full text so the parser can find the envelope past a 思考过程 prefix", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  const row = new GLMRow({
    id: "m1",
    role: "assistant",
    text: "思考过程 <agent_response><done>true</done><message>ok</message></agent_response>",
  });
  const text = await adapter.assistantText(row);
  assert.match(text, /思考过程/);
  assert.match(text, /<agent_response>/);
  assert.match(text, /<\/agent_response>/);
});

test("generation is detected structurally via the response action bar", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  // No action bar yet (thinking phase / mid-stream / blank row) = generating.
  const thinking = new GLMRow({ id: "a1", role: "assistant", text: "思考过程", generating: true });
  assert.equal(await adapter.isAssistantGenerating(thinking), true);

  const blank = new GLMRow({ id: "a0", role: "assistant", text: "", generating: true });
  assert.equal(await adapter.isAssistantGenerating(blank), true);

  // Action bar present = finished, regardless of the text's language.
  const ready = new GLMRow({
    id: "a2",
    role: "assistant",
    text: "思考过程 <agent_response><done>true</done><message>ok</message></agent_response>",
    generating: false,
  });
  assert.equal(await adapter.isAssistantGenerating(ready), false);
});

test("does not complete a turn while the action bar is absent (still generating)", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createGLMPage([
    new GLMRow({ id: "u1", role: "user", text: "the question" }),
    new GLMRow({ id: "a1", role: "assistant", text: "思考过程", generating: true }),
  ]);
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = null;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 80,
      stableWindowMs: 0,
      staleStopWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("completes once the envelope has streamed in and the action bar is present", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createGLMPage([
    new GLMRow({ id: "u1", role: "user", text: "the question" }),
    new GLMRow({
      id: "a1",
      role: "assistant",
      text: "思考过程 <agent_response><done>true</done><message>glm done</message></agent_response>",
      generating: false,
    }),
  ]);
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = null;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });
  assert.match(result, /<message>glm done<\/message>/);
  assert.equal(await adapter.getLastAssistantMessageId(), "a1");
});

test("detects GLM's signed-out shell as unauthenticated text", () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  assert.ok(adapter.authTextPattern().test("手机号登录 欢迎回来"));
  assert.ok(adapter.authTextPattern().test("发送验证码"));
  assert.ok(adapter.authTextPattern().test("Sign in to Z.ai"));
  assert.equal(adapter.authTextPattern().test("有什么我能帮您的？"), false);
  // The /auth URL is the locale-independent signal.
  assert.ok(adapter.authUrlPattern().test("/auth"));
});

test("generation detection does not depend on the reply's language", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  // English thinking text, no action bar yet → generating (no text matching).
  const thinking = new GLMRow({ id: "a3", role: "assistant", text: "Thinking", generating: true });
  assert.equal(await adapter.isAssistantGenerating(thinking), true);

  // Japanese text, action bar present → finished (no text matching).
  const done = new GLMRow({
    id: "a4",
    role: "assistant",
    text: "推論 <agent_response><done>true</done><message>ok</message></agent_response>",
    generating: false,
  });
  assert.equal(await adapter.isAssistantGenerating(done), false);
});

test("widens the dead-request grace (deep-thinking, no persistent stop button)", () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  assert.ok(adapter.deadRequestGraceMultiplier() > 1);
});

// --- model selection (latest: GLM-5.3 else GLM-5.2) ---------------------

class Switcher {
  constructor(label) { this.label = label; this.clicks = 0; }
  async count() { return 1; }
  first() { return this; }
  async waitFor() {}
  async innerText() { return this.label; }
  async click() { this.clicks += 1; }
}

// getByText(model, {exact}) returns a clickable whose presence depends on the
// set of models the page exposes; clicking it updates the switcher label.
class Option {
  constructor(page, model, present) { this.page = page; this.model = model; this.present = present; }
  first() { return this; }
  async count() { return this.present ? 1 : 0; }
  async click() { if (this.present) this.page.switcher.label = this.model; }
}

function createModelPage({ current = "GLM-5.2", available = ["GLM-5.2", "GLM-5.1"] } = {}) {
  const switcher = new Switcher(current);
  const clicks = [];
  const page = {
    switcher,
    clicks,
    async waitForTimeout() {},
    keyboard: { async press() {} },
    mouse: {
      async click(x, y) { clicks.push({ x, y }); },
    },
    viewportSize() { return { width: 1280, height: 800 }; },
    locator(selector) {
      if (selector === "button.modelSelectorButton") return switcher;
      return { async count() { return 0; }, first() { return this; } };
    },
    getByText(model) {
      return new Option(page, model, available.includes(model));
    },
  };
  return page;
}

test("selectMode('latest') picks GLM-5.3 when present", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ current: "GLM-5.2", available: ["GLM-5.3", "GLM-5.2"] });

  const result = await adapter.selectMode("latest");
  assert.equal(result.status, "select");
  assert.equal(result.selectedLabel, "GLM-5.3");
  assert.equal(adapter.page.switcher.label, "GLM-5.3");
  assert.deepEqual(adapter.page.clicks, [{ x: 640, y: 400 }]);
});

test("selectMode('latest') falls back to GLM-5.2 when 5.3 is absent", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ current: "GLM-5.1", available: ["GLM-5.2", "GLM-5.1"] });

  const result = await adapter.selectMode("latest");
  assert.equal(result.status, "select");
  assert.equal(result.selectedLabel, "GLM-5.2");
  assert.equal(adapter.page.switcher.label, "GLM-5.2");
});

test("selectMode('latest') is a no-op when already on the top preferred model", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createModelPage({ current: "GLM-5.3", available: ["GLM-5.3", "GLM-5.2"] });

  const result = await adapter.selectMode("latest");
  assert.equal(result.status, "already");
  assert.equal(adapter.page.switcher.clicks, 0);
});

test("selectMode ignores non-latest modes (keeps current)", async () => {
  const adapter = new GLMWebAdapter({ profileDir: "." });
  adapter.page = createModelPage();
  const result = await adapter.selectMode(null);
  assert.equal(result.status, "skipped");
  assert.equal(adapter.page.switcher.clicks, 0);
});

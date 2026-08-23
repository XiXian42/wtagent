import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekWebAdapter } from "../src/browser/deepseek-web-adapter.js";
import { isConnectionLostError } from "../src/browser/deepseek-web-adapter.js";

// Minimal Playwright-locator doubles, mirroring test/browser-adapter.test.js.
// Only the surface the base turn-completion loop touches is implemented.
class EmptyLocator {
  async count() {
    return 0;
  }

  nth() {
    return this;
  }

  first() {
    return this;
  }

  last() {
    return this;
  }

  async isVisible() {
    return false;
  }

  async isEnabled() {
    return true;
  }

  async innerText() {
    return "";
  }

  async getAttribute() {
    return null;
  }

  locator() {
    return this;
  }

  getByRole() {
    return new EmptyLocator();
  }
}

// One DeepSeek message row: carries the virtual-list key and, for assistant
// rows, a `.ds-assistant-message-main-content` child holding the reply text.
// `generating` models the action bar: DeepSeek renders the
// ds-button--iconLabelTertiary action buttons under a reply only once it has
// fully finished streaming; completed rows default to generating=false.
class DeepSeekRow extends EmptyLocator {
  constructor({ key, role, text, thinkOnly = false, generating = false }) {
    super();
    this.key = key;
    this.role = role;
    this.text = text;
    this.thinkOnly = thinkOnly;
    this.generating = generating;
  }

  async innerText() {
    return this.text;
  }

  async getAttribute(name) {
    return name === "data-virtual-list-item-key" ? String(this.key) : null;
  }

  locator(selector) {
    if (this.role !== "assistant") {
      return new EmptyLocator();
    }
    if (selector === '[role="button"].ds-button--iconLabelTertiary') {
      const generating = this.generating;
      return {
        async count() {
          return generating ? 0 : 1;
        },
      };
    }
    const wantsMain = selector.includes(".ds-assistant-message-main-content");
    const wantsThink = selector.includes(".ds-think-content");
    const match = this.thinkOnly ? wantsThink && !wantsMain : wantsMain;
    if (!match) {
      return new EmptyLocator();
    }
    const text = this.text;
    return {
      async count() {
        return 1;
      },
      last() {
        return { async innerText() { return text; } };
      },
    };
  }
}

class RowCollection extends EmptyLocator {
  constructor(rows) {
    super();
    this.rows = rows;
  }

  async count() {
    return this.rows.length;
  }

  nth(index) {
    return this.rows[index] ?? new EmptyLocator();
  }

  last() {
    return this.rows.at(-1) ?? new EmptyLocator();
  }
}

function createDeepSeekPage(rows) {
  const assistant = rows.filter((r) => r.role === "assistant");
  const user = rows.filter((r) => r.role === "user");
  return {
    async title() {
      return "DeepSeek";
    },
    locator(selector) {
      if (selector.includes(".ds-assistant-message-main-content") && !selector.includes(":not(")) {
        return new RowCollection(assistant);
      }
      if (selector.includes(":not(:has(.ds-assistant-message-main-content))")) {
        return new RowCollection(user);
      }
      if (selector === "[data-virtual-list-item-key]") {
        return new RowCollection(rows);
      }
      return new EmptyLocator();
    },
    getByRole() {
      return new EmptyLocator();
    },
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

test("exposes DeepSeek's base URL and conversation URL pattern", () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "DeepSeek");
  assert.equal(adapter.baseUrl, "https://chat.deepseek.com/");
  assert.ok(adapter.conversationUrlPattern().test("/a/chat/s/4fc00a96-uuid"));
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("identity is a role-scoped count, immune to the volatile row key", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // Two assistant rows + one user row. The row key is deliberately volatile
  // (even negative) — identity must ignore it and report the role-scoped count.
  adapter.page = createDeepSeekPage([
    new DeepSeekRow({ key: -3, role: "assistant", text: "a1" }),
    new DeepSeekRow({ key: 99, role: "user", text: "u1" }),
    new DeepSeekRow({ key: -1, role: "assistant", text: "a2" }),
  ]);
  const assistantRow = new DeepSeekRow({ key: -1, role: "assistant", text: "a2" });
  const userRow = new DeepSeekRow({ key: 99, role: "user", text: "u1" });
  assert.deepEqual(await adapter.messageIdentity(assistantRow), { id: null, turn: 2 });
  assert.deepEqual(await adapter.messageIdentity(userRow), { id: null, turn: 1 });
});

test("generation is detected structurally via the reply action bar", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // Think-only phase: no action bar yet → generating (no text matching).
  const thinking = new DeepSeekRow({
    key: 7,
    role: "assistant",
    thinkOnly: true,
    text: "思考中",
    generating: true,
  });
  assert.equal(await adapter.isAssistantGenerating(thinking), true);

  // Action bar present → finished, regardless of the reply's language.
  const finished = new DeepSeekRow({
    key: 8,
    role: "assistant",
    text: "已思考（用时 11 秒）\n<tool_calls><invoke name=\"fs.read\"></invoke></tool_calls>",
    generating: false,
  });
  assert.equal(await adapter.isAssistantGenerating(finished), false);
});

test("reads assistant text from the assistant content node", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  const row = new DeepSeekRow({
    key: 6,
    role: "assistant",
    text: "<agent_response><done>true</done><message>done</message></agent_response>",
  });
  const text = await adapter.assistantText(row);
  assert.match(text, /<agent_response>/);
});

test("completes a turn once the assistant count grows past the baseline", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // One assistant row existed before this send (count baseline = 1); the new
  // reply makes it 2, so the count-based identity marks it new.
  adapter.page = createDeepSeekPage([
    new DeepSeekRow({ key: 4, role: "assistant", text: "old reply" }),
    new DeepSeekRow({ key: 5, role: "user", text: "the question" }),
    new DeepSeekRow({
      key: 6,
      role: "assistant",
      text: "<agent_response><done>true</done><message>new</message></agent_response>",
    }),
  ]);
  adapter.assistantCountBeforeSend = 1;

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });

  assert.match(result, /<message>new<\/message>/);
  assert.doesNotMatch(result, /old reply/);
});

test("treats a reused last assistant row with new XML as a new turn", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  adapter.page = createDeepSeekPage([
    new DeepSeekRow({
      key: 6,
      role: "assistant",
      text: "<agent_response><done>false</done><message>next</message>"
        + "<tool_call name=\"fs.read\"><args><path>package.json</path></args></tool_call>"
        + "</agent_response>",
    }),
  ]);
  adapter.assistantCountBeforeSend = 1;
  adapter.lastAssistantTextBeforeSend = "<agent_response>old readme call</agent_response>";

  const result = await adapter.waitForTurnComplete({
    timeoutMs: 2_000,
    stableWindowMs: 0,
    staleStopWindowMs: 0,
  });
  assert.match(result, /package.json/);
});

test("does not accept a stale prior reply as the current turn", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // Only the old assistant reply is present and the count has NOT grown beyond
  // the baseline (1), so the wait must time out rather than return the stale
  // answer — the count-based guard against stale replies.
  adapter.page = createDeepSeekPage([
    new DeepSeekRow({
      key: 4,
      role: "assistant",
      text: "<agent_response><done>true</done><message>old</message></agent_response>",
    }),
  ]);
  adapter.assistantCountBeforeSend = 1;
  adapter.sentUserTurn = 5;

  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 30,
      stableWindowMs: 0,
      staleStopWindowMs: 0,
      deadRequestGraceMs: 10_000,
    }),
    (error) => error.code === "TURN_TIMEOUT",
  );
});

test("detects DeepSeek's signed-out shell as unauthenticated text", () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  assert.ok(adapter.authTextPattern().test("发送验证码 登录"));
  assert.ok(adapter.authTextPattern().test("使用 Apple 账号登录"));
  assert.equal(adapter.authTextPattern().test("给 DeepSeek 发送消息"), false);
});

test("widens the dead-request grace for the no-stop-signal Deep Thinking phase", () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // DeepSeek exposes no liveness signal, so it must wait far longer than the
  // base default before treating silence as a dead request.
  assert.ok(adapter.deadRequestGraceMultiplier() > 1);
});

test("a long silent thinking phase is not misread as a dead request", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // No assistant row yet (still thinking), no stop button ever visible.
  adapter.page = createDeepSeekPage([
    new DeepSeekRow({ key: 5, role: "user", text: "the question" }),
  ]);
  adapter.assistantIdsBeforeSend = new Set();
  adapter.assistantMaxTurnBeforeSend = null;
  adapter.sentUserTurn = 5;

  // With base deadRequestGraceMs=100ms and DeepSeek's >1 multiplier, a wait
  // that exceeds 100ms but is far under the multiplied grace must NOT raise
  // DEAD_ASSISTANT_REQUEST — it should time out on the overall budget instead.
  await assert.rejects(
    adapter.waitForTurnComplete({
      timeoutMs: 350,
      stableWindowMs: 0,
      deadRequestGraceMs: 100,
    }),
    (error) => {
      assert.equal(error.code, "TURN_TIMEOUT");
      return true;
    },
  );
});

// Stateful control doubles for mode selection: a chip tracks aria-checked, a
// toggle tracks the ds-toggle-button--selected class; clicking flips state.
class ModeControl {
  constructor({ kind, label, on, group }) {
    this.kind = kind; // "chip" | "toggle"
    this.label = label;
    this.on = on;
    this.group = group; // shared array of same-group chips for radio exclusivity
    this.clicks = 0;
  }

  async count() {
    return 1;
  }

  first() {
    return this;
  }

  async innerText() {
    return this.label;
  }

  async getAttribute(name) {
    if (this.kind === "chip" && name === "aria-checked") {
      return this.on ? "true" : "false";
    }
    if (name === "class") {
      return this.kind === "toggle"
        ? `ds-toggle-button ds-toggle-button--m${this.on ? " ds-toggle-button--selected" : ""}`
        : "_9f2341b";
    }
    return null;
  }

  async click() {
    this.clicks += 1;
    if (this.kind === "chip") {
      for (const peer of this.group) peer.on = peer === this;
    } else {
      this.on = !this.on;
    }
  }
}

function createModePage({ expertChecked = false, thinkingOn = false } = {}) {
  const chipGroup = [];
  const fast = new ModeControl({ kind: "chip", label: "快速模式", on: !expertChecked, group: chipGroup });
  const expert = new ModeControl({ kind: "chip", label: "专家模式", on: expertChecked, group: chipGroup });
  chipGroup.push(fast, expert);
  const thinking = new ModeControl({ kind: "toggle", label: "深度思考", on: thinkingOn });
  const webSearch = new ModeControl({ kind: "toggle", label: "智能搜索", on: false });
  const controls = { expert, fast, thinking };

  const page = {
    controls,
    async waitForTimeout() {},
    locator(selector, options = {}) {
      // The adapter queries whole collections (no hasText) and scans them:
      // chips by visible label / position, toggles by count.
      if (selector === '[role="radio"]') {
        return {
          async count() { return chipGroup.length; },
          nth(index) { return chipGroup[index]; },
        };
      }
      if (selector === ".ds-toggle-button") {
        // Expert mode shows exactly one toggle; fast mode shows two.
        const toggles = expert.on ? [thinking] : [thinking, webSearch];
        return {
          async count() { return toggles.length; },
          nth(index) { return toggles[index]; },
        };
      }
      return { async count() { return 0; }, first() { return this; } };
    },
  };
  return page;
}

test("selectMode silently applies 专家模式 + 深度思考 from a fresh (fast) conversation", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  adapter.page = createModePage({ expertChecked: false, thinkingOn: false });

  const result = await adapter.selectMode("expert-thinking");

  assert.equal(result.status, "select");
  assert.match(result.selectedLabel, /expert.*deep-thinking/i);
  assert.equal(adapter.page.controls.expert.on, true);
  assert.equal(adapter.page.controls.thinking.on, true);
  // Each control was clicked exactly once (it was off).
  assert.equal(adapter.page.controls.expert.clicks, 1);
  assert.equal(adapter.page.controls.thinking.clicks, 1);
});

test("selectMode is idempotent when already on 专家模式 + 深度思考", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  adapter.page = createModePage({ expertChecked: true, thinkingOn: true });

  const result = await adapter.selectMode("expert-thinking");

  assert.equal(result.status, "select");
  // No clicks needed — both were already in the desired state.
  assert.equal(adapter.page.controls.expert.clicks, 0);
  assert.equal(adapter.page.controls.thinking.clicks, 0);
  assert.equal(adapter.page.controls.expert.on, true);
  assert.equal(adapter.page.controls.thinking.on, true);
});

test("selectMode ignores non-expert-thinking modes (keeps current)", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  adapter.page = createModePage();

  const result = await adapter.selectMode(null);
  assert.equal(result.status, "skipped");
  assert.equal(adapter.page.controls.expert.clicks, 0);
});

test("selectMode reports unresolved when a control is missing", async () => {
  const adapter = new DeepSeekWebAdapter({ profileDir: "." });
  // A page missing the 深度思考 toggle (UI drift) — expert still selects, but the
  // toggle cannot be confirmed, so the result is unresolved (never throws).
  const expert = new ModeControl({ kind: "chip", label: "专家模式", on: true, group: [] });
  adapter.page = {
    async waitForTimeout() {},
    locator(selector) {
      if (selector === '[role="radio"]') {
        return {
          async count() { return 1; },
          nth() { return expert; },
        };
      }
      return { async count() { return 0; }, first() { return this; } };
    },
  };

  const result = await adapter.selectMode("expert-thinking");
  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /deep-thinking-toggle/);
});

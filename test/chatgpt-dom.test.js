import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeChatGPTDom } from "../src/browser/chatgpt-dom.js";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { discoverChromeExecutable } from "../src/platform/chrome-discovery.js";
import { ChatGPTWebAdapter } from "../src/browser/chatgpt-web-adapter.js";

const outboundId = "f67c046a-ab28-41e8-a04c-79a99806dafa";
const response = "<agent_response><assistant_message>OK</assistant_message><task_complete>true</task_complete></agent_response>";
const userText = `Transport test\n<system_reminder>Opaque WTAgent transport correlation ID (do not repeat): ${outboundId}.</system_reminder>`;
const fixture = (name) => fs.readFile(new URL(`./fixtures/chatgpt/${name}.html`, import.meta.url), "utf8");
const modernRows = await fixture("modern");

test("ChatGPT recognizes both temporary route families", () => {
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  for (const route of ["WEB:test", "local-chatgpt:test", "local-chatgpt%3Atest", "local-chatgpt%3atest"]) {
    assert.equal(adapter.classifyConversationUrl(`https://chatgpt.com/c/${route}`), "provisional");
  }
  assert.equal(adapter.classifyConversationUrl("https://chatgpt.com/c/canonical-id"), "restorable");
});

test("ChatGPT real DOM supports modern identities and strict recovery", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("https://chatgpt.com/c/dom-fixture");
  const adapter = new ChatGPTWebAdapter({ profileDir: "." });
  adapter.page = page;
  adapter.context = page.context();
  adapter.cdpChrome = { targetId: "fixture-target", exactTargetOnly: true };

  await t.test("reads modern roles, stable IDs, and turn groups without using block offsets", async () => {
    await page.setContent(modernRows);
    assert.equal(await adapter.userMessages().count(), 1);
    assert.equal(await adapter.assistantMessages().count(), 1);
    assert.deepEqual((await adapter.orderedConversationSnapshot()).entries.map(({ role, id, turn }) => ({ role, id, turn })), [
      { role: "user", id: "user-1", turn: 1 },
      { role: "assistant", id: "assistant-1", turn: 2 },
    ]);
    assert.equal((await adapter.userMessageSnapshot())[0].renderedText, userText);
    assert.deepEqual(await adapter.messageIdentity(adapter.assistantMessages().first()), { id: "assistant-1", turn: 2 });
    const recovered = await adapter.reconcilePendingOutbound({
      pendingOutbound: { kind: "bootstrap", outboundId },
      conversationTargetId: "fixture-target", timeoutMs: 3000, stableWindowMs: 10,
    });
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.rawResponse, response);
    assert.equal(recovered.userMessageId, "user-1");
    assert.equal(recovered.assistantMessageId, "assistant-1");
  });

  await t.test("does not double count legacy messages inside modern wrappers", async () => {
    await page.setContent(await fixture("mixed"));
    assert.equal(await adapter.userMessages().count(), 1);
    assert.equal(await adapter.assistantMessages().count(), 1);
    assert.deepEqual((await adapter.orderedConversationSnapshot()).entries.map(({ id, turn }) => ({ id, turn })), [
      { id: "user-1", turn: 0 }, { id: "assistant-1", turn: 1 },
    ]);
  });

  await t.test("refuses ambiguous modern message IDs", async () => {
    await page.setContent(modernRows.replace('data-chatgpt-search-message-ids="user-1"', 'data-chatgpt-search-message-ids="user-1 user-other"'));
    assert.equal((await adapter.orderedConversationSnapshot()).entries[0].id, null);
    await assert.rejects(adapter.reconcilePendingOutbound({
      pendingOutbound: { kind: "bootstrap", outboundId },
      conversationTargetId: "fixture-target", timeoutMs: 100, stableWindowMs: 10,
    }), { code: "OUTBOUND_COMMIT_UNCERTAIN" });
  });
});

test("structural reports distinguish missing identity from empty history without leaking content", () => {
  const report = summarizeChatGPTDom({
    entries: [{ role: "assistant", id: null, turn: null, renderedText: "PRIVATE RESPONSE" }],
    structure: { legacy: 0, modern: 1, unknown: 0, ambiguousIds: 1 },
    capabilities: { composers: [], unknownSearchUnits: 1 },
  });
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.missing, { role: 0, id: 1, turn: 1 });
  assert.ok(report.issues.includes("ambiguous-message-ids"));
  assert.ok(report.issues.includes("composer-not-found"));
  assert.ok(report.issues.includes("unknown-search-unit-format"));
  assert.ok(!JSON.stringify(report).includes("PRIVATE RESPONSE"));
  assert.equal(summarizeChatGPTDom(null).status, "unavailable");
  assert.equal(summarizeChatGPTDom({ entries: [] }).status, "empty");
});

test("diagnostic collection is bounded when CDP hangs and does not mask failures", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-diagnostics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapter = new ChatGPTWebAdapter({ profileDir: path.join(directory, "profile") });
  adapter.page = { evaluate: () => new Promise(() => {}) };
  adapter.activeSendProof = { stage: "submit", submittedAt: adapter.monotonicNow() };
  adapter.lastSendStatus = "commit-unknown";
  const started = Date.now();
  const result = await adapter.writeDiagnostics("send-commit-unknown", { text: "PRIVATE PROMPT" });
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.report.dom.status, "timeout");
  assert.equal(result.report.stage, "submit");
  assert.equal(result.report.sendStatus, "commit-unknown");
  const report = await fs.readFile(result.filename, "utf8");
  assert.ok(!report.includes("PRIVATE PROMPT"));
  assert.deepEqual((await fs.readdir(path.join(directory, "diagnostics"))).map((file) => path.extname(file)), [".json"]);
});

test("offline ChatGPT fixtures exercise capabilities and failure diagnostics", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("https://chatgpt.com/c/fixture?private-query=secret");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-dom-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapter = new ChatGPTWebAdapter({ profileDir: path.join(directory, "profile") });
  adapter.page = page;
  adapter.context = page.context();
  adapter.cdpChrome = { targetId: "fixture-target", exactTargetOnly: true };

  for (const [name, roles, turns, status] of [
    ["legacy", ["user", "assistant"], [0, 1], "recognized"],
    ["modern", ["user", "assistant"], [1, 2], "recognized"],
    ["mixed", ["user", "assistant"], [0, 1], "recognized"],
    ["generating", ["user", "assistant"], [1, 2], "incomplete"],
    ["error", ["user"], [1], "recognized"],
    ["virtualized", ["user", "assistant"], [51, 52], "recognized"],
    ["unknown", [null], [null], "incomplete"],
  ]) {
    await t.test(name, async () => {
      await page.setContent(await fixture(name));
      const snapshot = await adapter.orderedConversationSnapshot();
      assert.deepEqual(snapshot.entries.map((entry) => entry.role), roles);
      assert.deepEqual(snapshot.entries.map((entry) => entry.turn), turns);
      const report = await adapter.structuralDiagnostics();
      assert.equal(report.status, status);
      assert.equal(report.capabilities.stopButton, name === "generating");
      if (name === "error") assert.equal(await adapter.assistantMessages().count(), 0);
      if (name === "unknown") {
        assert.ok(report.issues.includes("missing-role"));
        assert.ok(report.issues.includes("missing-turn"));
        assert.ok(report.issues.includes("unknown-search-unit-format"));
      }
      if (name === "generating" || name === "unknown") {
        assert.deepEqual(await adapter.messageIdentity(adapter.assistantMessages().first()), { id: null, turn: null });
      }
      if (name === "generating") assert.equal(report.missing.id, 1);
      if (name === "modern" || name === "legacy") {
        assert.equal(await adapter.assistantText(adapter.assistantMessages().first()), response);
      }
    });
  }

  await t.test("late hydration updates capability detection", async () => {
    await page.setContent("<main>Loading</main>");
    assert.ok((await adapter.collectStructuralDiagnostics()).issues.includes("composer-not-found"));
    await page.setContent(await fixture("modern"));
    const report = await adapter.collectStructuralDiagnostics();
    assert.equal(report.status, "recognized");
    assert.ok(report.capabilities.composers.includes("markdown-composer"));
  });

  await t.test("recovery rejects a foreign tail without sending", async () => {
    await page.setContent(modernRows);
    await page.locator("main").evaluate((element) => element.insertAdjacentHTML("beforeend", '<section data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="foreign-user">Other request</section>'));
    await assert.rejects(adapter.reconcilePendingOutbound({
      pendingOutbound: { kind: "bootstrap", outboundId },
      conversationTargetId: "fixture-target", timeoutMs: 150, stableWindowMs: 10,
    }), { code: "OUTBOUND_COMMIT_UNCERTAIN" });
    assert.equal(await adapter.userMessages().count(), 2);
  });

  await t.test("diagnostics keep structural evidence without prompts, IDs or URL query strings", async () => {
    await page.setContent(modernRows);
    adapter.recordConversationNavigation("https://chatgpt.com/");
    adapter.recordConversationNavigation("https://chatgpt.com/c/local-chatgpt%3Aprivate-id");
    adapter.recordConversationNavigation(page.url());
    const result = await adapter.writeDiagnostics("fixture-failure");
    const text = await fs.readFile(result.filename, "utf8");
    assert.deepEqual(result.report.routes.map(({ kind }) => kind), ["fresh", "provisional", "restorable"]);
    assert.equal(result.report.dom.structure.modern, 2);
    for (const secret of ["PRIVATE COMPOSER TEXT", "private-id", "private-query", outboundId, "assistant-1", "Transport test"]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});

test("real modern composer sends once across canonicalization and virtualized follow-up", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const app = `<!doctype html><main><div id="history"></div>
    <div data-composer-markdown contenteditable="true" role="textbox"></div>
    <button data-testid="send-button">Send</button></main><script>
    let group = 0;
    window.submissions = 0;
    document.querySelector('button').onclick = () => {
      const composer = document.querySelector('[contenteditable]');
      const user = document.createElement('section');
      user.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-' + group + ':0:user');
      user.setAttribute('data-chatgpt-search-message-ids', 'user-' + group);
      user.textContent = composer.innerText;
      composer.textContent = '';
      document.querySelector('#history').replaceChildren(user);
      window.submissions++;
      if (group === 0) {
        history.pushState({}, '', '/c/local-chatgpt%3Atest');
        setTimeout(() => history.replaceState({}, '', '/c/canonical-test'), 100);
      }
      const stop = document.createElement('button');
      stop.setAttribute('data-testid', 'stop-button');
      stop.textContent = 'Stop';
      document.querySelector('main').append(stop);
      setTimeout(() => {
        const assistant = document.createElement('section');
        assistant.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-' + group + ':3:assistant');
        assistant.setAttribute('data-chatgpt-search-message-ids', 'assistant-' + group);
        assistant.textContent = ${JSON.stringify(response)};
        document.querySelector('#history').append(assistant);
        stop.remove();
        group++;
      }, 200);
    };
    </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: app }));
  await page.goto("https://chatgpt.com/");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-send-dom-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  class FastAdapter extends ChatGPTWebAdapter {
    restorationCorrelationWindowMs() { return 20; }
    sendConfirmationTimeoutMs() { return 5000; }
  }
  const adapter = new FastAdapter({ profileDir: path.join(directory, "profile") });
  adapter.page = page;
  adapter.context = page.context();
  adapter.cdpChrome = { targetId: "offline-send-target" };
  await adapter.startConversation();
  assert.ok(adapter.lastDomReport.capabilities.composers.includes("markdown-composer"));
  for (const [index, marker] of [outboundId, "770ed650-ff14-4ee6-bc55-3238aab2c539"].entries()) {
    const sent = await adapter.sendMessage(userText.replace(outboundId, marker), { outboundId: marker });
    assert.equal(sent.userMessageId, `user-${index}`);
    assert.equal(sent.userTurn, index * 2 + 1);
    assert.equal(await adapter.waitForTurnComplete({ timeoutMs: 5000, stableWindowMs: 10 }), response);
    assert.equal(await page.evaluate(() => window.submissions), index + 1);
  }
  assert.equal(page.url(), "https://chatgpt.com/c/canonical-test");
  assert.equal(await adapter.userMessages().count(), 1);
});

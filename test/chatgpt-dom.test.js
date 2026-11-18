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
  assert.equal(adapter.classifyConversationUrl("https://chatgpt.com/uc/guest-id"), "provisional");
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

  await t.test("login copy in chat history does not make a conversation look signed out", async () => {
    await page.setContent(modernRows.replace("OK&lt;", "Log in or sign up&lt;"));
    assert.equal(await adapter.getAuthState(), "authenticated");

    await page.locator('[data-composer-markdown]').evaluate((composer) => composer.setAttribute("contenteditable", "false"));
    assert.equal(await adapter.getAuthState(), "unauthenticated");

    await page.setContent(`<main>Log in or sign up
      <div data-composer-markdown contenteditable="true"></div>
    </main>`);
    assert.equal(await adapter.getAuthState(), "unauthenticated");

    await page.setContent(modernRows.replace("</main>", "<button>Log in</button></main>"));
    assert.equal(await adapter.getAuthState(), "unauthenticated");
  });

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

  await t.test("recovers an existing reply from UUID-keyed turn groups", async () => {
    const group = "68d6044d-0447-4b0a-a770-d885afb3a351";
    const html = modernRows
      .replace("<section", `<div data-content-search-turn-key="${group}"><section`)
      .replace("</section>\n<div data-composer", "</section></div>\n<div data-composer")
      .replaceAll("fallback-turn-0", group)
      .replace('data-chatgpt-search-message-ids="assistant-1"', 'data-chatgpt-search-message-ids="assistant-1 assistant-1"');
    await page.setContent(html);
    const report = await adapter.structuralDiagnostics();
    assert.equal(report.status, "recognized");
    assert.equal(report.capabilities.unknownSearchUnits, 0);
    const recovered = await adapter.reconcilePendingOutbound({
      pendingOutbound: { kind: "bootstrap", outboundId },
      conversationTargetId: "fixture-target", timeoutMs: 3000, stableWindowMs: 10,
    });
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.userTurn, 1);
    assert.equal(recovered.assistantTurn, 2);
    assert.equal(recovered.rawResponse, response);

    await page.setContent(html.replace(`data-content-search-turn-key="${group}"`, 'data-content-search-turn-key="foreign-group"'));
    assert.equal((await adapter.structuralDiagnostics()).capabilities.unknownSearchUnits, 2);
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

  await t.test("reads guest messages and waits for their completion flag", async () => {
    await page.goto("https://chatgpt.com/uc/guest-id");
    await page.setContent(`<main><button>Log in</button>
      <ol data-conversation-transcript>
        <li id="guest-user" data-message-role="user"><p data-user-message-copy>Guest prompt</p></li>
        <li id="guest-assistant" data-message-role="assistant">
          <div data-assistant-markdown-root>Guest reply</div>
          <button>Copy response</button>
        </li>
      </ol>
      <form data-mobile-composer><textarea data-mobile-composer-prompt></textarea>
        <button type="submit" data-composer-submit>Send</button>
      </form></main>`);
    assert.equal(await adapter.getAuthState(), "unauthenticated");
    assert.equal(await adapter.canUseGuest(), true);
    assert.deepEqual((await adapter.orderedConversationSnapshot()).entries.map(({ role, id, turn, renderedText }) => [role, id, turn, renderedText]), [
      ["user", "guest-user", 1, "Guest prompt"],
      ["assistant", "guest-assistant", 2, "Guest reply"],
    ]);
    const reply = adapter.assistantMessages().last();
    assert.deepEqual(await adapter.messageIdentity(reply), { id: "guest-assistant", turn: 2 });
    assert.equal(await adapter.assistantText(reply), "Guest reply");
    assert.equal(await adapter.isAssistantGenerating(reply), true);
    await reply.evaluate((element) => element.setAttribute("data-message-complete", ""));
    assert.equal(await adapter.isAssistantGenerating(reply), false);
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

for (const collapsed of [false, true]) {
  test(`real modern composer sends once across canonicalization and virtualized follow-up${collapsed ? " with truncated long messages" : ""}`, {
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
      window.expansions = 0;
      document.querySelector('button').onclick = () => {
        const composer = document.querySelector('[contenteditable]');
        const user = document.createElement('section');
        user.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-' + group + ':0:user');
        user.setAttribute('data-chatgpt-search-message-ids', 'user-' + group);
        const text = composer.innerText;
        if (text.length > 10000) {
          const bubble = document.createElement('div');
          bubble.setAttribute('data-user-message-bubble', 'true');
          const body = document.createElement('div');
          body.textContent = text.slice(0, 10000);
          const expand = document.createElement('button');
          expand.setAttribute('aria-expanded', 'false');
          expand.setAttribute('data-thread-find-skip', 'true');
          expand.setAttribute('data-markdown-copy', 'exclude');
          expand.textContent = '展开';
          expand.onclick = () => {
            body.textContent = text;
            expand.setAttribute('aria-expanded', 'true');
            window.expansions++;
          };
          bubble.append(body, expand);
          user.append(bubble);
        } else user.textContent = text;
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
      const text = (collapsed ? 'Long tool result. '.repeat(900) : '') + userText.replace(outboundId, marker);
      const sent = await adapter.sendMessage(text, { outboundId: marker });
      assert.equal(sent.userMessageId, `user-${index}`);
      assert.equal(sent.userTurn, index * 2 + 1);
      assert.equal(await adapter.waitForTurnComplete({ timeoutMs: 5000, stableWindowMs: 10 }), response);
      assert.equal(await page.evaluate(() => window.submissions), index + 1);
    }
    assert.equal(page.url(), "https://chatgpt.com/c/canonical-test");
    assert.equal(await adapter.userMessages().count(), 1);
    assert.equal(await page.evaluate(() => window.expansions), collapsed ? 2 : 0);
  });
}

test("recovery reveals only the pending long user message and still requires its exact marker", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("https://chatgpt.com/c/collapsed-recovery");
  for (const revealsMarker of [true, false]) {
    await t.test(revealsMarker ? "recovers the completed reply without resending" : "refuses expansion without a rendered marker", async () => {
      await page.setContent(modernRows);
      await page.evaluate(({ outboundId, response, revealsMarker }) => {
        window.expansions = [];
        window.submissions = 0;
        const user = document.querySelector('[data-chatgpt-search-unit-key$=":user"]');
        user.textContent = '';
        const addBubble = (node, fullText, key) => {
          const bubble = document.createElement('div');
          bubble.setAttribute('data-user-message-bubble', 'true');
          const body = document.createElement('div');
          body.textContent = fullText.slice(0, 10000);
          const expand = document.createElement('button');
          expand.textContent = 'Show more';
          expand.setAttribute('aria-expanded', 'false');
          expand.setAttribute('data-thread-find-skip', 'true');
          expand.setAttribute('data-markdown-copy', 'exclude');
          expand.onclick = () => {
            window.expansions.push(key);
            expand.setAttribute('aria-expanded', 'true');
            if (revealsMarker) body.textContent = fullText;
          };
          bubble.append(body, expand);
          node.append(bubble);
        };
        addBubble(user, 'Older message. '.repeat(900), 'old');
        const pendingUser = document.createElement('section');
        pendingUser.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-1:0:user');
        pendingUser.setAttribute('data-chatgpt-search-message-ids', 'user-2');
        addBubble(pendingUser, 'Long tool result. '.repeat(900)
          + `<system_reminder>Opaque WTAgent transport correlation ID (do not repeat): ${outboundId}.</system_reminder>`, 'pending');
        const assistant = document.createElement('section');
        assistant.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-1:3:assistant');
        assistant.setAttribute('data-chatgpt-search-message-ids', 'assistant-2');
        assistant.textContent = response;
        document.querySelector('main').append(pendingUser, assistant);
        document.querySelector('[data-testid="send-button"]').onclick = () => { window.submissions++; };
      }, { outboundId, response, revealsMarker });
      const adapter = new ChatGPTWebAdapter({ profileDir: "." });
      adapter.page = page;
      adapter.context = page.context();
      adapter.cdpChrome = { targetId: "fixture-target", exactTargetOnly: true };
      // Keep the expected failure's diagnostics out of the source tree.
      adapter.writeDiagnostics = async () => null;
      const recover = () => adapter.reconcilePendingOutbound({
        pendingOutbound: { kind: "tool_result", outboundId },
        conversationTargetId: "fixture-target", lastUserMessageId: "user-1", lastAssistantMessageId: "assistant-1",
        timeoutMs: 1500, stableWindowMs: 10,
      });
      if (revealsMarker) {
        const recovered = await recover();
        assert.equal(recovered.status, "complete");
        assert.equal(recovered.userMessageId, "user-2");
        assert.equal(recovered.assistantMessageId, "assistant-2");
        assert.equal(recovered.rawResponse, response);
      } else {
        await assert.rejects(recover(), { code: "OUTBOUND_COMMIT_UNCERTAIN" });
      }
      assert.deepEqual(await page.evaluate(() => window.expansions), ['pending']);
      assert.equal(await page.evaluate(() => window.submissions), 0);
      assert.equal(await page.locator('[data-composer-markdown]').innerText(), 'PRIVATE COMPOSER TEXT');
      assert.equal(await adapter.userMessages().count(), 2);
      assert.equal(adapter.getLastSendStatus(), 'not-submitted');
    });
  }
});

test("modern ChatGPT waits for its enabled send control instead of pressing Enter", {
  skip: process.env.WTAGENT_DOM_TESTS !== "1",
}, async (t) => {
  const browser = await chromium.launch({ executablePath: discoverChromeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("https://chatgpt.com/");
  await page.setContent(`<main>
    <form data-chatgpt-composer style="display:none"><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="Send"></button></form>
    <form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="Send" disabled></button></form>
    <div id="history"></div></main>`);
  await page.evaluate(({ response }) => {
    window.submissions = 0;
    window.enterPresses = 0;
    const form = document.querySelectorAll('form')[1];
    const composer = form.querySelector('[contenteditable]');
    const send = form.querySelector('button');
    composer.addEventListener('keydown', e => {
      if (e.key === 'Enter') { window.enterPresses++; e.preventDefault(); }
    });
    composer.addEventListener('input', () => {
      send.disabled = true;
      setTimeout(() => { send.disabled = false; }, 200);
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      window.submissions++;
      history.pushState({}, '', '/c/send-readiness');
      for (const [role, text] of [['user', composer.innerText], ['assistant', response]]) {
        const row = document.createElement('section');
        row.setAttribute('data-chatgpt-search-unit-key', `fallback-turn-0:0:${role}`);
        row.setAttribute('data-chatgpt-search-message-ids', `${role}-new`);
        row.textContent = text;
        document.querySelector('#history').append(row);
      }
      composer.textContent = '';
      send.disabled = true;
    });
  }, { response });
  class FastAdapter extends ChatGPTWebAdapter {
    restorationCorrelationWindowMs() { return 10; }
    sendConfirmationTimeoutMs() { return 1500; }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wtagent-ready-send-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapter = new FastAdapter({ profileDir: path.join(directory, 'profile') });
  adapter.page = page;
  adapter.context = page.context();
  adapter.cdpChrome = { targetId: 'ready-send-target' };
  await adapter.startConversation();
  const sent = await adapter.sendMessage(userText, { outboundId });
  assert.equal(sent.userMessageId, 'user-new');
  assert.equal(await page.evaluate(() => window.submissions), 1);
  assert.equal(await page.evaluate(() => window.enterPresses), 0);
  const report = await adapter.structuralDiagnostics();
  assert.equal(report.capabilities.sendButton, true);
  assert.equal(report.capabilities.sendButtonEnabled, false);
  assert.equal(report.capabilities.composerHasText, false);
});

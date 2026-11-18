// All supported ChatGPT DOM shapes live here. Text and localized headings must
// never supply a role, message identity, or ordering key.
const legacyUser = '[data-message-author-role="user"]';
const legacyAssistant = '[data-message-author-role="assistant"]:not([id^="request-placeholder-"])';
const modern = (role) => `[data-chatgpt-search-unit-key$=":${role}"]:not([id^="request-placeholder-"]):not(:has([data-message-author-role])):not([data-message-author-role] *)`;
const guest = (role) => `ol[data-conversation-transcript] > li[data-message-role="${role}"]`;
export const CHATGPT_DOM = {
  user: { legacy: legacyUser, modern: modern("user"), guest: guest("user") },
  assistant: { legacy: legacyAssistant, modern: modern("assistant"), guest: guest("assistant") },
  conversationLegacy: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
  composers: [
    { name: "prompt-textarea", selector: "#prompt-textarea" },
    { name: "markdown-composer", selector: '[data-composer-markdown][contenteditable="true"][role="textbox"]' },
    { name: "guest-composer", selector: "form[data-mobile-composer] textarea[data-mobile-composer-prompt]" },
    { name: "message-textarea-en", selector: 'textarea[placeholder*="Message" i]' },
    { name: "message-textarea-zh", selector: 'textarea[placeholder*="消息"]' },
    { name: "lexical-composer", selector: 'div[contenteditable="true"][data-lexical-editor="true"]' },
    { name: "main-contenteditable", selector: 'main div[contenteditable="true"]' },
  ],
  send: '[data-testid="send-button"]',
  sendModern: 'form[data-chatgpt-composer] button[type="submit"]',
  sendGuest: 'form[data-mobile-composer] button[data-composer-submit][type="submit"]',
  stop: '[data-testid="stop-button"]',
  expandUserMessage: '[data-user-message-bubble] button[aria-expanded="false"][data-thread-find-skip="true"][data-markdown-copy="exclude"]',
};
CHATGPT_DOM.messages = [
  ...Object.values(CHATGPT_DOM.user), ...Object.values(CHATGPT_DOM.assistant),
].join(", ");

// This function is serialized into the page. Keep it self-contained, and pass
// the registry explicitly when requesting a capability sample.
export function readChatGPTDom(input) {
  const options = input?.selector ? input : null;
  const elements = typeof input === "string" || options
    ? [...document.querySelectorAll(options?.selector ?? input)]
    : Array.isArray(input) ? input : [input];
  const structure = { legacy: 0, modern: 0, unknown: 0, ambiguousIds: 0 };
  const guestTurns = new Map();
  const turnKeySelector = "[data-content-search-turn-key]";
  const fallbackSearchKey = /^fallback-turn-(\d+):(\d+):(user|assistant)$/;
  const uuidSearchKey = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):\d+:(user|assistant)$/i;
  let turnGroupIndexes = null;
  const readSearchUnit = (element) => {
    const key = element.getAttribute("data-chatgpt-search-unit-key") ?? "";
    const fallback = key.match(fallbackSearchKey);
    if (fallback) return { group: Number(fallback[1]), role: fallback[3] };
    const uuid = key.match(uuidSearchKey);
    if (!uuid) return null;
    const group = element.closest(turnKeySelector);
    if (group?.getAttribute("data-content-search-turn-key") !== uuid[1]) return null;
    // The UUID identifies the group but does not encode its position. Use the
    // ordered turn wrappers, including wrappers without a mounted reply.
    turnGroupIndexes ??= new Map([...document.querySelectorAll(turnKeySelector)]
      .map((wrapper, index) => [wrapper, index]));
    const index = turnGroupIndexes.get(group);
    return index == null ? null : { group: index, role: uuid[2] };
  };
  const entries = elements.map((element, domIndex) => {
    const legacyRole = element.getAttribute("data-message-author-role");
    const modern = readSearchUnit(element);
    const guestRole = element.getAttribute("data-message-role");
    const guestList = guestRole && element.matches("ol[data-conversation-transcript] > li[data-message-role]")
      ? element.parentElement : null;
    const role = legacyRole ?? modern?.role ?? (guestList ? guestRole : null);
    const layout = legacyRole ? "legacy" : modern ? "modern" : guestList ? "guest" : "unknown";
    structure[layout] = (structure[layout] ?? 0) + 1;
    const wrapper = element.closest('[data-testid^="conversation-turn-"]');
    const legacyTurn = wrapper?.getAttribute("data-testid")?.match(/^conversation-turn-(\d+)$/);
    const messageIds = [...new Set((element.getAttribute("data-chatgpt-search-message-ids") ?? "").split(/\s+/).filter(Boolean))];
    const legacyId = element.getAttribute("data-message-id");
    if (legacyId == null && messageIds.length > 1) structure.ambiguousIds += 1;
    const guestId = guestList ? element.id || null : null;
    const id = legacyId ?? (messageIds.length === 1 ? messageIds[0] : guestId);
    // Thinking/tool blocks occupy positions too. Only the group and role define
    // turn order; duplicate roles within a group are rejected by validation.
    if (guestList && !guestTurns.has(guestList)) {
      const rows = guestList.querySelectorAll(":scope > li[data-message-role]");
      guestTurns.set(guestList, new Map([...rows].map((row, index) => [row, index + 1])));
    }
    const turn = legacyTurn ? Number(legacyTurn[1])
      : modern ? modern.group * 2 + (role === "user" ? 1 : 2)
        : guestTurns.get(guestList)?.get(element) ?? null;
    const content = guestList
      ? element.querySelector(role === "assistant" ? "[data-assistant-markdown-root]" : "[data-user-message-copy]")
      : null;
    const rendered = content ?? element;
    let renderedText = rendered.innerText ?? rendered.textContent ?? "";
    if (role === "assistant" && !renderedText.includes("<agent_response")) {
      const codeTexts = [...element.querySelectorAll("pre code")].map((node) => node.innerText ?? node.textContent ?? "");
      const envelope = codeTexts.find((text) => text.includes("<agent_response") && text.includes("</agent_response>"))
        ?? codeTexts.find((text) => text.includes("<agent_response"));
      const markdown = [...element.querySelectorAll('.markdown, [data-markdown-text-style="assistant-message"], [data-assistant-markdown-root]')].at(-1);
      if (envelope) renderedText = envelope;
      else if (markdown) renderedText = markdown.innerText ?? markdown.textContent ?? "";
    }
    return { domIndex, role, id, turn, renderedText };
  });
  const snapshot = { url: globalThis.location?.href ?? null, entries, structure };
  if (options?.registry) {
    const visible = (element) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden";
    const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
    const sendControls = [...document.querySelectorAll(
      [options.registry.send, options.registry.sendModern, options.registry.sendGuest].filter(Boolean).join(', '),
    )].filter(visible);
    snapshot.capabilities = {
      readyState: document.readyState,
      composers: options.registry.composers.filter(({ selector }) => count(selector) > 0).map(({ name }) => name),
      sendButton: sendControls.length > 0,
      sendButtonEnabled: sendControls.some((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true'),
      composerHasText: options.registry.composers.some(({ selector }) => (
        [...document.querySelectorAll(selector)].some((element) => visible(element)
          && String(element.value ?? element.innerText ?? element.textContent ?? '').trim().length > 0)
      )),
      stopButton: count(options.registry.stop) > 0,
      placeholderCount: document.querySelectorAll('[id^="request-placeholder-"]').length,
      // Unrecognized search keys are evidence of a renderer change.
      unknownSearchUnits: [...document.querySelectorAll('[data-chatgpt-search-unit-key]')]
        .filter((element) => !readSearchUnit(element)).length,
    };
  }
  return snapshot;
}

// Deliberately excludes message text, IDs, composer content, and raw attributes.
// This report may be collected even when screenshots/full HTML are disabled.
export function summarizeChatGPTDom(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries)) return { status: "unavailable" };
  const entries = snapshot.entries;
  const issues = [];
  const countMissing = (test) => entries.filter(test).length;
  const missing = {
    role: countMissing((entry) => !["user", "assistant"].includes(entry.role)),
    id: countMissing((entry) => typeof entry.id !== "string" || !entry.id.trim()),
    turn: countMissing((entry) => !Number.isSafeInteger(entry.turn) || entry.turn < 0),
  };
  for (const [field, count] of Object.entries(missing)) if (count) issues.push(`missing-${field}`);
  const ids = entries.map((entry) => entry.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) issues.push("duplicate-message-id");
  if (entries.some((entry, index) => index > 0 && entry.turn <= entries[index - 1].turn)) issues.push("non-monotonic-turns");
  if (snapshot.structure?.ambiguousIds) issues.push("ambiguous-message-ids");
  if (snapshot.capabilities?.unknownSearchUnits) issues.push("unknown-search-unit-format");
  if (snapshot.capabilities && !snapshot.capabilities.composers.length) issues.push("composer-not-found");
  return {
    status: issues.length ? "incomplete" : entries.length ? "recognized" : "empty",
    structure: snapshot.structure,
    capabilities: snapshot.capabilities,
    counts: { total: entries.length, user: countMissing((entry) => entry.role === "user"), assistant: countMissing((entry) => entry.role === "assistant") },
    missing,
    issues,
  };
}

function parseConversationTurn(value) {
  const match = String(value ?? "").match(/^conversation-turn-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function readChatGPTMessageIdentity(message) {
  if (await usesStructuredRow(message)) {
    const snapshot = await message.evaluate(readChatGPTDom).catch(() => null);
    const entry = snapshot?.entries?.[0];
    if (!entry || !["user", "assistant"].includes(entry.role)
      || !entry.id || !Number.isSafeInteger(entry.turn) || entry.turn < 0) {
      return { id: null, turn: null };
    }
    return { id: entry.id, turn: entry.turn };
  }
  const [id, turn] = await Promise.all([
    message.getAttribute("data-message-id").catch(() => null),
    readLegacyTurn(message),
  ]);
  return { id, turn };
}

async function readLegacyTurn(message) {
  if (typeof message?.evaluate !== "function") {
    return null;
  }
  const testId = await message.evaluate((element) => (
    element.closest('[data-testid^="conversation-turn-"]')
      ?.getAttribute("data-testid") ?? null
  )).catch(() => null);
  return parseConversationTurn(testId);
}


export async function readChatGPTAssistantText(message, hasCompleteAgentEnvelope) {
  if (await usesStructuredRow(message)) {
    const snapshot = await message.evaluate(readChatGPTDom).catch(() => null);
    return snapshot?.entries?.[0]?.renderedText ?? "";
  }
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

async function usesStructuredRow(message) {
  return Boolean(
    await message.getAttribute("data-chatgpt-search-unit-key").catch(() => null)
    || await message.getAttribute("data-message-role").catch(() => null)
  );
}

// All supported ChatGPT DOM shapes live here. Text and localized headings must
// never supply a role, message identity, or ordering key.
const legacyUser = '[data-message-author-role="user"]';
const legacyAssistant = '[data-message-author-role="assistant"]:not([id^="request-placeholder-"])';
const modern = (role) => `[data-chatgpt-search-unit-key$=":${role}"]:not([id^="request-placeholder-"]):not(:has([data-message-author-role])):not([data-message-author-role] *)`;
export const CHATGPT_DOM = {
  user: { legacy: legacyUser, modern: modern("user") },
  assistant: { legacy: legacyAssistant, modern: modern("assistant") },
  conversationLegacy: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
  composers: [
    { name: "prompt-textarea", selector: "#prompt-textarea" },
    { name: "markdown-composer", selector: '[data-composer-markdown][contenteditable="true"][role="textbox"]' },
    { name: "message-textarea-en", selector: 'textarea[placeholder*="Message" i]' },
    { name: "message-textarea-zh", selector: 'textarea[placeholder*="消息"]' },
    { name: "lexical-composer", selector: 'div[contenteditable="true"][data-lexical-editor="true"]' },
    { name: "main-contenteditable", selector: 'main div[contenteditable="true"]' },
  ],
  send: '[data-testid="send-button"]',
  stop: '[data-testid="stop-button"]',
};
CHATGPT_DOM.messages = [legacyUser, legacyAssistant, modern("user"), modern("assistant")].join(", ");

// This function is serialized into the page. Keep it self-contained, and pass
// the registry explicitly when requesting a capability sample.
export function readChatGPTDom(input) {
  const options = input?.selector ? input : null;
  const elements = typeof input === "string" || options
    ? [...document.querySelectorAll(options?.selector ?? input)]
    : Array.isArray(input) ? input : [input];
  const structure = { legacy: 0, modern: 0, unknown: 0, ambiguousIds: 0 };
  const entries = elements.map((element, domIndex) => {
    const legacyRole = element.getAttribute("data-message-author-role");
    const key = element.getAttribute("data-chatgpt-search-unit-key") ?? "";
    const modern = key.match(/^fallback-turn-(\d+):(\d+):(user|assistant)$/);
    const role = legacyRole ?? modern?.[3] ?? null;
    structure[legacyRole ? "legacy" : modern ? "modern" : "unknown"] += 1;
    const wrapper = element.closest('[data-testid^="conversation-turn-"]');
    const legacyTurn = wrapper?.getAttribute("data-testid")?.match(/^conversation-turn-(\d+)$/);
    const messageIds = [...new Set((element.getAttribute("data-chatgpt-search-message-ids") ?? "").split(/\s+/).filter(Boolean))];
    const legacyId = element.getAttribute("data-message-id");
    if (legacyId == null && messageIds.length > 1) structure.ambiguousIds += 1;
    const id = legacyId ?? (messageIds.length === 1 ? messageIds[0] : null);
    // Thinking/tool blocks occupy positions too. Only the group and role define
    // turn order; duplicate roles within a group are rejected by validation.
    const turn = legacyTurn ? Number(legacyTurn[1])
      : modern ? Number(modern[1]) * 2 + (role === "user" ? 1 : 2) : null;
    let renderedText = element.innerText ?? element.textContent ?? "";
    if (role === "assistant" && !renderedText.includes("<agent_response")) {
      const codeTexts = [...element.querySelectorAll("pre code")].map((node) => node.innerText ?? node.textContent ?? "");
      const envelope = codeTexts.find((text) => text.includes("<agent_response") && text.includes("</agent_response>"))
        ?? codeTexts.find((text) => text.includes("<agent_response"));
      const markdown = [...element.querySelectorAll('.markdown, [data-markdown-text-style="assistant-message"]')].at(-1);
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
    snapshot.capabilities = {
      readyState: document.readyState,
      composers: options.registry.composers.filter(({ selector }) => count(selector) > 0).map(({ name }) => name),
      sendButton: count(options.registry.send) > 0,
      stopButton: count(options.registry.stop) > 0,
      placeholderCount: document.querySelectorAll('[id^="request-placeholder-"]').length,
      // Unknown suffixes are evidence of a renderer change, not valid messages.
      unknownSearchUnits: [...document.querySelectorAll('[data-chatgpt-search-unit-key]')]
        .filter((element) => !/^fallback-turn-\d+:\d+:(user|assistant)$/.test(element.getAttribute("data-chatgpt-search-unit-key"))).length,
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
  if (await message.getAttribute("data-chatgpt-search-unit-key").catch(() => null)) {
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
  if (await message.getAttribute("data-chatgpt-search-unit-key").catch(() => null)) {
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

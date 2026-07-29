// Delimiters that mark WTAgent-specific control content inside the plain-text
// messages exchanged with ChatGPT Web. ChatGPT Web has no real system/tool
// channel, so the protocol instructions, tool catalog, and per-turn reminders
// all travel as ordinary chat text. These markers let the session exporters
// deterministically strip that scaffolding when converting a transcript into a
// Codex or Claude Code session, where the XML protocol and the WTAgent tool
// set must NOT be presented to the model.
//
// The markers are transparent to the web model (it simply reads the enclosed
// instructions); they exist for offline tooling, not for the model.

export const SYSTEM_PROMPT_TAG = "agent_protocol";
export const SYSTEM_REMINDER_TAG = "system_reminder";
export const DEFAULT_SYSTEM_REMINDER = [
  "This is a reminder of the user's requested response format for the WTAgent integration, not a ChatGPT system message.",
  "You do not need native tool access: write the XML request as text and the user's local Runtime will process it after your reply.",
  "Your next response must use the XML application protocol.",
  "It must contain exactly one <agent_response>...</agent_response> envelope.",
  "Inside the optional `xml` code fence, the first content must be <agent_response>",
  "and the last content must be </agent_response>; do not put text outside the envelope.",
].join(" ");

export function wrapSystemPrompt(text) {
  return `<${SYSTEM_PROMPT_TAG}>\n${String(text ?? "")}\n</${SYSTEM_PROMPT_TAG}>`;
}

export function wrapSystemReminder(text) {
  return `<${SYSTEM_REMINDER_TAG}>${String(text ?? "")}</${SYSTEM_REMINDER_TAG}>`;
}

export function appendSystemReminder(
  text,
  reminder = DEFAULT_SYSTEM_REMINDER,
) {
  return `${String(text ?? "").trimEnd()}\n\n${wrapSystemReminder(reminder)}`;
}

function blockPattern(tag) {
  return new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
}

// Returns the concatenated inner text of every block for the given tag, in
// document order. Retained for compatibility diagnostics and transport
// scaffold stripping.
export function extractMarkedBlocks(text, tag) {
  const inner = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const blocks = [];
  let match;
  while ((match = inner.exec(String(text ?? ""))) != null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// Removes every current/legacy protocol marker and <system_reminder> block,
// then normalizes the remaining human/user content.
export function stripSystemMarkers(text) {
  return String(text ?? "")
    .replace(blockPattern(SYSTEM_PROMPT_TAG), "")
    .replace(blockPattern("system_prompt"), "")
    .replace(blockPattern(SYSTEM_REMINDER_TAG), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

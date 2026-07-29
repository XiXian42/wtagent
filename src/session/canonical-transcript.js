// Canonical conversation transcript.
//
// The source of truth for a task's dialogue is stored in this Codex-compatible
// shape from the very first exchange. ChatGPT Web only ever sees a rendered
// projection (XML for tool results, a marked prompt for instructions); the
// structured record below is what we persist and later export to Codex or
// Claude Code sessions.
//
// Item payloads follow the OpenAI Responses item schema that Codex writes into
// its rollout JSONL (`type: "response_item"`):
//   - message           { role, content: [{ type: "input_text"|"output_text", text }] }
//   - function_call     { name, arguments (JSON string), call_id }
//   - function_call_output { call_id, output (string) }
//
// A leading `session_meta` record mirrors Codex's rollout header. Timestamps
// are attached by the persistence layer at append time (kept out of these pure
// builders so they stay deterministic and unit-testable).

export const TRANSCRIPT_VERSION = 1;

function inputText(text) {
  return [{ type: "input_text", text: String(text ?? "") }];
}

function outputText(text) {
  return [{ type: "output_text", text: String(text ?? "") }];
}

// A `developer` message carries WTAgent scaffolding (protocol + tool catalog).
// Exporters treat developer content as strippable / relocatable, never as user
// intent.
export function developerMessage(text) {
  return {
    type: "message",
    role: "developer",
    content: inputText(text),
  };
}

// A user message. `attachments` records any @file uploads that accompanied the
// message on the web transport (name + local path), so exporters can note them
// even though the uploaded bytes live only in the ChatGPT conversation.
export function userMessage(text, { attachments = [] } = {}) {
  const item = {
    type: "message",
    role: "user",
    content: inputText(text),
  };
  if (attachments.length > 0) {
    item.attachments = attachments.map((file) => ({
      name: file.name ?? basename(file.path ?? ""),
      path: file.path ?? null,
    }));
  }
  return item;
}

function basename(filePath) {
  const parts = String(filePath).split(/[/\\]/);
  return parts[parts.length - 1] || String(filePath);
}

export function assistantMessage(text) {
  return {
    type: "message",
    role: "assistant",
    content: outputText(text),
  };
}

export function functionCall({ name, args, callId }) {
  return {
    type: "function_call",
    name: String(name ?? ""),
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    call_id: String(callId ?? ""),
  };
}

export function functionCallOutput({ callId, output }) {
  return {
    type: "function_call_output",
    call_id: String(callId ?? ""),
    output: typeof output === "string" ? output : JSON.stringify(output ?? ""),
  };
}

// Normalizes a WTAgent ToolResult (from the tool registry) into the compact
// text Codex/CC expect for a tool output, keeping the machine-readable JSON but
// avoiding the XML envelope used only for the web transport.
export function toolResultOutput(result) {
  const lines = [];
  lines.push(`status: ${result.ok ? "ok" : "error"}`);
  if (result.message) {
    lines.push(result.message);
  }
  if (result.stdout) {
    lines.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr) {
    lines.push(`stderr:\n${result.stderr}`);
  }
  if (result.data != null) {
    const data = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);
    lines.push(`data: ${data}`);
  }
  return lines.join("\n");
}

export function sessionMeta({
  sessionId,
  cwd,
  createdAt,
  baseInstructions,
  task,
  mode,
}) {
  return {
    id: sessionId,
    session_id: sessionId,
    timestamp: createdAt ?? null,
    cwd,
    originator: "wtagent",
    source: "wtagent",
    base_instructions: baseInstructions ?? null,
    task: task ?? null,
    mode: mode ?? null,
    transcriptVersion: TRANSCRIPT_VERSION,
  };
}

export function isDeveloper(item) {
  return item?.type === "message" && item.role === "developer";
}

export function messageText(item) {
  if (item?.type !== "message" || !Array.isArray(item.content)) {
    return "";
  }
  return item.content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

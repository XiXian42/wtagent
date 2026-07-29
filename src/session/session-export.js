// Session exporters: canonical transcript -> Codex rollout JSONL and Claude
// Code project JSONL.
//
// The canonical transcript is already Codex-shaped, so the Codex exporter is a
// thin framing layer. The Claude Code exporter maps Responses-style items onto
// Anthropic Messages blocks (tool_use / tool_result) with the uuid/parentUuid
// linkage that Claude Code's project JSONL uses.
//
// Both exporters strip WTAgent-specific scaffolding: `developer` messages
// (protocol + tool catalog) and any legacy/current protocol or reminder blocks
// in user text. The WTAgent XML protocol and its tool set must never surface
// in a Codex or Claude Code session — those runtimes drive their own tools.

import { randomUUID } from "node:crypto";
import { stripSystemMarkers } from "../protocol/markers.js";
import { isDeveloper, messageText } from "./canonical-transcript.js";

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function firstTimestamp(items, fallback) {
  return items.find((item) => item.timestamp)?.timestamp ?? fallback;
}

// The uploaded bytes of an @file attachment live only in the ChatGPT
// conversation, not in the portable transcript. So exports append a short,
// self-describing note naming the attached files, keeping the exported session
// honest about what the user actually provided.
function withAttachmentNote(text, item) {
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  if (attachments.length === 0) {
    return text;
  }
  const names = attachments.map((file) => file.name ?? file.path).filter(Boolean);
  if (names.length === 0) {
    return text;
  }
  const note = `[attached: ${names.join(", ")}]`;
  return text ? `${text}\n\n${note}` : note;
}

// ---------------------------------------------------------------------------
// Codex rollout export
// ---------------------------------------------------------------------------
// Produces `{timestamp, type, payload}` records: a leading `session_meta`, then
// one `response_item` per transcript item. WTAgent's transport-only developer
// scaffold is omitted entirely; it must not become Codex instructions.
export function toCodexRollout(transcript, { now } = {}) {
  const meta = transcript.meta ?? {};
  const items = transcript.items ?? [];
  const stamp = now ?? firstTimestamp(items, meta.createdAt) ?? null;
  const sessionId = meta.sessionId ?? randomUUID();

  const records = [];
  records.push({
    timestamp: stamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      timestamp: meta.createdAt ?? stamp,
      cwd: meta.cwd ?? null,
      originator: "wtagent",
      source: "wtagent",
      base_instructions: meta.baseInstructions ?? null,
    },
  });

  for (const entry of items) {
    const item = entry.item;
    if (isDeveloper(item)) {
      // This is the XML/tool transport scaffold used only on ChatGPT Web.
      continue;
    }

    let payload = item;
    if (item.type === "message" && item.role === "user") {
      const cleaned = withAttachmentNote(stripSystemMarkers(messageText(item)), item);
      if (!cleaned) {
        continue;
      }
      payload = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: cleaned }],
      };
    }

    records.push({
      timestamp: entry.timestamp ?? stamp,
      type: "response_item",
      payload,
    });
  }

  return jsonl(records);
}

// ---------------------------------------------------------------------------
// Claude Code project export
// ---------------------------------------------------------------------------
// Produces uuid/parentUuid-linked records with Anthropic Messages content.
// function_call -> assistant message with a tool_use block.
// function_call_output -> user message with a tool_result block.
export function toClaudeCodeSession(transcript, { sessionId, now } = {}) {
  const meta = transcript.meta ?? {};
  const items = transcript.items ?? [];
  const session = sessionId ?? meta.sessionId ?? randomUUID();
  const cwd = meta.cwd ?? null;
  const stamp = now ?? firstTimestamp(items, meta.createdAt) ?? null;

  const records = [];
  let parentUuid = null;

  const push = (partial, timestamp) => {
    const uuid = randomUUID();
    records.push({
      parentUuid,
      isSidechain: false,
      type: partial.type,
      message: partial.message,
      uuid,
      timestamp: timestamp ?? stamp,
      cwd,
      sessionId: session,
      version: "wtagent-export",
      ...(partial.extra ?? {}),
    });
    parentUuid = uuid;
  };

  for (const entry of items) {
    const item = entry.item;
    const ts = entry.timestamp ?? stamp;

    if (isDeveloper(item)) {
      continue;
    }

    if (item.type === "message" && item.role === "user") {
      const cleaned = withAttachmentNote(stripSystemMarkers(messageText(item)), item);
      if (!cleaned) {
        continue;
      }
      push({
        type: "user",
        message: { role: "user", content: cleaned },
      }, ts);
    } else if (item.type === "message" && item.role === "assistant") {
      const text = messageText(item);
      if (!text.trim()) {
        continue;
      }
      push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      }, ts);
    } else if (item.type === "function_call") {
      let input = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        input = { _raw: item.arguments };
      }
      push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input,
          }],
        },
      }, ts);
    } else if (item.type === "function_call_output") {
      push({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.call_id,
            content: item.output,
          }],
        },
      }, ts);
    }
  }

  return jsonl(records);
}

export const EXPORTERS = {
  codex: toCodexRollout,
  "claude-code": toClaudeCodeSession,
};

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ProtocolError } from "../shared/errors.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function stripSingleCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  const match = trimmed.match(/^```(?:xml)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

// Matches the ampersand of a well-formed XML entity: named (&amp;), decimal
// (&#38;), or hex (&#x26;). Anything else is a bare ampersand the model forgot
// to escape or wrap in CDATA.
const VALID_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/y;

// Escapes bare ampersands to &amp; while leaving valid entities and everything
// inside CDATA sections untouched. Unescaped `&` (e.g. "Tom & Jerry", query
// strings like "a=1&b=2", "R&D") is the most common reason ChatGPT Web's XML
// fails strict parsing, and repairing it is always safe: a bare `&` is never
// legal XML, so this cannot change the meaning of otherwise-valid markup.
function escapeBareAmpersands(text) {
  let out = "";
  let index = 0;
  const cdataOpen = "<![CDATA[";
  const cdataClose = "]]>";

  while (index < text.length) {
    const char = text[index];
    if (char === "<" && text.startsWith(cdataOpen, index)) {
      const close = text.indexOf(cdataClose, index + cdataOpen.length);
      const end = close < 0 ? text.length : close + cdataClose.length;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "&") {
      VALID_ENTITY.lastIndex = index;
      if (VALID_ENTITY.test(text)) {
        out += text.slice(index, VALID_ENTITY.lastIndex);
        index = VALID_ENTITY.lastIndex;
      } else {
        out += "&amp;";
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function extractEnvelope(text) {
  const cleaned = stripSingleCodeFence(text);
  const start = cleaned.indexOf("<agent_response");
  const endTag = "</agent_response>";
  const end = cleaned.lastIndexOf(endTag);

  if (start < 0 || end < 0 || end < start) {
    throw new ProtocolError(
      "Response must contain one complete <agent_response> envelope.",
      { details: { raw: cleaned } },
    );
  }

  // ChatGPT Web may prepend a preamble (e.g. "Sure, here is the response:")
  // or append trailing text / render rich cards around the XML. We only care
  // about the envelope itself, so surrounding text is stripped instead of
  // being treated as a protocol violation.
  return cleaned.slice(start, end + endTag.length);
}

function normalizeXmlValue(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(normalizeXmlValue);
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const keys = Object.keys(value);
  const textKeys = keys.filter((key) => key === "#text" || key === "#cdata");
  const contentKeys = keys.filter(
    (key) => key !== "#text" && key !== "#cdata",
  );
  if (textKeys.length === keys.length) {
    return textKeys.map((key) => String(value[key] ?? "")).join("");
  }

  if (
    contentKeys.length === 1
    && ["item", "string", "arg"].includes(contentKeys[0])
  ) {
    const listValue = value[contentKeys[0]];
    const items = Array.isArray(listValue) ? listValue : [listValue];
    return items.map(normalizeXmlValue);
  }

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "#text" || key === "#cdata") {
      continue;
    }
    normalized[key] = normalizeXmlValue(child);
  }
  return normalized;
}

function scalarText(value) {
  const normalized = normalizeXmlValue(value);
  if (typeof normalized === "string") {
    return normalized.trim();
  }
  return "";
}

function parseDone(value) {
  const text = scalarText(value).toLowerCase();
  if (text !== "true" && text !== "false") {
    throw new ProtocolError("<done> must be true or false.");
  }
  return text === "true";
}

// Reads a single element's inner text by regex, tolerating attributes on the
// tag and CDATA inside it. Used only by the recovery path below.
function looseTagText(xml, tag) {
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,
    "i",
  ).exec(xml);
  if (!match) {
    return null;
  }
  let inner = match[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  if (cdata) {
    return cdata[1].trim();
  }
  // Strip any stray tags the model may have left inside the message, then
  // decode the handful of entities that matter for display.
  return inner
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

// Last-resort recovery when strict parsing fails. It ONLY salvages a
// conversational, message-only answer — a response that carries <done> and
// <message> but no <tool_call>. Tool calls are never recovered this way:
// guessing the arguments of a side-effecting operation from broken XML is
// unsafe, so those still fall through to a format retry.
function recoverMessageOnlyResponse(envelope) {
  if (/<tool_call[\s>]/i.test(envelope)) {
    return null;
  }
  const doneText = looseTagText(envelope, "done");
  const message = looseTagText(envelope, "message");
  if (doneText == null || message == null) {
    return null;
  }
  const done = doneText.trim().toLowerCase();
  if (done !== "true" && done !== "false") {
    return null;
  }
  if (done === "true" && !message.trim()) {
    return null;
  }
  return {
    done: done === "true",
    message,
    toolCall: null,
    raw: envelope,
    recovered: true,
  };
}

export function parseAgentResponse(rawText) {
  const rawEnvelope = extractEnvelope(rawText);

  const structuralXml = rawEnvelope.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>/g,
    "<![CDATA[]]>",
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(structuralXml)) {
    throw new ProtocolError("DTD and XML entities are not allowed.");
  }

  // Repair the single most common corruption first: bare ampersands the model
  // wrote outside CDATA. This is done before validation so an otherwise
  // well-formed envelope with a stray "&" parses instead of triggering a retry.
  const envelope = escapeBareAmpersands(rawEnvelope);

  const validation = XMLValidator.validate(envelope);
  if (validation !== true) {
    const recovered = recoverMessageOnlyResponse(envelope);
    if (recovered) {
      return recovered;
    }
    throw new ProtocolError(
      `Invalid XML: ${validation.err?.msg ?? "unknown XML error"}`,
      { details: validation },
    );
  }

  let parsed;
  try {
    parsed = parser.parse(envelope);
  } catch (error) {
    const recovered = recoverMessageOnlyResponse(envelope);
    if (recovered) {
      return recovered;
    }
    throw new ProtocolError(`Invalid XML: ${error.message}`, { cause: error });
  }

  const response = parsed.agent_response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new ProtocolError("Missing <agent_response> root.");
  }

  const done = parseDone(response.done);
  const message = scalarText(response.message);
  const rawToolCall = response.tool_call;

  if (Array.isArray(rawToolCall)) {
    throw new ProtocolError("V1 allows at most one <tool_call> per turn.");
  }

  let toolCall = null;
  if (rawToolCall != null && rawToolCall !== "") {
    if (typeof rawToolCall !== "object") {
      throw new ProtocolError("<tool_call> must contain a name and args.");
    }

    const name = String(rawToolCall.name ?? "").trim();
    if (!name) {
      throw new ProtocolError("<tool_call> is missing the name attribute.");
    }

    const normalizedArgs = normalizeXmlValue(
      rawToolCall.args ?? rawToolCall.arguments ?? {},
    );
    toolCall = {
      id: String(rawToolCall.id ?? "").trim() || null,
      name,
      args: typeof normalizedArgs === "string" && !normalizedArgs.trim()
        ? {}
        : normalizedArgs,
    };
  }

  if (done && toolCall) {
    throw new ProtocolError(
      "A completed response cannot also request a tool. Use done=false.",
    );
  }

  return {
    done,
    message,
    toolCall,
    raw: envelope,
  };
}

export function escapeXmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(value) {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function cdata(value) {
  const safe = String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

function optionalResultField(tag, value) {
  if (value == null || value === "") {
    return "";
  }
  return `\n  <${tag}>${cdata(value)}</${tag}>`;
}

export function serializeToolResult(result) {
  const status = result.ok ? "ok" : "error";
  const data = result.data == null
    ? ""
    : typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);

  return [
    `<tool_result name="${escapeXmlAttribute(result.name)}"`,
    ` status="${status}">`,
    `\n  <message>${cdata(result.message ?? "")}</message>`,
    optionalResultField("stdout", result.stdout),
    optionalResultField("stderr", result.stderr),
    optionalResultField("data", data),
    "\n</tool_result>",
  ].join("");
}

export function serializeProtocolError(error) {
  return [
    "<protocol_error>",
    cdata(error.message),
    "</protocol_error>",
  ].join("");
}

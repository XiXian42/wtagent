import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ProtocolError } from "../shared/errors.js";
import {
  truncateUtf8HeadTail,
  utf8ByteLength,
} from "../shared/text-budget.js";

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

function closeDanglingToolCall(envelope) {
  const open = (envelope.match(/<tool_call(?:\s|>)/gi) ?? []).length;
  const close = (envelope.match(/<\/tool_call>/gi) ?? []).length;
  if (open !== close + 1) {
    return envelope;
  }
  return envelope.replace(
    /(<\/args>\s*)(<\/agent_response>\s*)$/i,
    "$1</tool_call>\n$2",
  );
}

function wrapBareToolCall(text) {
  const start = text.search(/<tool_call(?:\s|>)/i);
  const endTag = "</tool_call>";
  const end = start < 0 ? -1 : text.indexOf(endTag, start);
  if (start >= 0 && end >= start) {
    const toolCall = text.slice(start, end + endTag.length);
    if (/<args[\s>/]/i.test(toolCall)) {
      return [
        "<agent_response>",
        "  <done>false</done>",
        "  <message></message>",
        `  ${toolCall}`,
        "</agent_response>",
      ].join("\n");
    }
  }
  return wrapClaudeStyleInvoke(text);
}

// DeepSeek (and some others) occasionally emit Claude-style tool XML:
//   <tool_calls><invoke name="fs.read"><parameter name="path">README.md</parameter></invoke></tool_calls>
// and sometimes annotate parameters with attributes, e.g.
//   <parameter name="program" string="true">npm</parameter>
//   <parameter name="argv" string="false">["test"]</parameter>
// Map a single complete invoke onto our envelope so the turn can proceed
// instead of hanging or burning a format retry.
function wrapClaudeStyleInvoke(text) {
  const invoke = /<invoke\s+name="([A-Za-z0-9_.-]+)"(?:\s[^>]*)?>([\s\S]*?)<\/invoke>/i.exec(text);
  if (!invoke) {
    return null;
  }
  const name = invoke[1];
  const body = invoke[2];
  const args = [];
  const paramRe = /<parameter\s+name="([A-Za-z0-9_.-]+)"(?:\s[^>]*)?>([\s\S]*?)<\/parameter>/gi;
  for (const match of body.matchAll(paramRe)) {
    const key = match[1];
    const value = String(match[2] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      return null;
    }
    args.push(`<${key}>${value}</${key}>`);
  }
  if (args.length === 0) {
    return null;
  }
  return [
    "<agent_response>",
    "  <done>false</done>",
    "  <message></message>",
    `  <tool_call name="${name}">`,
    `    <args>${args.join("")}</args>`,
    "  </tool_call>",
    "</agent_response>",
  ].join("\n");
}

function extractEnvelope(text) {
  const cleaned = stripSingleCodeFence(text);
  const start = cleaned.indexOf("<agent_response");
  const endTag = "</agent_response>";
  const end = start < 0 ? -1 : cleaned.indexOf(endTag, start);

  if (start < 0 || end < 0) {
    const wrapped = wrapBareToolCall(cleaned);
    if (wrapped) {
      return wrapped;
    }
    throw new ProtocolError(
      "Response must contain one complete <agent_response> envelope.",
      { details: { raw: cleaned } },
    );
  }

  // Take the first complete envelope only. Web UIs (especially Kimi) often
  // render the same reply twice — a code-fence copy plus the visible markdown
  // — so first-open + last-close would glue two envelopes together and fail
  // with "Extra text at the end". Trailing chatter after that first envelope
  // is ignored the same way a preamble before it is.
  return cleaned.slice(start, end + endTag.length);
}

// Web-UIs render provider chrome into the assistant text: thinking-block
// headers, code-fence language banners, and code-block action button labels.
// These tokens are UI noise, never model content, but only when they appear as
// standalone leading lines — a report may legitimately contain the word "运行"
// inside its prose, so we only strip complete noise lines at the start.
const UI_NOISE_TOKENS = new Set([
  // 中文
  "思考过程",
  "正在思考",
  "思考已完成",
  "思考完成",
  "跳过",
  "复制",
  "复制代码",
  "下载",
  "运行",
  // English
  "thinking",
  "thinking process",
  "reasoning",
  "skip",
  "copy",
  "copy code",
  "download",
  "run",
  // 日本語
  "考え中",
  "検討中",
  "スキップ",
  "コピー",
  "コードをコピー",
  "ダウンロード",
  "実行",
  // 한국어
  "생각 중",
  "복사",
  "코드 복사",
  "다운로드",
  "실행",
  "건너뛰기",
  // Language banner on rendered code blocks (locale-independent).
  "xml",
]);

export function stripUiNoiseLines(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim());
  while (
    lines.length
    && (
      lines[0] === ""
      || UI_NOISE_TOKENS.has(lines[0])
      || UI_NOISE_TOKENS.has(lines[0].toLowerCase())
    )
  ) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

// Returns the substantive prose that follows the first complete
// <agent_response> envelope, or null when there is none.
//
// Some models (GLM especially) put their REAL deliverable after the envelope:
// the XML carries only a short done/true stub and the full answer is rendered
// as ordinary markdown/HTML text right after it. That text is pure display
// content — it can never trigger a tool call — so the runtime may surface it
// as the final answer instead of dropping it.
//
// Defensive rule: if the trailing text contains another <agent_response (some
// UIs render the reply twice, a code-fence copy plus the visible copy), we
// cannot cleanly separate real content from the duplicated XML, so return null
// and let the caller keep the envelope's own message.
export function extractTrailingProse(rawText) {
  const text = String(rawText ?? "");
  const endTag = "</agent_response>";
  const end = text.indexOf(endTag);
  if (end < 0) {
    return null;
  }
  const trailing = text.slice(end + endTag.length);
  if (trailing.includes("<agent_response")) {
    return null;
  }
  const withoutFenceCloser = trailing.replace(/\n*```\s*$/, "");
  return stripUiNoiseLines(withoutFenceCloser) || null;
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

  // Repair the most common, meaning-preserving corruptions before validation:
  // 1. bare ampersands the model wrote outside CDATA
  // 2. a missing </tool_call> immediately before </agent_response>
  // GLM in particular often streams a complete <tool_call>…</args> and then
  // closes the envelope without the matching </tool_call>. Inserting that one
  // tag is safe: we never invent arguments, only finish an already-complete call.
  const envelope = closeDanglingToolCall(escapeBareAmpersands(rawEnvelope));

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

function optionalResultField(tag, field) {
  if (field == null || (field.text === "" && !field.truncated)) {
    return "";
  }
  const attributes = field.truncated
    ? ` truncated="true" original_bytes="${field.originalBytes}" included_bytes="${field.includedBytes}"`
    : "";
  return `\n  <${tag}${attributes}>${cdata(field.text)}</${tag}>`;
}

function normalizeResultFields(result) {
  const data = result.data == null
    ? ""
    : typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);
  const field = (value) => {
    const text = String(value ?? "");
    const bytes = utf8ByteLength(text);
    return {
      text,
      truncated: false,
      originalBytes: bytes,
      includedBytes: bytes,
    };
  };
  return {
    message: field(result.message),
    stdout: field(result.stdout),
    stderr: field(result.stderr),
    data: field(data),
  };
}

function serializeResultFields(result, fields, { originalBytes = null } = {}) {
  const status = result.ok ? "ok" : "error";
  const wasTruncated = Object.values(fields).some((field) => field.truncated);
  const truncationAttributes = wasTruncated
    ? ` truncated="true" original_bytes="${originalBytes}"`
    : "";

  return [
    `<tool_result name="${escapeXmlAttribute(result.name)}"`,
    ` status="${status}"${truncationAttributes}>`,
    `\n  <message>${cdata(fields.message.text)}</message>`,
    optionalResultField("stdout", fields.stdout),
    optionalResultField("stderr", fields.stderr),
    optionalResultField("data", fields.data),
    "\n</tool_result>",
  ].join("");
}

export function serializeToolResult(result, { maxBytes = Infinity } = {}) {
  const fields = normalizeResultFields(result);
  let xml = serializeResultFields(result, fields);
  if (!Number.isFinite(maxBytes) || utf8ByteLength(xml) <= maxBytes) {
    return xml;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
    throw new RangeError("Tool result XML budget must be at least 512 bytes.");
  }

  const originalBytes = utf8ByteLength(xml);
  let remaining = Math.max(0, maxBytes - 1024);
  for (const [name, fieldLimit] of [
    ["message", 2 * 1024],
    ["stderr", 4 * 1024],
    ["stdout", 4 * 1024],
    ["data", Infinity],
  ]) {
    const field = fields[name];
    const budget = Math.min(field.originalBytes, fieldLimit, remaining);
    fields[name] = truncateUtf8HeadTail(field.text, budget);
    remaining -= fields[name].includedBytes;
  }

  xml = serializeResultFields(result, fields, { originalBytes });
  for (let pass = 0; pass < 8 && utf8ByteLength(xml) > maxBytes; pass += 1) {
    const excess = utf8ByteLength(xml) - maxBytes;
    const candidate = Object.entries(fields)
      .filter(([, field]) => field.includedBytes > 0)
      .sort((left, right) => right[1].includedBytes - left[1].includedBytes)[0];
    if (!candidate) break;
    const [name, field] = candidate;
    const nextBudget = Math.max(0, field.includedBytes - excess - 64);
    fields[name] = truncateUtf8HeadTail(
      normalizeResultFields(result)[name].text,
      nextBudget,
    );
    xml = serializeResultFields(result, fields, { originalBytes });
  }

  if (utf8ByteLength(xml) > maxBytes) {
    throw new RangeError(`Unable to fit tool result within ${maxBytes} bytes.`);
  }
  return xml;
}

export function serializeProtocolError(error) {
  // Structural XML failures need more than the raw parser message. The two
  // recurring causes: (a) raw code placed directly inside the envelope — bare
  // < or & outside CDATA is illegal XML (the parser reports things like
  // "Invalid space after '<'"); (b) a reply cut off before </agent_response>,
  // so nothing in it was executed. Tell the model exactly how to fix both.
  const message = String(error?.message ?? "");
  const structural = /complete <agent_response> envelope|closing tag|invalid xml|space after '<'/i.test(message);
  const guidance = structural
    ? cdata(
      "Wrap ALL code and file content in CDATA (<![CDATA[...]]>) inside "
        + "<content>, <new_text>, or <message>. Never put raw code directly "
        + "inside the envelope: XML forbids a bare < or & in text. Split large "
        + "changes into SMALL fs.edit calls (each new_text at most ~30 lines) "
        + "and close the envelope with </agent_response> immediately after "
        + "the last tool_call. Never leave the envelope open.",
    )
    : "";
  return [
    "<protocol_error>",
    cdata(message),
    guidance,
    "</protocol_error>",
  ].join("");
}

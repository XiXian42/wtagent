// Locate transport tags without mistaking quoted attributes, comments, or
// CDATA payloads for markup. This is a boundary scanner, not an XML validator.
// Malformed markup is still passed to the strict protocol parser.
export function* xmlTags(value) {
  const text = String(value ?? "");
  let index = 0;
  while ((index = text.indexOf("<", index)) >= 0) {
    const start = index;
    const special = text.startsWith("<![CDATA[", index)
      ? [9, "]]>"]
      : text.startsWith("<!--", index)
        ? [4, "-->"]
        : text.startsWith("<?", index) ? [2, "?>"] : null;
    if (special) {
      const end = text.indexOf(special[1], index + special[0]);
      if (end < 0) return;
      index = end + special[1].length;
      continue;
    }
    const match = /^<(\/)?([A-Za-z_][\w:.-]*)(?=[\s/>])/.exec(text.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    index += match[0].length;
    let quote = null;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "<" || character === ">") {
        break;
      }
    }
    // Keep an unfinished opening tag visible to the boundary finder; otherwise
    // a tool inside a malformed outer root could be mistaken for a bare call.
    if (index >= text.length || text[index] === "<") {
      yield { name: match[2], closing: Boolean(match[1]), selfClosing: false, start, end: null };
      if (index >= text.length) return;
      continue;
    }
    index += 1;
    yield {
      name: match[2],
      closing: Boolean(match[1]),
      selfClosing: /\/\s*>$/.test(text.slice(start, index)),
      start,
      end: index,
    };
  }
}

export function findXmlElement(text, name = "agent_response") {
  let start = null;
  let depth = 0;
  for (const tag of xmlTags(text)) {
    if (tag.name !== name) continue;
    if (start == null) {
      if (tag.closing) continue;
      start = tag.start;
    }
    if (tag.end == null) return { start, end: null };
    if (tag.closing) depth -= 1;
    else if (!tag.selfClosing) depth += 1;
    if (depth === 0) return { start, end: tag.end };
  }
  return start == null ? null : { start, end: null };
}

export function hasCompleteAgentEnvelope(text) {
  return findXmlElement(text)?.end != null;
}

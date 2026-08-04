export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export function utf8PrefixBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return buffer;
  }

  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

export function utf8SuffixBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return buffer;
  }

  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start);
}

export function utf8Prefix(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative integer.");
  }
  return utf8PrefixBuffer(Buffer.from(String(value ?? ""), "utf8"), maxBytes)
    .toString("utf8");
}

export function utf8Suffix(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative integer.");
  }
  return utf8SuffixBuffer(Buffer.from(String(value ?? ""), "utf8"), maxBytes)
    .toString("utf8");
}

export function truncateUtf8HeadTail(value, maxBytes, { headRatio = 0.25 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative integer.");
  }
  if (!(headRatio >= 0 && headRatio <= 1)) {
    throw new TypeError("headRatio must be between 0 and 1.");
  }

  const original = Buffer.from(String(value ?? ""), "utf8");
  if (original.length <= maxBytes) {
    return {
      text: original.toString("utf8"),
      truncated: false,
      originalBytes: original.length,
      includedBytes: original.length,
      omittedBytes: 0,
    };
  }
  if (maxBytes === 0) {
    return {
      text: "",
      truncated: true,
      originalBytes: original.length,
      includedBytes: 0,
      omittedBytes: original.length,
    };
  }

  let marker = "\n[WTAgent output truncated]\n";
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);

  // The omitted byte count changes the marker length. A few passes are enough
  // to make the field fit exactly while keeping UTF-8 code points intact.
  for (let pass = 0; pass < 4; pass += 1) {
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= maxBytes) {
      const text = utf8Prefix(marker, maxBytes);
      return {
        text,
        truncated: true,
        originalBytes: original.length,
        includedBytes: utf8ByteLength(text),
        omittedBytes: original.length,
      };
    }

    const contentBudget = maxBytes - markerBytes;
    const headBudget = Math.floor(contentBudget * headRatio);
    const tailBudget = contentBudget - headBudget;
    head = utf8PrefixBuffer(original, headBudget);
    tail = utf8SuffixBuffer(original, tailBudget);
    const omittedBytes = Math.max(0, original.length - head.length - tail.length);
    marker = `\n[WTAgent omitted ${omittedBytes} bytes]\n`;
  }

  let text = `${head.toString("utf8")}${marker}${tail.toString("utf8")}`;
  if (utf8ByteLength(text) > maxBytes) {
    text = utf8Prefix(text, maxBytes);
  }
  return {
    text,
    truncated: true,
    originalBytes: original.length,
    includedBytes: utf8ByteLength(text),
    omittedBytes: Math.max(0, original.length - head.length - tail.length),
  };
}

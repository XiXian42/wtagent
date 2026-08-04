// Parses `@file` mentions from an interactive message so the CLI can attach the
// referenced files to the ChatGPT web composer.
//
// Supported forms:
//   @path/to/file.txt          bare path (stops at whitespace)
//   @/abs/path/to/file.jpeg    absolute path
//   @"my file.pdf"             double-quoted path (may contain spaces)
//   @'my file.pdf'             single-quoted path
//
// A bare `@` not followed by a path-like character (e.g. an email local part
// like "foo@bar.com", or "@" alone) is left untouched.
//
// Attachments are NOT bounded to the project root: this is a web upload to the
// user's own ChatGPT session (not a local tool read), so the user may attach
// any file they can point at — an absolute path outside the project is valid.
// A relative path is resolved against the project root for convenience.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A mention is `@` that is at the start of the string or preceded by
// whitespace, followed by either a quoted path or a bare path token.
const MENTION = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g;

// Extracts @mentions and resolves them to existing files.
// Returns:
//   mentions: [{ raw, requested }]           every syntactic @token found
//   files:    [{ name, path, requested }]    resolved, existing files (any location)
//   missing:  [{ requested, reason }]        tokens that did not resolve to a file
export async function extractAtMentions(text, projectRoot) {
  const source = String(text ?? "");
  const mentions = [];
  for (const match of source.matchAll(MENTION)) {
    const requested = match[2] ?? match[3] ?? match[4] ?? "";
    if (requested) {
      mentions.push({ raw: `@${match[2] != null || match[3] != null ? `"${requested}"` : requested}`, requested });
    }
  }

  const files = [];
  const missing = [];
  const seen = new Set();
  for (const mention of mentions) {
    if (seen.has(mention.requested)) {
      continue;
    }
    seen.add(mention.requested);

    // Absolute paths are used as-is; relative paths resolve against the project
    // root. `~` is expanded to the user's home directory for convenience.
    // Backslashes are normalized to the platform separator so Windows-style
    // paths (src\\main.js) work on POSIX hosts too.
    const expanded = expandHome(mention.requested).replaceAll("\\", path.sep);
    const absPath = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(projectRoot, expanded);

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      missing.push({ requested: mention.requested, reason: "not-found" });
      continue;
    }
    if (!stat.isFile()) {
      missing.push({ requested: mention.requested, reason: "not-a-file" });
      continue;
    }

    files.push({
      name: basename(absPath),
      path: absPath,
      requested: mention.requested,
    });
  }

  return { mentions, files, missing };
}

function expandHome(rawPath) {
  const value = String(rawPath ?? "");
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function basename(filePath) {
  const parts = String(filePath).split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

import fs from "node:fs/promises";
import path from "node:path";

// Windows device / reserved names that cannot be used as file or directory
// names, even with an extension (e.g. CON.txt). See
// https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// Characters that are never legal in a Windows file name.
const WINDOWS_ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

// Returns the trailing path component (the file or directory name that the
// path refers to), stripping any trailing separator.
function leafName(candidatePath) {
  const normalized = String(candidatePath ?? "").replace(/[\\/]+$/, "");
  const lastSep = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return lastSep >= 0 ? normalized.slice(lastSep + 1) : normalized;
}

// Validates that a path's leaf name is legal on Windows. On non-Windows
// platforms this is a no-op so POSIX-only names remain usable.
export function assertWindowsSafeName(candidatePath) {
  if (process.platform !== "win32") {
    return;
  }
  const leaf = leafName(candidatePath);
  if (!leaf) {
    return;
  }
  // Strip the extension before checking reserved names: CON, CON.txt,
  // CON.anything are all reserved.
  const dot = leaf.indexOf(".");
  const base = dot >= 0 ? leaf.slice(0, dot) : leaf;
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    throw new Error(
      `Path uses a reserved Windows device name: ${leaf}`,
    );
  }
  if (WINDOWS_ILLEGAL_CHARS.test(leaf)) {
    throw new Error(
      `Path contains characters that are illegal on Windows: ${leaf}`,
    );
  }
  // Trailing space or period is not allowed in Windows file names.
  if (/[ .]$/.test(leaf)) {
    throw new Error(
      `Path ends with a space or period, which is not allowed on Windows: ${leaf}`,
    );
  }
}

export function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidatePath) {
  let current = candidatePath;
  const suffix = [];

  while (true) {
    try {
      await fs.lstat(current);
      return { ancestor: current, suffix: suffix.reverse() };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing ancestor found for path: ${candidatePath}`);
    }
    suffix.push(path.basename(current));
    current = parent;
  }
}

export async function resolveToolPath(projectRoot, rawPath) {
  const root = await fs.realpath(path.resolve(projectRoot));
  const requested = String(rawPath ?? "").trim();
  if (!requested) {
    throw new Error("Path cannot be empty.");
  }

  assertWindowsSafeName(requested);

  const lexical = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);

  const { ancestor, suffix } = await nearestExistingAncestor(lexical);
  const realAncestor = await fs.realpath(ancestor);
  const resolved = path.join(realAncestor, ...suffix);

  return {
    root,
    requested,
    path: resolved,
    inside: isPathInside(root, resolved),
  };
}


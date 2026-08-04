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

function splitWindowsComponents(candidatePath) {
  let normalized = String(candidatePath ?? "").replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) {
    normalized = normalized.replace(/^\\+/, "");
    const uncParts = normalized.split("\\");
    normalized = uncParts.slice(2).join("\\");
  } else if (/^[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(2);
  }

  return normalized
    .split("\\")
    .filter((component) => component && component !== "." && component !== "..");
}

// Validates that a path's leaf name is legal on Windows. On non-Windows
// platforms this is a no-op so POSIX-only names remain usable.
export function assertWindowsSafeName(candidatePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return;
  }
  const components = splitWindowsComponents(candidatePath);
  for (const leaf of components) {
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
}

export function isPathInside(rootPath, candidatePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const normalize = (value) => {
      const resolved = path.win32.resolve(String(value ?? ""))
        .replace(/\//g, "\\");
      if (/^[a-z]:\\$/i.test(resolved)) {
        return resolved.toLowerCase();
      }
      return resolved.replace(/\\+$/, "").toLowerCase();
    };
    const root = normalize(rootPath);
    const candidate = normalize(candidatePath);
    return candidate === root || candidate.startsWith(`${root}\\`);
  }
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

export async function resolveToolPath(projectRoot, rawPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const root = await fs.realpath(path.resolve(projectRoot));
  const requested = String(rawPath ?? "").trim();
  if (!requested) {
    throw new Error("Path cannot be empty.");
  }

  assertWindowsSafeName(requested, { platform });

  const lexical = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);

  const { ancestor, suffix } = await nearestExistingAncestor(lexical);
  for (const component of suffix) {
    assertWindowsSafeName(component, { platform });
  }
  const realAncestor = await fs.realpath(ancestor);
  const resolved = path.join(realAncestor, ...suffix);

  return {
    root,
    requested,
    path: resolved,
    inside: isPathInside(root, resolved, { platform }),
  };
}

// Re-resolve the destination immediately before a write. A directory that was
// inside the project when policy was evaluated can be replaced by a symlink or
// Windows junction before the tool reaches the filesystem. Resolve the parent
// again, reject a newly introduced target symlink, and return the current
// canonical destination so callers do not keep using the stale lexical path.
export async function resolveCanonicalWriteTarget(
  projectRoot,
  targetPath,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const allowOutside = options.allowOutside === true;
  const root = await fs.realpath(path.resolve(projectRoot));
  const lexicalTarget = path.resolve(String(targetPath ?? ""));
  const parent = await fs.realpath(path.dirname(lexicalTarget));
  const canonicalTarget = path.join(parent, path.basename(lexicalTarget));

  if (!allowOutside && !isPathInside(root, canonicalTarget, { platform })) {
    throw new Error(
      `Write target moved outside project root: ${canonicalTarget}`,
    );
  }

  try {
    const stat = await fs.lstat(canonicalTarget);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through a symbolic link: ${canonicalTarget}`,
      );
    }
    const realTarget = await fs.realpath(canonicalTarget);
    if (!allowOutside && !isPathInside(root, realTarget, { platform })) {
      throw new Error(
        `Write target moved outside project root: ${realTarget}`,
      );
    }
    return realTarget;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return canonicalTarget;
  }
}

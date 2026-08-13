import fs from "node:fs/promises";
import path from "node:path";
import { utf8PrefixBuffer } from "../shared/text-budget.js";

export const DEFAULT_SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
const MAX_MATCH_LINE_BYTES = 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function normalizeGlobPath(targetPath) {
  return targetPath.split(path.sep).join("/");
}

function escapeRegex(source) {
  return source.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 1;
        } else {
          expression += ".*";
        }
        index += 1;
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      expression += "[^/]";
      continue;
    }
    expression += escapeRegex(char);
  }
  expression += "$";
  return new RegExp(expression, "u");
}

function buildMatcher({ query, regex }) {
  if (regex) {
    return {
      type: "regex",
      pattern: new RegExp(query, "u"),
    };
  }
  return { type: "fixed", query };
}

function createGlobMatcher(glob) {
  if (!glob) {
    return () => true;
  }
  const normalizedGlob = normalizeGlobPath(glob);
  const pattern = globToRegExp(normalizedGlob);
  const basenameOnly = !normalizedGlob.includes("/");
  return (candidatePath) => {
    const normalizedCandidate = normalizeGlobPath(candidatePath);
    return pattern.test(
      basenameOnly
        ? path.posix.basename(normalizedCandidate)
        : normalizedCandidate,
    );
  };
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function safeLineSnippet(line) {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= MAX_MATCH_LINE_BYTES) {
    return line;
  }
  return `${utf8PrefixBuffer(buffer, MAX_MATCH_LINE_BYTES).toString("utf8")} …`;
}

// Returns true when a path is excluded: either its basename is in the default
// excluded set (.git, node_modules, ...) or it matches one of the caller's
// exclude patterns. For directories, a trailing `/**` pattern (e.g. `dist/**`)
// must also prune the directory itself, otherwise the walk descends into the
// excluded subtree; testing `${relative}/x` simulates "something below".
function isExcludedPath(currentPath, state, isDir) {
  if (state.excludedDirs.has(path.basename(currentPath))) {
    return true;
  }
  if (state.excludeMatchers.length === 0) {
    return false;
  }
  const relative = path.relative(state.rootPath, currentPath);
  for (const matcher of state.excludeMatchers) {
    if (matcher(relative) || (isDir && matcher(`${relative}/x`))) {
      return true;
    }
  }
  return false;
}

function collectLineMatches(content, matcher, filePath, maxResults, results) {
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (results.length >= maxResults) {
      return;
    }
    const line = lines[index];
    const matched = matcher.type === "regex"
      ? matcher.pattern.test(line)
      : line.includes(matcher.query);
    matcher.pattern?.lastIndex && (matcher.pattern.lastIndex = 0);
    if (!matched) {
      continue;
    }
    results.push(`${filePath}:${index + 1}:${safeLineSnippet(line)}`);
  }
}

async function walkSearchTree(currentPath, state) {
  if (state.results.length >= state.maxResults) {
    return;
  }

  const stat = await fs.lstat(currentPath);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    if (isExcludedPath(currentPath, state, true)) {
      return;
    }
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      await walkSearchTree(path.join(currentPath, child.name), state);
      if (state.results.length >= state.maxResults) {
        return;
      }
    }
    return;
  }
  if (!stat.isFile() || stat.size > state.maxFileBytes) {
    return;
  }

  const relativePath = path.relative(state.rootPath, currentPath) || path.basename(currentPath);
  if (!state.globMatcher(relativePath) || isExcludedPath(currentPath, state, false)) {
    return;
  }

  const buffer = await fs.readFile(currentPath).catch(() => null);
  if (buffer == null || isBinaryBuffer(buffer)) {
    return;
  }

  let content;
  try {
    content = textDecoder.decode(buffer);
  } catch {
    return;
  }

  collectLineMatches(
    content,
    state.matcher,
    currentPath,
    state.maxResults,
    state.results,
  );
}

export async function fallbackSearch({
  query,
  searchPath,
  glob,
  regex,
  maxResults,
  excludedDirs = DEFAULT_SEARCH_EXCLUDED_DIRS,
  excludePatterns = [],
  maxFileBytes = MAX_FALLBACK_FILE_BYTES,
}) {
  const matcher = buildMatcher({ query, regex });
  const results = [];
  const rootPath = path.resolve(searchPath);
  await walkSearchTree(rootPath, {
    excludedDirs,
    excludeMatchers: excludePatterns
      .filter(Boolean)
      .map((pattern) => createGlobMatcher(pattern)),
    globMatcher: createGlobMatcher(glob),
    matcher,
    maxFileBytes,
    maxResults,
    results,
    rootPath,
  });
  return results.join("\n");
}

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { DEFAULT_LIMITS } from "../shared/limits.js";
import { resolveToolPath } from "../policy/path-guard.js";
import { ToolRegistry } from "./registry.js";
import { runProgram } from "./terminal-exec.js";

const xmlBoolean = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const xmlStringArray = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through and treat the value as one argument.
    }
  }
  return [value];
}, z.array(z.string()));

function requireAllowedPath(info, context) {
  if (!info.inside && !context.allowOutside) {
    throw new Error(`Path is outside project root: ${info.path}`);
  }
  return info.path;
}

async function resolveAllowedPath(rawPath, context) {
  const info = await resolveToolPath(context.projectRoot, rawPath);
  return requireAllowedPath(info, context);
}

function displayPath(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return relative && !relative.startsWith("..") ? relative : targetPath;
}

// On Windows files commonly use CRLF line endings, while the model may
// supply old_text with LF endings (or vice versa). We try the exact text
// first, then the opposite line-ending convention so edits still match
// without silently rewriting every line ending in the file.
function matchOldText(content, oldText) {
  if (content.includes(oldText)) {
    return oldText;
  }
  const fileUsesCRLF = content.includes("\r\n");
  if (fileUsesCRLF) {
    const crlfVersion = oldText.replace(/\n/g, "\r\n");
    if (content.includes(crlfVersion)) {
      return crlfVersion;
    }
  } else {
    const lfVersion = oldText.replace(/\r\n/g, "\n");
    if (content.includes(lfVersion)) {
      return lfVersion;
    }
  }
  return null;
}

async function writeTextAtomic(targetPath, content) {
  const temporary = `${targetPath}.wtagent-${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  try {
    await fs.rename(temporary, targetPath);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
    await fs.rm(targetPath, { force: true });
    await fs.rename(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => null);
  }
}

async function listTree(root, target, options) {
  const entries = [];
  const excluded = new Set([".git", "node_modules", "dist", "build", "coverage"]);

  async function walk(directory, depth) {
    if (entries.length >= options.maxEntries) {
      return;
    }
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      if (entries.length >= options.maxEntries) {
        break;
      }
      if (!options.includeHidden && child.name.startsWith(".")) {
        continue;
      }
      if (excluded.has(child.name)) {
        continue;
      }

      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      entries.push({
        path: relative || ".",
        type: child.isDirectory()
          ? "directory"
          : child.isSymbolicLink()
            ? "symlink"
            : "file",
      });

      if (child.isDirectory() && depth < options.depth) {
        await walk(absolute, depth + 1);
      }
    }
  }

  await walk(target, 0);
  return entries;
}

async function rgSearch({ query, searchPath, glob, regex, maxResults }) {
  const argv = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
  ];
  if (!regex) {
    argv.push("--fixed-strings");
  }
  if (glob) {
    argv.push("--glob", glob);
  }
  argv.push("--", query, searchPath);

  return await new Promise((resolve, reject) => {
    const child = spawn("rg", argv, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || code === 1) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr || `rg exited with ${code}`));
      }
    });
  });
}

async function fallbackSearch({ query, searchPath, maxResults }) {
  const results = [];
  const excluded = new Set([".git", "node_modules", "dist", "build", "coverage"]);

  async function visit(current) {
    if (results.length >= maxResults) return;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (excluded.has(path.basename(current))) return;
      const children = await fs.readdir(current);
      for (const child of children) {
        await visit(path.join(current, child));
        if (results.length >= maxResults) return;
      }
      return;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) return;

    const content = await fs.readFile(current, "utf8").catch(() => null);
    if (content == null) return;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.includes(query)) {
        results.push(`${current}:${index + 1}:${line}`);
        if (results.length >= maxResults) return;
      }
    }
  }

  await visit(searchPath);
  return results.join("\n");
}

export function createDefaultToolRegistry({
  processManager,
  limits = DEFAULT_LIMITS,
} = {}) {
  const registry = new ToolRegistry();

  registry.register({
    name: "fs.list",
    description: "List files and directories in the project.",
    inputDescription:
      "<args><path>.</path><depth>2</depth><include_hidden>false</include_hidden></args>",
    risk: "read",
    inputSchema: z.object({
      path: z.string().default("."),
      depth: z.coerce.number().int().min(0).max(5).default(2),
      include_hidden: xmlBoolean.default(false),
    }),
    execute: async (args, context) => {
      const target = await resolveAllowedPath(args.path, context);
      const entries = await listTree(
        path.resolve(context.projectRoot),
        target,
        {
          depth: args.depth,
          includeHidden: args.include_hidden,
          maxEntries: limits.maxDirectoryEntries,
        },
      );
      return {
        ok: true,
        message: `Listed ${entries.length} entries.`,
        data: {
          entries,
          truncated: entries.length >= limits.maxDirectoryEntries,
        },
      };
    },
  });

  registry.register({
    name: "fs.read",
    description: "Read a text file in the project, optionally limiting the start byte and length.",
    inputDescription:
      "<args><path>src/main.js</path><offset>0</offset><max_bytes>131072</max_bytes></args>",
    risk: "read",
    inputSchema: z.object({
      path: z.string().min(1),
      offset: z.coerce.number().int().min(0).default(0),
      max_bytes: z.coerce.number().int().min(1)
        .max(1024 * 1024)
        .default(limits.maxFileReadBytes),
    }),
    execute: async (args, context) => {
      const target = await resolveAllowedPath(args.path, context);
      const handle = await fs.open(target, "r");
      try {
        const stat = await handle.stat();
        const buffer = Buffer.alloc(args.max_bytes);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          args.max_bytes,
          args.offset,
        );
        return {
          ok: true,
          message: `Read ${displayPath(context.projectRoot, target)}.`,
          data: {
            content: buffer.subarray(0, bytesRead).toString("utf8"),
            bytesRead,
            nextOffset: args.offset + bytesRead,
            truncated: args.offset + bytesRead < stat.size,
            size: stat.size,
          },
        };
      } finally {
        await handle.close();
      }
    },
  });

  registry.register({
    name: "fs.write",
    description: "Create, overwrite, or append to a text file in the project.",
    inputDescription:
      "<args><path>src/main.js</path><content><![CDATA[...]]></content><mode>overwrite|append</mode></args>",
    risk: "write",
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      mode: z.enum(["overwrite", "append"]).default("overwrite"),
    }),
    execute: async (args, context) => {
      const target = await resolveAllowedPath(args.path, context);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (args.mode === "append") {
        await fs.appendFile(target, args.content, "utf8");
      } else {
        await writeTextAtomic(target, args.content);
      }
      return {
        ok: true,
        message: `Wrote ${displayPath(context.projectRoot, target)}.`,
        data: { bytes: Buffer.byteLength(args.content, "utf8") },
      };
    },
  });

  registry.register({
    name: "fs.edit",
    description: "Perform atomic exact text replacements on an existing file.",
    inputDescription:
      "<args><path>src/main.js</path><edits><item><old_text><![CDATA[...]]></old_text><new_text><![CDATA[...]]></new_text><replace_all>false</replace_all></item></edits></args>",
    risk: "write",
    inputSchema: z.object({
      path: z.string().min(1),
      edits: z.array(z.object({
        old_text: z.string(),
        new_text: z.string(),
        replace_all: xmlBoolean.default(false),
      })).min(1),
    }),
    execute: async (args, context) => {
      const target = await resolveAllowedPath(args.path, context);
      const original = await fs.readFile(target, "utf8");
      let next = original;

      for (const [index, edit] of args.edits.entries()) {
        if (edit.old_text === edit.new_text) {
          throw new Error(`Edit ${index + 1} does not change the file.`);
        }
        const matchedOld = matchOldText(next, edit.old_text);
        if (matchedOld === null) {
          throw new Error(`Edit ${index + 1} old_text was not found.`);
        }
        const occurrences = next.split(matchedOld).length - 1;
        if (!edit.replace_all && occurrences !== 1) {
          throw new Error(
            `Edit ${index + 1} matched ${occurrences} times; make it unique or set replace_all.`,
          );
        }
        next = edit.replace_all
          ? next.split(matchedOld).join(edit.new_text)
          : next.replace(matchedOld, edit.new_text);
      }

      await writeTextAtomic(target, next);
      return {
        ok: true,
        message: `Edited ${displayPath(context.projectRoot, target)}.`,
        data: { editsApplied: args.edits.length },
      };
    },
  });

  registry.register({
    name: "fs.search",
    description: "Search project files for text, preferring ripgrep.",
    inputDescription:
      "<args><query>search text</query><path>.</path><glob>*.js</glob><regex>false</regex><max_results>200</max_results></args>",
    risk: "read",
    inputSchema: z.object({
      query: z.string().min(1),
      path: z.string().default("."),
      glob: z.string().optional(),
      regex: xmlBoolean.default(false),
      max_results: z.coerce.number().int().min(1)
        .max(1000)
        .default(limits.maxSearchResults),
    }),
    execute: async (args, context) => {
      const target = await resolveAllowedPath(args.path, context);
      let output;
      let engine = "rg";
      try {
        const result = await rgSearch({
          query: args.query,
          searchPath: target,
          glob: args.glob,
          regex: args.regex,
          maxResults: args.max_results,
        });
        output = result.stdout;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        engine = "javascript";
        if (args.regex) {
          throw new Error("Regex fallback requires ripgrep to be installed.");
        }
        output = await fallbackSearch({
          query: args.query,
          searchPath: target,
          maxResults: args.max_results,
        });
      }
      return {
        ok: true,
        message: output ? "Search completed." : "No matches.",
        data: { engine, matches: output },
      };
    },
  });

  const executionSchema = z.object({
    program: z.string().min(1),
    argv: xmlStringArray.default([]),
    cwd: z.string().default("."),
    timeout_ms: z.coerce.number().int().min(100).max(30 * 60_000)
      .default(limits.toolTimeoutMs),
    inherit_sensitive_env: xmlBoolean.default(false),
  });

  registry.register({
    name: "terminal.exec",
    description: "Run a program that terminates. Use program + argv, not a shell string.",
    inputDescription:
      "<args><program>npm</program><argv><item>run</item><item>build</item></argv><cwd>.</cwd><timeout_ms>120000</timeout_ms></args>",
    risk: "execute",
    managesTimeout: true,
    inputSchema: executionSchema,
    execute: async (args, context) => {
      const cwd = await resolveAllowedPath(args.cwd, context);
      const timeoutMs = Math.min(args.timeout_ms, limits.toolTimeoutMs);
      const result = await runProgram({
        program: args.program,
        argv: args.argv,
        cwd,
        timeoutMs,
        maxOutputBytes: limits.maxToolOutputBytes,
        inheritSensitiveEnv: args.inherit_sensitive_env,
        onOutput: context.onToolOutput,
      });
      return {
        ok: result.ok,
        message: result.completionUnknown
          ? (
            `Command exceeded the ${timeoutMs}ms limit and did not exit `
            + "within the termination grace period. Completion is unknown."
          )
          : result.timedOut
            ? `Command timed out after ${timeoutMs}ms.`
            : `Command exited with ${result.exitCode}.`,
        stdout: result.stdout,
        stderr: result.stderr || result.error?.message,
        data: {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
        },
        meta: result.completionUnknown
          ? {
            timedOut: true,
            completionUnknown: true,
            recoverable: true,
          }
          : undefined,
      };
    },
  });

  if (processManager) {
    registry.register({
      name: "process.start",
      description: "Start a long-running process such as a dev server; returns a process_id immediately.",
      inputDescription:
        "<args><program>npm</program><argv><item>run</item><item>dev</item></argv><cwd>.</cwd></args>",
      risk: "execute",
      inputSchema: z.object({
        program: z.string().min(1),
        argv: xmlStringArray.default([]),
        cwd: z.string().default("."),
        inherit_sensitive_env: xmlBoolean.default(false),
      }),
      execute: async (args, context) => {
        const cwd = await resolveAllowedPath(args.cwd, context);
        const snapshot = processManager.start({
          program: args.program,
          argv: args.argv,
          cwd,
          inheritSensitiveEnv: args.inherit_sensitive_env,
        });
        return {
          ok: true,
          message: `Started ${args.program} as ${snapshot.processId}.`,
          data: snapshot,
        };
      },
    });

    registry.register({
      name: "process.read",
      description: "Read the status and logs of a long-running process started by this task.",
      inputDescription: "<args><process_id>proc_1234</process_id></args>",
      risk: "read",
      inputSchema: z.object({ process_id: z.string().min(1) }),
      execute: async (args) => {
        const snapshot = processManager.read(args.process_id);
        return {
          ok: true,
          message: `Read process ${args.process_id}.`,
          data: snapshot,
        };
      },
    });

    registry.register({
      name: "process.stop",
      description: "Stop a long-running process started by this task.",
      inputDescription: "<args><process_id>proc_1234</process_id></args>",
      risk: "execute",
      inputSchema: z.object({ process_id: z.string().min(1) }),
      execute: async (args) => {
        const snapshot = await processManager.stop(args.process_id);
        return {
          ok: true,
          message: `Stopping process ${args.process_id}.`,
          data: snapshot,
        };
      },
    });

    registry.register({
      name: "process.list",
      description: "List long-running processes started by this task.",
      inputDescription: "<args></args>",
      risk: "read",
      inputSchema: z.object({}),
      execute: async () => ({
        ok: true,
        message: "Listed managed processes.",
        data: { processes: processManager.list() },
      }),
    });
  }

  return registry;
}

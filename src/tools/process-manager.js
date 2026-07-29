import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildToolEnvironment } from "./safe-env.js";
import { killProcessTree } from "./process-utils.js";

const MAX_PROCESS_LOG_BYTES = 1024 * 1024;
const URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?/gi;

function appendBounded(record, stream, chunk) {
  const text = chunk.toString("utf8");
  record[stream] += text;
  if (Buffer.byteLength(record[stream], "utf8") > MAX_PROCESS_LOG_BYTES) {
    record[stream] = record[stream].slice(-MAX_PROCESS_LOG_BYTES);
    record.truncated = true;
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    record.urls.add(match[0]);
  }
}

export class ProcessManager {
  #processes = new Map();

  start({ program, argv, cwd, inheritSensitiveEnv }) {
    const id = `proc_${randomUUID().slice(0, 8)}`;
    const child = spawn(program, argv, {
      cwd,
      env: buildToolEnvironment({ inheritSensitive: inheritSensitiveEnv }),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const record = {
      id,
      child,
      program,
      argv,
      cwd,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      urls: new Set(),
    };
    this.#processes.set(id, record);

    child.stdout.on("data", (chunk) => appendBounded(record, "stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded(record, "stderr", chunk));
    child.once("error", (error) => {
      record.status = "error";
      record.stderr += `\n${error.message}`;
    });
    child.once("close", (code, signal) => {
      record.status = "exited";
      record.exitCode = code;
      record.signal = signal;
    });

    return this.snapshot(record);
  }

  read(id) {
    const record = this.#processes.get(id);
    if (!record) {
      throw new Error(`Unknown process: ${id}`);
    }
    return this.snapshot(record);
  }

  list() {
    return [...this.#processes.values()].map((record) => this.snapshot(record));
  }

  async stop(id) {
    const record = this.#processes.get(id);
    if (!record) {
      throw new Error(`Unknown process: ${id}`);
    }
    if (record.status === "running") {
      await killProcessTree(record.child.pid);
      record.status = "stopping";
    }
    return this.snapshot(record);
  }

  async stopAll() {
    await Promise.all(
      [...this.#processes.keys()].map((id) => this.stop(id).catch(() => null)),
    );
  }

  snapshot(record) {
    return {
      processId: record.id,
      pid: record.child.pid,
      program: record.program,
      argv: record.argv,
      cwd: record.cwd,
      startedAt: record.startedAt,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      stdout: record.stdout,
      stderr: record.stderr,
      truncated: record.truncated,
      detectedUrls: [...record.urls],
    };
  }
}

